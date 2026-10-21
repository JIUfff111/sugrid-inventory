import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { authErrorResponse, requireUser, warehouseScope } from '@/lib/auth';
import { serializeInventoryStatus, stockEligibleSql } from '@/lib/inventory-status';
import { errorResponse, successResponse, createPaginatedResponse } from '@/lib/api-helpers';

const contexts = ['inventory','sale','rental','after-sale','exchange','supplier-return','transfer','movements','status-register'];
const stockContexts = ['sale','rental','exchange','supplier-return','transfer'];
export async function GET(request: NextRequest) {
  try {
    const user = await requireUser(); const query = request.nextUrl.searchParams;
    const context = query.get('context') || 'inventory';
    if (!contexts.includes(context)) return NextResponse.json(errorResponse('VALIDATION_ERROR','无效的机器查询用途'), { status: 400 });
    if (user.role !== 'admin' && !['inventory','transfer','movements'].includes(context)) return NextResponse.json(errorResponse('FORBIDDEN','无权执行此机器查询'), { status: 403 });
    const q = (query.get('q') || query.get('search') || '').trim().slice(0,200);
    const limit = Math.min(100,Math.max(1,Number.parseInt(query.get('limit') || query.get('pageSize') || '8',10) || 8));
    const page = Math.max(1,Number.parseInt(query.get('page') || '1',10) || 1);
    const scope = warehouseScope(user,query.get('warehouseId'),'i');
    const where = ['i.deleted = 0',scope.sql]; const params: Array<string|number> = [...scope.params];
    if (stockContexts.includes(context)) where.push(stockEligibleSql('i'));
    if (context === 'status-register') where.push("i.status = 'in_stock' AND i.currentStatusRecordId IS NULL",stockEligibleSql('i'));
    if (context === 'after-sale') where.push("i.status = 'sold'", "NOT EXISTS (SELECT 1 FROM after_sale_records a WHERE a.inventoryId = i.id AND a.deleted = 0 AND a.status NOT IN ('resolved','cancelled'))");
    if (context === 'movements' && user.role !== 'admin') {
      // A previously authorized warehouse can still inspect a transferred machine's audit trail.
      where[1] = `((${scope.sql}) OR EXISTS (SELECT 1 FROM inventory_movements m WHERE m.inventoryId=i.id AND
        (m.warehouseId IN (SELECT warehouseId FROM user_warehouses WHERE userId=?) OR m.fromWarehouseId IN (SELECT warehouseId FROM user_warehouses WHERE userId=?) OR m.toWarehouseId IN (SELECT warehouseId FROM user_warehouses WHERE userId=?))))`;
      params.push(user.id,user.id,user.id);
    }
    for (const field of ['supplierId','purchaseOrderId']) {
      const value = query.get(field)?.trim(); if (value) { where.push(`i.${field} = ?`); params.push(value); }
    }
    if (q) {
      const escaped = q.replace(/[\\%_]/g,'\\$&'); const pattern = `%${escaped}%`;
      where.push(`(i.sn LIKE ? ESCAPE '\\' OR (COALESCE(i.brand,'') || ' ' || COALESCE(i.model,'') || ' ' || COALESCE(i.year,'')) LIKE ? ESCAPE '\\' OR i.model LIKE ? ESCAPE '\\' OR i.saleOrderNo LIKE ? ESCAPE '\\')`);
      params.push(`%${escaped}`,pattern,pattern,pattern);
    }
    const from = `FROM inventory i LEFT JOIN warehouses w ON w.id=i.warehouseId LEFT JOIN purchase_orders po ON po.id=i.purchaseOrderId WHERE ${where.join(' AND ')}`;
    const total = Number((db.prepare(`SELECT COUNT(*) total ${from}`).get(...params) as {total:number}).total);
    const safePage = Math.min(page,Math.max(1,Math.ceil(total/limit)));
    const rows = db.prepare(`SELECT i.*,w.name AS warehouseName,po.purchaseNo,
      sr.id AS salesRecordId,sr.recordNo AS saleRecordNo,sr.recordNo AS salesRecordNo,sr.saleDate,
      COALESCE(sri.sellingPrice,i.sellingPrice,0) AS originalSellingPrice,
      COALESCE(sri.purchasePrice,i.purchasePrice,0) AS originalPurchasePrice,
      COALESCE(sri.profit,i.profit,0) AS originalProfit
      FROM inventory i LEFT JOIN warehouses w ON w.id=i.warehouseId LEFT JOIN purchase_orders po ON po.id=i.purchaseOrderId
      LEFT JOIN sales_record_items sri ON sri.id=(SELECT sx.id FROM sales_record_items sx JOIN sales_records sy ON sy.id=sx.salesRecordId WHERE sx.inventoryId=i.id AND sy.status='completed' AND sy.deleted=0 ORDER BY sx.createdAt DESC LIMIT 1)
      LEFT JOIN sales_records sr ON sr.id=sri.salesRecordId
      WHERE ${where.join(' AND ')} ORDER BY CASE WHEN lower(i.sn)=lower(?) THEN 0 WHEN length(?)>=4 AND lower(substr(i.sn,-length(?)))=lower(?) THEN 1 ELSE 2 END,i.updatedAt DESC,i.id LIMIT ? OFFSET ?`)
      .all(...params,q,q,q,q,limit,(safePage-1)*limit) as Array<{id:string}>;
    return NextResponse.json(successResponse(createPaginatedResponse(rows.map(serializeInventoryStatus),total,safePage,limit)));
  } catch (error) {
    return authErrorResponse(error) || NextResponse.json(errorResponse('DATABASE_ERROR',error instanceof Error ? error.message : '机器查询失败'), {status:500});
  }
}
