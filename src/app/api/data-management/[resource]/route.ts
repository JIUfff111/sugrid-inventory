import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { authErrorResponse, hashPassword, requireSystemAccount } from '@/lib/auth';
import { ErrorCode, errorResponse, generateId, successResponse, formatDateTime } from '@/lib/api-helpers';
import {
  createBackup, deletionReferences, getResource, listResource, normalizeValue, recordExists, sanitizeRecord, sanitizeRow,
  validateImportRecord, validateManagedUserMutation, validateRecord, writeAudit, type DataResource,
} from '@/lib/data-management';

type Params = { params: Promise<{ resource: string }> };

async function resolveResource(params: Params) {
  const { resource: key } = await params.params;
  return getResource(key);
}

function bad(message: string, status = 400) {
  return NextResponse.json(errorResponse(ErrorCode.VALIDATION_ERROR, message), { status });
}

function fieldsForWrite(resource: DataResource, body: Record<string, unknown>) {
  const source = (body.data && typeof body.data === 'object' && !Array.isArray(body.data)) ? body.data as Record<string, unknown> : body;
  const data: Record<string, unknown> = {};
  for (const field of resource.writable) if (Object.prototype.hasOwnProperty.call(source, field)) data[field] = normalizeValue(source[field]);
  const rejected = Object.keys(source).filter((field) => field !== 'id' && field !== 'data' && !resource.writable.includes(field));
  return { data, rejected };
}

function fieldsForCreate(resource: DataResource, body: Record<string, unknown>) {
  const source = (body.data && typeof body.data === 'object' && !Array.isArray(body.data)) ? body.data as Record<string, unknown> : body;
  // Required fields are allowed on creation even when they are immutable after
  // creation (for example, a user's username). Audit, timestamps, and computed
  // fields are intentionally rejected instead of being silently discarded.
  const allowed = new Set(['id', ...(resource.required || []), ...resource.writable]);
  const data: Record<string, unknown> = {};
  for (const field of allowed) if (Object.prototype.hasOwnProperty.call(source, field)) data[field] = normalizeValue(source[field]);
  const rejected = Object.keys(source).filter((field) => field !== 'id' && field !== 'data' && !allowed.has(field));
  return { data, rejected };
}

