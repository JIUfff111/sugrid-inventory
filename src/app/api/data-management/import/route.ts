import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { authErrorResponse, hashPassword, requireSystemAccount } from '@/lib/auth';
import { errorResponse, generateId, formatDateTime, successResponse } from '@/lib/api-helpers';
import db from '@/lib/db';
import { createBackup, getResource, importPayload, normalizeImportRecord, normalizeValue, sanitizeRecord, validateManagedUserMutation, writeAudit, dbIntegrityErrors } from '@/lib/data-management';
import { buildImportReport } from './preview/route';

function insertRecord(resource: ReturnType<typeof getResource>, raw: Record<string, unknown>, actorId: string) {
  if (!resource) throw new Error('数据资源不存在');
  const clean = sanitizeRecord(raw, resource);
  const id = typeof clean.id === 'string' && clean.id.trim() ? clean.id.trim() : generateId(resource.key.replace(/s$/, ''));
  clean.id = id;
  if (resource.key === 'users') {
    clean.isSystemAccount = 0;
    clean.status = 'pending';
  }
  const columns = Object.keys(clean);
  const values = columns.map((key) => normalizeValue(clean[key]));
  if (resource.fields.includes('createdAt') && !columns.includes('createdAt')) { columns.push('createdAt'); values.push(formatDateTime()); }
  if (resource.fields.includes('updatedAt') && !columns.includes('updatedAt')) { columns.push('updatedAt'); values.push(formatDateTime()); }
  if (resource.fields.includes('createdBy') && !columns.includes('createdBy')) { columns.push('createdBy'); values.push(actorId); }
  if (resource.key === 'users') { columns.push('password'); values.push(hashPassword(`pending-${generateId('password')}`)); }
  db.prepare(`INSERT INTO ${resource.table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...values);
  return id;
}

function updateRecord(resource: NonNullable<ReturnType<typeof getResource>>, raw: Record<string, unknown>, id: string, hasIncomingWarehouseAssignment = false) {
  const clean = sanitizeRecord(raw, resource);
  delete clean.id;
  delete clean.isSystemAccount;
  delete clean.username;
  let securityChanged = false;
  if (resource.key === 'users') {
    const current = db.prepare('SELECT id, role, status, isSystemAccount FROM users WHERE id = ?').get(id) as { id: string; role: string; status: string; isSystemAccount: number } | undefined;
    if (!current) throw new Error('用户记录不存在');
    const userErrors = validateManagedUserMutation(clean, current, hasIncomingWarehouseAssignment);
    if (userErrors.length) throw new Error(userErrors.join('；'));
    securityChanged = (clean.role !== undefined && String(clean.role) !== current.role) ||
      (clean.status !== undefined && String(clean.status) !== current.status);
  }
  const fields = Object.keys(clean).filter((field) => resource.writable.includes(field));
  if (resource.fields.includes('updatedAt')) fields.push('updatedAt');
  if (!fields.length) return;
  const values = fields.map((field) => field === 'updatedAt' ? formatDateTime() : normalizeValue(clean[field]));
  db.prepare(`UPDATE ${resource.table} SET ${fields.map((field) => `${field} = ?`).join(', ')} WHERE id = ?`).run(...values, id);
  if (securityChanged) db.prepare('UPDATE sessions SET revokedAt = ? WHERE userId = ? AND revokedAt IS NULL').run(formatDateTime(), id);
}

export async function POST(request: NextRequest) {
  try {
    const actor = await requireSystemAccount();
    const body = await request.json() as { resource?: string; content?: unknown; mode?: 'insert' | 'upsert'; fileName?: string };
    if (body.content === undefined) return NextResponse.json(errorResponse('VALIDATION_ERROR', '导入内容不能为空'), { status: 400 });
    const mode = body.mode === 'upsert' ? 'upsert' : 'insert';
    const resourceKey = body.resource?.trim() || null;
    const reports = await buildImportReport(resourceKey, body.content, mode, actor.id);
    const failed = reports.some((report) => report.errors.length > 0);
    if (failed) return NextResponse.json(errorResponse('VALIDATION_ERROR', '导入预览存在错误，请修正后再提交', { reports }), { status: 400 });
    const backup = await createBackup(actor.id, 'before-import');
    const payload = importPayload(resourceKey, body.content);
    const incomingUserIds = new Set<string>();
    for (const group of payload) {
      if (group.resource !== 'users') continue;
      for (const record of group.records) {
        if (record && typeof record === 'object' && !Array.isArray(record) && typeof (record as Record<string, unknown>).id === 'string') {
          incomingUserIds.add(String((record as Record<string, unknown>).id).trim());
        }
      }
    }
    const incomingIds = new Map<string, Set<string>>([['users', incomingUserIds]]);
    const sourceText = typeof body.content === 'string' ? body.content : JSON.stringify(body.content);
    const fileSha256 = createHash('sha256').update(sourceText, 'utf8').digest('hex');
    const incomingAssignments = new Set<string>();
    for (const group of payload) {
      if (group.resource !== 'user_warehouses') continue;
      for (const record of group.records) {
        if (record && typeof record === 'object' && !Array.isArray(record)) {
          const userId = String((record as Record<string, unknown>).userId || '');
          if (userId) incomingAssignments.add(userId);
        }
      }
    }
    let inserted = 0, updated = 0;
    db.transaction(() => {
      for (const group of payload) {
        const resource = getResource(group.resource);
        if (!resource) throw new Error(`未知资源 ${group.resource}`);
        const report = reports.find(item => item.resource === group.resource);
        const skippedIndexes = new Set(mode === 'insert' ? report?.conflictIndexes || [] : []);
        for (const [index, value] of group.records.entries()) {
          if (skippedIndexes.has(index)) continue;
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('导入记录格式不正确');
          const raw = normalizeImportRecord(resource, value as Record<string, unknown>, actor.id, incomingIds).record;
          const id = typeof raw.id === 'string' ? raw.id.trim() : '';
          if (mode === 'upsert' && id && db.prepare(`SELECT 1 FROM ${resource.table} WHERE id = ?`).get(id)) {
            if (resource.key === 'user_warehouses') {
              const current = db.prepare('SELECT userId, warehouseId FROM user_warehouses WHERE id = ?').get(id) as { userId: string; warehouseId: string } | undefined;
              const userId = String(raw.userId ?? current?.userId ?? '');
              const warehouseId = String(raw.warehouseId ?? current?.warehouseId ?? '');
              if (!userId || !warehouseId) throw new Error('仓库权限缺少用户或仓库');
              const user = db.prepare('SELECT role FROM users WHERE id = ?').get(userId) as { role: string } | undefined;
              const warehouse = db.prepare("SELECT status FROM warehouses WHERE id = ?").get(warehouseId) as { status: string } | undefined;
              if (!user) throw new Error('仓库权限对应用户不存在');
              if (!warehouse || warehouse.status !== 'active') throw new Error('只能给账号分配启用中的仓库');
              if (user.role === 'admin') throw new Error('管理员已拥有全部仓库权限，无需单独分配');
              if (db.prepare('SELECT id FROM user_warehouses WHERE userId = ? AND warehouseId = ? AND id <> ?').get(userId, warehouseId, id)) throw new Error('该账号已拥有此仓库权限');
              const oldUser = db.prepare('SELECT role, status FROM users WHERE id = ?').get(current?.userId) as { role: string; status: string } | undefined;
              const oldRemaining = Number((db.prepare('SELECT COUNT(*) AS total FROM user_warehouses WHERE userId = ? AND id <> ?').get(current?.userId, id) as { total: number }).total || 0);
              if (oldUser?.role === 'warehouse_manager' && oldUser.status === 'active' && oldRemaining === 0) throw new Error('不能移除已启用分仓管的最后一个仓库');
              db.prepare('UPDATE user_warehouses SET userId = ?, warehouseId = ? WHERE id = ?').run(userId, warehouseId, id);
            } else {
              updateRecord(resource, raw, id, incomingAssignments.has(id));
            }
            updated += 1;
          } else {
            if (resource.key === 'user_warehouses') {
              const userId = String(raw.userId || '');
              const warehouseId = String(raw.warehouseId || '');
              if (!userId || !warehouseId) throw new Error('仓库权限缺少用户或仓库');
              const user = db.prepare('SELECT role FROM users WHERE id = ?').get(userId) as { role: string } | undefined;
              const warehouse = db.prepare("SELECT status FROM warehouses WHERE id = ?").get(warehouseId) as { status: string } | undefined;
              if (!user) throw new Error('仓库权限对应用户不存在');
              if (!warehouse || warehouse.status !== 'active') throw new Error('只能给账号分配启用中的仓库');
              if (user.role === 'admin') throw new Error('管理员已拥有全部仓库权限，无需单独分配');
              if (db.prepare('SELECT id FROM user_warehouses WHERE userId = ? AND warehouseId = ?').get(userId, warehouseId)) throw new Error('该账号已拥有此仓库权限');
              db.prepare('INSERT INTO user_warehouses (id,userId,warehouseId,createdBy,createdAt) VALUES (?,?,?,?,?)').run(id || generateId('uw'), userId, warehouseId, actor.id, formatDateTime());
            } else {
              insertRecord(resource, raw, actor.id);
            }
            inserted += 1;
          }
        }
      }
      const check = dbIntegrityErrors();
      if (!check.ok) throw new Error('导入后数据库完整性检查失败');
      writeAudit(actor.id, 'import', resourceKey || 'all', null, { recordCount: inserted + updated, inserted, updated, mode, fileName: body.fileName || null, fileSha256, backup: backup.fileName });
    })();
    return NextResponse.json(successResponse({ inserted, updated, backup: { fileName: backup.fileName, sha256: backup.sha256 } }));
  } catch (error) {
    const failure = authErrorResponse(error);
    if (failure) return failure;
    console.error('POST /api/data-management/import error:', error);
    return NextResponse.json(errorResponse('DATABASE_ERROR', error instanceof Error ? error.message : '导入数据失败'), { status: 500 });
  }
}
