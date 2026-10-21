import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { errorResponse, ErrorCode, generateId, successResponse } from '@/lib/api-helpers';
import { AuthError, requireRole } from '@/lib/auth';

function authError(error: unknown) {
  return error instanceof AuthError ? NextResponse.json(errorResponse(error.code, error.message), { status: error.status }) : null;
}

export async function GET(request: NextRequest) {
  try {
    const user = await requireRole('admin', 'warehouse_manager');
    if (request.nextUrl.searchParams.get('resource') === 'transfer-targets') {
      return NextResponse.json(successResponse(db.prepare("SELECT id, code, name, status FROM warehouses WHERE status = 'active' ORDER BY isDefault DESC, name").all()));
    }
    const rows = user.role === 'admin'
      ? db.prepare("SELECT id, code, COALESCE(name, warehouseName, code) AS name, address, remark, status, isDefault, createdAt, updatedAt FROM warehouses ORDER BY isDefault DESC, name COLLATE NOCASE").all()
      : db.prepare("SELECT w.id, w.code, COALESCE(w.name, w.warehouseName, w.code) AS name, w.address, w.remark, w.status, w.isDefault, w.createdAt, w.updatedAt FROM user_warehouses uw JOIN warehouses w ON w.id = uw.warehouseId WHERE uw.userId = ? ORDER BY w.isDefault DESC, w.name COLLATE NOCASE").all(user.id);
    return NextResponse.json(successResponse(rows));
  } catch (error) {
    const response = authError(error); if (response) return response;
    return NextResponse.json(errorResponse(ErrorCode.DATABASE_ERROR, error instanceof Error ? error.message : '获取仓库失败'), { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireRole('admin');
    const body = await request.json() as Record<string, unknown>;
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const code = typeof body.code === 'string' && body.code.trim() ? body.code.trim().toUpperCase() : `WH-${Date.now().toString(36).toUpperCase()}`;
    if (!name || name.length > 80) return NextResponse.json(errorResponse(ErrorCode.VALIDATION_ERROR, '仓库名称不能为空且不能超过 80 个字符'), { status: 400 });
    if (db.prepare('SELECT id FROM warehouses WHERE (name = ? OR code = ?) AND status != \'disabled\'').get(name, code)) return NextResponse.json(errorResponse(ErrorCode.DUPLICATE_ENTRY, '仓库名称或编码已存在'), { status: 409 });
    const id = generateId('warehouse'); const now = new Date().toISOString();
    db.prepare(`INSERT INTO warehouses (id, code, name, warehouseCode, warehouseName, address, remark, status, isDefault, createdBy, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 0, ?, ?, ?)`).run(id, code, name, code, name, String(body.address || '').trim() || null, String(body.remark || '').trim() || null, user.id, now, now);
    return NextResponse.json(successResponse(db.prepare('SELECT id, code, name, address, remark, status, isDefault, createdAt, updatedAt FROM warehouses WHERE id = ?').get(id)), { status: 201 });
  } catch (error) {
    const response = authError(error); if (response) return response;
    return NextResponse.json(errorResponse(ErrorCode.VALIDATION_ERROR, error instanceof Error ? error.message : '创建仓库失败'), { status: 400 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    await requireRole('admin');
    const body = await request.json() as Record<string, unknown>;
    const id = String(body.id || '').trim();
    const existing = db.prepare('SELECT id, isDefault FROM warehouses WHERE id = ?').get(id) as { id: string; isDefault: number } | undefined;
    if (!existing) return NextResponse.json(errorResponse(ErrorCode.NOT_FOUND, '仓库不存在'), { status: 404 });
    const name = body.name === undefined ? undefined : String(body.name).trim();
    const status = body.status === undefined ? undefined : String(body.status);
    if (name !== undefined && (!name || name.length > 80)) return NextResponse.json(errorResponse(ErrorCode.VALIDATION_ERROR, '仓库名称无效'), { status: 400 });
    if (status !== undefined && !['active', 'disabled'].includes(status)) return NextResponse.json(errorResponse(ErrorCode.VALIDATION_ERROR, '仓库状态无效'), { status: 400 });
    if (status === 'disabled' && existing.isDefault) return NextResponse.json(errorResponse(ErrorCode.VALIDATION_ERROR, '默认总仓不能停用'), { status: 400 });
    if (existing.isDefault && name !== undefined && name !== '总仓') return NextResponse.json(errorResponse(ErrorCode.VALIDATION_ERROR, '默认仓库名称固定为总仓'), { status: 400 });
    if (name && db.prepare('SELECT id FROM warehouses WHERE name = ? AND id != ?').get(name,id)) return NextResponse.json(errorResponse(ErrorCode.DUPLICATE_ENTRY, '仓库名称已存在'), { status: 409 });
    if (status === 'disabled' && (db.prepare("SELECT id FROM inventory WHERE warehouseId = ? AND deleted = 0 AND status NOT IN ('sold','returned') LIMIT 1").get(id) || db.prepare("SELECT id FROM transfers WHERE (sourceWarehouseId = ? OR targetWarehouseId = ?) AND status IN ('pending','approved','in_transit') LIMIT 1").get(id,id))) return NextResponse.json(errorResponse(ErrorCode.VALIDATION_ERROR, '仓库仍有机器或未完成调拨，不能停用'), { status: 400 });
    const now = new Date().toISOString();
    db.prepare('UPDATE warehouses SET name = COALESCE(?, name), warehouseName = COALESCE(?, warehouseName), address = COALESCE(?, address), remark = COALESCE(?, remark), status = COALESCE(?, status), updatedAt = ? WHERE id = ?').run(name ?? null, name ?? null, body.address === undefined ? null : String(body.address).trim() || null, body.remark === undefined ? null : String(body.remark).trim() || null, status ?? null, now, id);
    return NextResponse.json(successResponse(db.prepare('SELECT id, code, name, address, remark, status, isDefault, createdAt, updatedAt FROM warehouses WHERE id = ?').get(id)));
  } catch (error) {
    const response = authError(error); if (response) return response;
    return NextResponse.json(errorResponse(ErrorCode.VALIDATION_ERROR, error instanceof Error ? error.message : '更新仓库失败'), { status: 400 });
  }
}
