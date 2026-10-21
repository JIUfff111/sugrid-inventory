import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { createPaginatedResponse, errorResponse, ErrorCode, parsePaginationParams, successResponse } from '@/lib/api-helpers';
import { AuthError, requireRole } from '@/lib/auth';

export async function GET(request: NextRequest) {
  try {
    const user = await requireRole('admin', 'warehouse_manager');
    const { searchParams } = new URL(request.url);
    const { page, pageSize } = parsePaginationParams(searchParams);
    const conditions = ['1 = 1']; const params: Array<string | number> = [];
    const inventoryId = searchParams.get('inventoryId')?.trim() || '';
    const sn = searchParams.get('sn')?.trim() || '';
    const warehouseId = searchParams.get('warehouseId')?.trim() || '';
    const movementType = searchParams.get('movementType')?.trim() || '';
    const dateFrom = searchParams.get('dateFrom')?.trim() || '';
    const dateTo = searchParams.get('dateTo')?.trim() || '';
    const actor = searchParams.get('actor')?.trim() || '';
    if (inventoryId) { conditions.push('m.inventoryId = ?'); params.push(inventoryId); }
    if (sn) { conditions.push('(i.sn = ? OR (length(?) >= 4 AND substr(i.sn,-length(?)) = ?))'); params.push(sn,sn,sn,sn); }
    if (warehouseId) { conditions.push('(m.warehouseId = ? OR m.fromWarehouseId = ? OR m.toWarehouseId = ?)'); params.push(warehouseId, warehouseId, warehouseId); }
    if (movementType) { conditions.push('m.movementType = ?'); params.push(movementType); }
    if (dateFrom) { conditions.push('m.createdAt >= ?'); params.push(dateFrom); }
    if (dateTo) { conditions.push('m.createdAt <= ?'); params.push(`${dateTo} 23:59:59`); }
    if (actor) { conditions.push('(u.realName LIKE ? OR u.username LIKE ?)'); params.push(`%${actor}%`, `%${actor}%`); }
    if (user.role !== 'admin') {
      conditions.push('(m.warehouseId IN (SELECT warehouseId FROM user_warehouses WHERE userId = ?) OR m.fromWarehouseId IN (SELECT warehouseId FROM user_warehouses WHERE userId = ?) OR m.toWarehouseId IN (SELECT warehouseId FROM user_warehouses WHERE userId = ?))');
      params.push(user.id, user.id, user.id);
    }
    const where = `WHERE ${conditions.map((condition) => condition.includes(' OR ') ? `(${condition})` : condition).join(' AND ')}`;
    const base = `FROM inventory_movements m LEFT JOIN inventory i ON i.id = m.inventoryId LEFT JOIN warehouses w ON w.id = m.warehouseId LEFT JOIN warehouses fw ON fw.id = m.fromWarehouseId LEFT JOIN warehouses tw ON tw.id = m.toWarehouseId LEFT JOIN users u ON u.id = m.actorId ${where}`;
    const total = Number((db.prepare(`SELECT COUNT(*) AS total ${base}`).get(...params) as { total: number }).total || 0);
    const isCsv = searchParams.get('format') === 'csv';
    const rows = db.prepare(`SELECT m.*, i.sn, i.brand, i.model, i.year, COALESCE(w.name, w.warehouseName) AS warehouseName, COALESCE(fw.name, fw.warehouseName) AS fromWarehouseName, COALESCE(tw.name, tw.warehouseName) AS toWarehouseName, u.realName AS actorName, u.username AS actorUsername ${base} ORDER BY m.createdAt DESC ${isCsv ? 'LIMIT 10000' : 'LIMIT ? OFFSET ?'}`).all(...(isCsv ? params : [...params, pageSize, (page - 1) * pageSize]));
    if (isCsv) {
      const header = ['时间', 'SN', '品牌', '型号', '事件', '来源仓', '目标仓', '操作人', '关联单号', '备注'];
      const lines = [header, ...(rows as Array<Record<string, unknown>>).map((row) => [row.createdAt, row.sn, row.brand, row.model, row.movementType, row.fromWarehouseName || '', row.toWarehouseName || '', row.actorName || row.actorUsername || '', row.referenceId || '', row.note || ''])].map((line) => line.map((value) => `"${String(value ?? '').replaceAll('"', '""')}"`).join(','));
      return new NextResponse(`\ufeff${lines.join('\n')}`, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="inventory-movements.csv"' } });
    }
    return NextResponse.json(successResponse(createPaginatedResponse(rows, total, page, pageSize)));
  } catch (error) {
    if (error instanceof AuthError) return NextResponse.json(errorResponse(error.code, error.message), { status: error.status });
    return NextResponse.json(errorResponse(ErrorCode.DATABASE_ERROR, error instanceof Error ? error.message : '获取移动记录失败'), { status: 500 });
  }
}
