import { NextRequest, NextResponse } from 'next/server';
import { authErrorResponse, requireSystemAccount } from '@/lib/auth';
import { errorResponse, successResponse } from '@/lib/api-helpers';
import db from '@/lib/db';
import { getResource, importPayload, recordExists, validateImportRecord, validateManagedUserMutation } from '@/lib/data-management';

export type ImportCheck = {
  resource: string;
  total: number;
  valid: number;
  conflicts: number;
  conflictIndexes: number[];
  conflictDetails: Array<{ index: number; message: string }>;
  errors: Array<{ index: number; message: string }>;
};

function isAutoSkippableConflict(message: string) {
  return message.includes('已存在') || message.includes('在导入文件中重复');
}

export async function buildImportReport(resourceKey: string | null, content: unknown, mode: 'insert' | 'upsert' = 'insert') {
  const payload = importPayload(resourceKey, content);
  const reports: ImportCheck[] = [];
  const incomingIds = new Map<string, Set<string>>();
  const payloadRecords = new Map<string, Map<string, Record<string, unknown>>>();
  for (const group of payload) {
    const ids = new Set<string>();
    const records = new Map<string, Record<string, unknown>>();
    for (const value of group.records) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const id = typeof (value as Record<string, unknown>).id === 'string' ? String((value as Record<string, unknown>).id).trim() : '';
        if (id) { ids.add(id); records.set(id, value as Record<string, unknown>); }
      }
    }
    incomingIds.set(group.resource, ids);
    payloadRecords.set(group.resource, records);
  }
  const duplicateIds = new Map<string, Set<string>>();
  for (const group of payload) {
    const counts = new Map<string, number>();
    for (const value of group.records) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const id = typeof (value as Record<string, unknown>).id === 'string' ? String((value as Record<string, unknown>).id).trim() : '';
      if (id) counts.set(id, (counts.get(id) || 0) + 1);
    }
    duplicateIds.set(group.resource, new Set([...counts].filter(([, count]) => count > 1).map(([id]) => id)));
  }
  const seenUnique = new Map<string, Map<string, Map<string, string>>>();
  for (const group of payload) {
    const resource = getResource(group.resource);
    if (!resource) continue;
    const report: ImportCheck = { resource: group.resource, total: group.records.length, valid: 0, conflicts: 0, conflictIndexes: [], conflictDetails: [], errors: [] };
    group.records.forEach((value, index) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) { report.errors.push({ index, message: '记录必须是对象' }); return; }
      const raw = value as Record<string, unknown>;
      const id = typeof raw.id === 'string' ? raw.id.trim() : '';
      if (id && duplicateIds.get(group.resource)?.has(id)) {
        report.errors.push({ index, message: `导入文件中 ID ${id} 重复` });
        return;
      }
      if (id && recordExists(resource, id)) {
        report.conflicts += 1;
        if (mode === 'insert') {
          report.conflictIndexes.push(index);
          report.conflictDetails.push({ index, message: `ID ${id} 已存在，已跳过` });
          return;
        }
      }
      const effectiveMode = mode === 'upsert' && id ? 'upsert' : 'insert';
      const errors = validateImportRecord(resource, raw, { mode: effectiveMode, incomingIds, seenUnique, payloadRecords });
      if (resource.key === 'users') {
        const current = id ? db.prepare('SELECT id, role, status, isSystemAccount FROM users WHERE id = ?').get(id) as { id: string; role: string; status: string; isSystemAccount: number } | undefined : undefined;
        const userData = effectiveMode === 'insert' ? { ...raw, status: 'pending', isSystemAccount: 0 } : raw;
        const hasIncomingAssignment = (payloadRecords.get('user_warehouses')?.size || 0) > 0 &&
          [...(payloadRecords.get('user_warehouses')?.values() || [])].some(assignment => String(assignment.userId || '') === String(id));
        errors.push(...validateManagedUserMutation(userData, current, hasIncomingAssignment));
      }
      if (resource.key === 'user_warehouses') {
        const userId = String(raw.userId || '');
        const warehouseId = String(raw.warehouseId || '');
        const user = db.prepare('SELECT role FROM users WHERE id = ?').get(userId) as { role: string } | undefined;
        const warehouse = db.prepare('SELECT status FROM warehouses WHERE id = ?').get(warehouseId) as { status: string } | undefined;
        if (user?.role === 'admin') errors.push('管理员已拥有全部仓库权限，无需单独分配');
        if (warehouse && warehouse.status !== 'active') errors.push('只能给账号分配启用中的仓库');
        if (userId && warehouseId) {
          const duplicate = db.prepare('SELECT id FROM user_warehouses WHERE userId = ? AND warehouseId = ?').get(userId, warehouseId) as { id: string } | undefined;
          if (duplicate && !(effectiveMode === 'upsert' && id && String(duplicate.id) === id)) errors.push('该账号已拥有此仓库权限');
        }
      }
      if (errors.length) {
        if (mode === 'insert') {
          const conflictErrors = errors.filter(isAutoSkippableConflict);
          const blockingErrors = errors.filter(error => !isAutoSkippableConflict(error));
          if (conflictErrors.length && !blockingErrors.length) {
            report.conflicts += 1;
            report.conflictIndexes.push(index);
            report.conflictDetails.push({ index, message: `${conflictErrors.join('；')}，已跳过` });
            return;
          }
          report.errors.push({ index, message: [...blockingErrors, ...conflictErrors].join('；') });
          return;
        }
        report.errors.push({ index, message: errors.join('；') });
        return;
      }
      report.valid += 1;
    });
    reports.push(report);
  }
  if (!reports.length) reports.push({ resource: resourceKey || 'all', total: 0, valid: 0, conflicts: 0, conflictIndexes: [], conflictDetails: [], errors: [{ index: 0, message: '未识别到可导入的数据资源' }] });
  return reports;
}

export async function POST(request: NextRequest) {
  try {
    await requireSystemAccount();
    const body = await request.json() as { resource?: string; content?: unknown; mode?: 'insert' | 'upsert' };
    if (body.content === undefined) return NextResponse.json(errorResponse('VALIDATION_ERROR', '导入内容不能为空'), { status: 400 });
    const reports = await buildImportReport(body.resource?.trim() || null, body.content, body.mode === 'upsert' ? 'upsert' : 'insert');
    return NextResponse.json(successResponse({ reports, canApply: reports.every((report) => report.errors.length === 0) && reports.some((report) => report.valid > 0) }));
  } catch (error) {
    const failure = authErrorResponse(error);
    if (failure) return failure;
    return NextResponse.json(errorResponse('DATABASE_ERROR', error instanceof Error ? error.message : '导入预览失败'), { status: 500 });
  }
}