export async function GET(request: NextRequest, { params }: Params) {
  try {
    await requireSystemAccount();
    const resource = await resolveResource({ params });
    if (!resource) return NextResponse.json(errorResponse(ErrorCode.NOT_FOUND, '数据资源不存在'), { status: 404 });
    const id = request.nextUrl.searchParams.get('id')?.trim();
    if (id) {
      const conditions = ['id = ?'];
      const params: unknown[] = [id];
      if (resource.fields.includes('deleted') && request.nextUrl.searchParams.get('includeDeleted') !== '1') conditions.push('deleted = 0');
      if (resource.key === 'users' && request.nextUrl.searchParams.get('includeDeleted') !== '1') conditions.push("status <> 'deleted'");
      const row = db.prepare(`SELECT ${resource.fields.join(',')} FROM ${resource.table} WHERE ${conditions.join(' AND ')}`).get(...params) as Record<string, unknown> | undefined;
      if (!row) return NextResponse.json(errorResponse(ErrorCode.NOT_FOUND, '记录不存在'), { status: 404 });
      return NextResponse.json(successResponse({ item: sanitizeRow(row), references: deletionReferences(resource, id) }));
    }
    return NextResponse.json(successResponse({ ...listResource(resource, request.nextUrl.searchParams), fields: resource.fields.map(key => ({ key, editable: resource.writable.includes(key) })) }));
  } catch (error) {
    const failure = authErrorResponse(error);
    if (failure) return failure;
    console.error('GET /api/data-management/[resource] error:', error);
    return NextResponse.json(errorResponse(ErrorCode.DATABASE_ERROR, '读取数据失败'), { status: 500 });
  }
}

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const actor = await requireSystemAccount();
    const resource = await resolveResource({ params });
    if (!resource) return NextResponse.json(errorResponse(ErrorCode.NOT_FOUND, '数据资源不存在'), { status: 404 });
    if (!resource.writable.length) return bad('该资源为只读历史数据，请使用对应业务流程修改', 409);
    if (resource.creatable === false) return bad('该业务记录必须通过对应业务流程创建', 409);
    const body = await request.json() as Record<string, unknown>;
    const { data: raw, rejected } = fieldsForCreate(resource, body);
    if (rejected.length) return bad(`字段不允许新增：${rejected.join('、')}`);
    const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : generateId(resource.key.replace(/s$/, ''));
    const source = { ...raw, id };
    const inputErrors = validateImportRecord(resource, source, {
      mode: 'insert',
      incomingIds: new Map([[resource.key, new Set([id])]]),
      seenUnique: new Map(),
    });
    if (inputErrors.length) return bad(inputErrors.join('；'));
    const data = sanitizeRecord(source, resource);
    if (resource.key === 'users') { data.isSystemAccount = 0; data.status = 'pending'; }
    if (resource.key === 'user_warehouses' && !data.id) data.id = id;
    const errors = validateRecord(resource, data, 'insert');
    if (errors.length) return bad(errors.join('；'));
    if (resource.key === 'users') {
      const userErrors = validateManagedUserMutation(data);
      if (userErrors.length) return bad(userErrors.join('；'));
    }
    if (recordExists(resource, id)) return NextResponse.json(errorResponse(ErrorCode.DUPLICATE_ENTRY, '记录 ID 已存在'), { status: 409 });
    if (resource.key === 'user_warehouses') {
      const user = db.prepare('SELECT role, status FROM users WHERE id = ?').get(data.userId) as { role: string; status: string } | undefined;
      if (!user) return bad('用户不存在');
      const warehouse = db.prepare("SELECT status FROM warehouses WHERE id = ?").get(data.warehouseId) as { status: string } | undefined;
      if (!warehouse || warehouse.status !== 'active') return bad('仓库不存在或已停用');
      if (user.role === 'admin') return bad('管理员已拥有全部仓库权限，无需单独分配');
      if (db.prepare('SELECT id FROM user_warehouses WHERE userId = ? AND warehouseId = ?').get(data.userId, data.warehouseId)) return bad('该账号已拥有此仓库权限', 409);
    }
    if (resource.key === 'warehouses') {
      const code = String(data.code ?? data.warehouseCode ?? '').trim().toUpperCase();
      const name = String(data.name ?? data.warehouseName ?? '').trim();
      if (!code || !name) return bad('仓库名称和编码不能为空');
      if (db.prepare("SELECT id FROM warehouses WHERE (name = ? OR code = ?) AND status <> 'disabled'").get(name, code)) return bad('仓库名称或编码已存在', 409);
      data.code = code;
      data.name = name;
      data.warehouseCode = code;
      data.warehouseName = name;
      data.status = String(data.status || 'active');
      if (!['active', 'disabled'].includes(String(data.status))) return bad('仓库状态无效');
    }
    const columns = Object.keys(data);
    const values = columns.map((field) => normalizeValue(data[field]));
    if (resource.fields.includes('createdAt') && !columns.includes('createdAt')) { columns.push('createdAt'); values.push(formatDateTime()); }
    if (resource.fields.includes('updatedAt') && !columns.includes('updatedAt')) { columns.push('updatedAt'); values.push(formatDateTime()); }
    if (resource.fields.includes('createdBy') && !columns.includes('createdBy')) { columns.push('createdBy'); values.push(actor.id); }
    if (resource.key === 'users') { columns.push('password'); values.push(hashPassword(`pending-${generateId('password')}`)); }
    const inserted = db.transaction(() => {
      db.prepare(`INSERT INTO ${resource.table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...values);
      writeAudit(actor.id, 'create', resource.key, id, { recordCount: 1 });
      const selected = resource.key === 'user_warehouses'
        ? db.prepare('SELECT * FROM user_warehouses WHERE userId = ? AND warehouseId = ?').get(data.userId, data.warehouseId)
        : db.prepare(`SELECT ${resource.fields.join(',')} FROM ${resource.table} WHERE id = ?`).get(id);
      return selected as Record<string, unknown>;
    })();
    return NextResponse.json(successResponse(sanitizeRow(inserted)), { status: 201 });
  } catch (error) {
    const failure = authErrorResponse(error);
    if (failure) return failure;
    console.error('POST /api/data-management/[resource] error:', error);
    return NextResponse.json(errorResponse(ErrorCode.DATABASE_ERROR, error instanceof Error ? error.message : '新增数据失败'), { status: 500 });
  }
}

export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const actor = await requireSystemAccount();
    const resource = await resolveResource({ params });
    if (!resource) return NextResponse.json(errorResponse(ErrorCode.NOT_FOUND, '数据资源不存在'), { status: 404 });
    if (!resource.writable.length) return bad('该资源为只读历史数据，请使用对应业务流程修改', 409);
    const body = await request.json() as Record<string, unknown>;
    const id = typeof body.id === 'string' ? body.id.trim() : '';
    if (!id) return bad('记录 ID 不能为空');
    const { data, rejected } = fieldsForWrite(resource, body);
    if (rejected.length) return bad(`字段不允许修改：${rejected.join('、')}`);
    const errors = validateRecord(resource, data, 'upsert');
    if (errors.length) return bad(errors.join('；'));
    if (!recordExists(resource, id)) return NextResponse.json(errorResponse(ErrorCode.NOT_FOUND, '记录不存在'), { status: 404 });
    const relationshipErrors = validateImportRecord(resource, { ...data, id }, {
      mode: 'upsert', incomingIds: new Map(), seenUnique: new Map(),
    });
    if (relationshipErrors.length) return bad(relationshipErrors.join('；'));
    if (resource.key === 'user_warehouses') {
      const current = db.prepare('SELECT userId, warehouseId FROM user_warehouses WHERE id = ?').get(id) as { userId: string; warehouseId: string } | undefined;
      const userId = String(data.userId ?? current?.userId ?? '');
      const warehouseId = String(data.warehouseId ?? current?.warehouseId ?? '');
      const user = db.prepare('SELECT role, status FROM users WHERE id = ?').get(userId) as { role: string; status: string } | undefined;
      const warehouse = db.prepare("SELECT status FROM warehouses WHERE id = ? AND status = 'active'").get(warehouseId);
      if (!user) return bad('用户不存在');
      if (!warehouse) return bad('仓库不存在或已停用');
      if (user.role === 'admin') return bad('管理员已拥有全部仓库权限，无需单独分配');
      if (db.prepare('SELECT id FROM user_warehouses WHERE userId = ? AND warehouseId = ? AND id <> ?').get(userId, warehouseId, id)) return bad('该账号已拥有此仓库权限', 409);
    }
    if (resource.key === 'warehouses') {
      const existingWarehouse = db.prepare('SELECT isDefault FROM warehouses WHERE id = ?').get(id) as { isDefault: number } | undefined;
      const name = data.name === undefined ? undefined : String(data.name).trim();
      const status = data.status === undefined ? undefined : String(data.status);
      const code = data.code === undefined ? undefined : String(data.code).trim().toUpperCase();
      if (status !== undefined && !['active', 'disabled'].includes(status)) return bad('仓库状态无效');
      if (existingWarehouse?.isDefault && status === 'disabled') return bad('默认总仓不能停用', 409);
      if (existingWarehouse?.isDefault && name !== undefined && name !== '总仓') return bad('默认仓库名称固定为总仓', 409);
      if (name !== undefined && !name) return bad('仓库名称不能为空');
      if (code && db.prepare('SELECT id FROM warehouses WHERE code = ? AND id <> ?').get(code, id)) return bad('仓库编码已存在', 409);
      if (name && db.prepare('SELECT id FROM warehouses WHERE name = ? AND id <> ?').get(name, id)) return bad('仓库名称已存在', 409);
      if (status === 'disabled' && (db.prepare("SELECT id FROM inventory WHERE warehouseId = ? AND deleted = 0 AND status NOT IN ('sold','returned') LIMIT 1").get(id) || db.prepare("SELECT id FROM transfers WHERE (sourceWarehouseId = ? OR targetWarehouseId = ?) AND status IN ('pending','approved','in_transit') LIMIT 1").get(id, id))) return bad('仓库仍有机器或未完成调拨，不能停用', 409);
      if (code !== undefined) data.code = code;
    }
    const current = resource.key === 'users'
      ? db.prepare('SELECT role, status, isSystemAccount FROM users WHERE id = ?').get(id) as { role: string; status: string; isSystemAccount: number } | undefined
      : undefined;
    if (resource.key === 'users' && current?.isSystemAccount && (data.role !== undefined || data.status !== undefined)) {
      return NextResponse.json(errorResponse(ErrorCode.FORBIDDEN, '内置系统管理员的角色和状态不能修改'), { status: 403 });
    }
    if (resource.key === 'users') {
      const userErrors = validateManagedUserMutation(data, current ? { id, ...current } : undefined);
      if (userErrors.length) return bad(userErrors.join('；'), userErrors.some(message => message.includes('内置系统管理员')) ? 403 : 409);
    }
    if (resource.key === 'users' && current?.role === 'admin' && current.status === 'active' &&
        ((data.role !== undefined && data.role !== 'admin') || (data.status !== undefined && data.status !== 'active')) &&
        Number((db.prepare("SELECT COUNT(*) AS total FROM users WHERE role = 'admin' AND status = 'active'").get() as { total: number }).total) <= 1) {
      return bad('必须保留至少一个有效管理员', 409);
    }
    const fields = Object.keys(data);
    if (!fields.length) return bad('没有可修改的字段');
    const values = fields.map((field) => data[field]);
    if (resource.fields.includes('updatedAt')) { fields.push('updatedAt'); values.push(formatDateTime()); }
    const securityChanged = resource.key === 'users' && current &&
      ((data.role !== undefined && String(data.role) !== current.role) ||
       (data.status !== undefined && String(data.status) !== current.status));
    const updated = db.transaction(() => {
      let result: { changes: number };
      if (resource.key === 'user_warehouses') {
        const current = db.prepare('SELECT userId, warehouseId FROM user_warehouses WHERE id = ?').get(id) as { userId: string; warehouseId: string } | undefined;
        const userId = String(data.userId ?? current?.userId ?? '');
        const warehouseId = String(data.warehouseId ?? current?.warehouseId ?? '');
        const oldUser = db.prepare('SELECT role, status FROM users WHERE id = ?').get(current?.userId) as { role: string; status: string } | undefined;
        const remaining = Number((db.prepare('SELECT COUNT(*) AS total FROM user_warehouses WHERE userId = ? AND id <> ?').get(current?.userId, id) as { total: number }).total || 0);
        if (oldUser?.role === 'warehouse_manager' && oldUser.status === 'active' && remaining === 0) throw new Error('移除此权限会导致已启用分仓管没有仓库，请先停用账号或分配其他仓库');
        if (db.prepare('SELECT id FROM user_warehouses WHERE userId = ? AND warehouseId = ? AND id <> ?').get(userId, warehouseId, id)) throw new Error('该账号已拥有此仓库权限');
        result = db.prepare('UPDATE user_warehouses SET userId = ?, warehouseId = ? WHERE id = ?').run(userId, warehouseId, id);
      } else {
        result = db.prepare(`UPDATE ${resource.table} SET ${fields.map((field) => `${field} = ?`).join(', ')} WHERE id = ?`).run(...values, id);
      }
      if (result.changes !== 1) throw new Error('记录已发生变化，请刷新后重试');
      if (securityChanged) {
        db.prepare('UPDATE sessions SET revokedAt = ? WHERE userId = ? AND revokedAt IS NULL').run(formatDateTime(), id);
      }
      writeAudit(actor.id, 'update', resource.key, id, { recordCount: 1, fields: Object.keys(data) });
      const selected = resource.key === 'user_warehouses'
        ? db.prepare('SELECT * FROM user_warehouses WHERE id = ?').get(id)
        : db.prepare(`SELECT ${resource.fields.join(',')} FROM ${resource.table} WHERE id = ?`).get(id);
      return selected as Record<string, unknown>;
    })();
    return NextResponse.json(successResponse(sanitizeRow(updated)));
  } catch (error) {
    const failure = authErrorResponse(error);
    if (failure) return failure;
    console.error('PATCH /api/data-management/[resource] error:', error);
    return NextResponse.json(errorResponse(ErrorCode.DATABASE_ERROR, error instanceof Error ? error.message : '更新数据失败'), { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const actor = await requireSystemAccount();
    const resource = await resolveResource({ params });
    if (!resource) return NextResponse.json(errorResponse(ErrorCode.NOT_FOUND, '数据资源不存在'), { status: 404 });
    if (resource.deletable === false) return bad('库存机器请从库存详情执行永久删除，历史数据不会通过通用删除隐藏', 409);
    const id = request.nextUrl.searchParams.get('id')?.trim() || '';
    if (!id) return bad('记录 ID 不能为空');
    const activeFilter = resource.fields.includes('deleted') ? ' AND deleted = 0' : '';
    const row = db.prepare(`SELECT * FROM ${resource.table} WHERE id = ?${activeFilter}`).get(id) as Record<string, unknown> | undefined;
    if (!row) return NextResponse.json(errorResponse(ErrorCode.NOT_FOUND, '记录不存在'), { status: 404 });
    if (resource.key === 'users' && Number(row.isSystemAccount) === 1) return NextResponse.json(errorResponse(ErrorCode.FORBIDDEN, '不能删除内置系统管理员'), { status: 403 });
    if (resource.key === 'users') {
      if (id === actor.id) return bad('不能删除当前登录账号', 409);
      if (row.status === 'deleted') return NextResponse.json(errorResponse(ErrorCode.NOT_FOUND, '账号已删除'), { status: 404 });
      if (row.role === 'admin' && row.status === 'active') {
        const admins = Number((db.prepare("SELECT COUNT(*) AS total FROM users WHERE role = 'admin' AND status = 'active'").get() as { total: number }).total || 0);
        if (admins <= 1) return bad('必须保留至少一个有效管理员', 409);
      }
      const backup = await createBackup(actor.id, 'before-data-delete');
      const now = formatDateTime();
      db.transaction(() => {
        const changed = db.prepare("UPDATE users SET status = 'deleted', deletedAt = ?, deletedBy = ?, updatedAt = ? WHERE id = ? AND status <> 'deleted' AND isSystemAccount = 0").run(now, actor.id, now, id);
        if (changed.changes !== 1) throw new Error('账号已发生变化，请刷新后重试');
        db.prepare('UPDATE sessions SET revokedAt = ? WHERE userId = ? AND revokedAt IS NULL').run(now, id);
        writeAudit(actor.id, 'delete', resource.key, id, { recordCount: 1, mode: 'logical', backup: backup.fileName });
      })();
      return NextResponse.json(successResponse({ id, message: '账号已停用并保留关联历史' }));
    }
    const references = deletionReferences(resource, id);
    if (references.length) {
      const details = references.map(item => `${item.label} ${item.count} 条`).join('、');
      return NextResponse.json(errorResponse(ErrorCode.CANNOT_DELETE_IN_USE, `存在关联数据，无法删除：${details}`, { references }), { status: 409 });
    }
    const backup = await createBackup(actor.id, 'before-data-delete');
    const now = formatDateTime();
    if (resource.hardDeletable) {
      db.transaction(() => {
        const fresh = db.prepare(`SELECT id FROM ${resource.table} WHERE id = ?`).get(id) as { id: string } | undefined;
        if (!fresh) throw new Error('记录已发生变化，请刷新后重试');
        const assignment = db.prepare('SELECT userId FROM user_warehouses WHERE id = ?').get(id) as { userId: string } | undefined;
        if (assignment) {
          const user = db.prepare('SELECT role, status FROM users WHERE id = ?').get(assignment.userId) as { role: string; status: string } | undefined;
          const others = Number((db.prepare('SELECT COUNT(*) AS total FROM user_warehouses WHERE userId = ? AND id <> ?').get(assignment.userId, id) as { total: number }).total || 0);
          if (user?.role === 'warehouse_manager' && user.status === 'active' && others === 0) throw new Error('移除此权限会导致已启用分仓管没有仓库，请先停用账号或分配其他仓库');
        }
        const result = db.prepare(`DELETE FROM ${resource.table} WHERE id = ?`).run(id);
        if (result.changes !== 1) throw new Error('记录已发生变化，请刷新后重试');
        writeAudit(actor.id, 'delete', resource.key, id, { recordCount: 1, mode: 'hard', backup: backup.fileName });
      })();
      return NextResponse.json(successResponse({ id, message: '记录已删除' }));
    }
    if (!resource.fields.includes('deleted')) return bad('该历史资源只能通过业务流程修改或删除', 409);
    const updates = ['deleted = 1'];
    const values: unknown[] = [];
    if (resource.fields.includes('updatedAt')) { updates.push('updatedAt = ?'); values.push(now); }
    if (resource.key === 'users') { updates.push('status = ?', 'deletedAt = ?', 'deletedBy = ?'); values.push('deleted', now, actor.id); }
    db.transaction(() => {
      const fresh = db.prepare(`SELECT id FROM ${resource.table} WHERE id = ? AND deleted = 0`).get(id) as { id: string } | undefined;
      if (!fresh) throw new Error('记录已发生变化，请刷新后重试');
      const result = db.prepare(`UPDATE ${resource.table} SET ${updates.join(', ')} WHERE id = ? AND deleted = 0`).run(...values, id);
      if (result.changes !== 1) throw new Error('记录已发生变化，请刷新后重试');
      if (resource.key === 'users') db.prepare('UPDATE sessions SET revokedAt = ? WHERE userId = ? AND revokedAt IS NULL').run(now, id);
      writeAudit(actor.id, 'delete', resource.key, id, { recordCount: 1, mode: 'logical', backup: backup.fileName });
    })();
    return NextResponse.json(successResponse({ id, message: '记录已删除' }));
  } catch (error) {
    const failure = authErrorResponse(error);
    if (failure) return failure;
    console.error('DELETE /api/data-management/[resource] error:', error);
    return NextResponse.json(errorResponse(ErrorCode.DATABASE_ERROR, error instanceof Error ? error.message : '删除数据失败'), { status: 500 });
  }
}
