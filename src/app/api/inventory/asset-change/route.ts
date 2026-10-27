import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { assertWarehouseAccess, authErrorResponse, requireRole } from '@/lib/auth';
import { errorResponse, formatDateTime, generateId, successResponse } from '@/lib/api-helpers';

type AssetChangeInput = {
  inventoryId?: unknown;
  expectedRam?: unknown;
  expectedStorage?: unknown;
  ram?: unknown;
  storage?: unknown;
};

function configuration(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label}配置无效`);
  const result = value.trim();
  if (!result || result.length > 64 || /[\x00-\x1f\x7f]/.test(result)) {
    throw new Error(`${label}配置不能为空，且不能超过 64 个字符`);
  }
  return result;
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireRole('admin');
    const body = await request.json() as AssetChangeInput;
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('资产变更信息无效');
    const inventoryId = typeof body.inventoryId === 'string' ? body.inventoryId.trim() : '';
    if (!inventoryId || typeof body.expectedRam !== 'string' || typeof body.expectedStorage !== 'string') {
      throw new Error('机器或原配置缺失，请刷新后重试');
    }
    if (body.ram === undefined && body.storage === undefined) throw new Error('请选择要变更的内存或硬盘');
    const requestedRam = body.ram === undefined ? undefined : configuration(body.ram, '内存');
    const requestedStorage = body.storage === undefined ? undefined : configuration(body.storage, '硬盘');

    const item = db.transaction(() => {
      const current = db.prepare(`SELECT id, sn, ram, storage, status, warehouseId
        FROM inventory WHERE id = ? AND deleted = 0`).get(inventoryId) as {
          id: string; sn: string; ram: string; storage: string; status: string; warehouseId: string;
        } | undefined;
      if (!current) throw new Error('机器不存在或已删除');
      assertWarehouseAccess(user, current.warehouseId);
      if (current.status !== 'in_stock') throw new Error('只有普通在库机器可以变更资产配置');
      if (db.prepare(`SELECT 1 FROM transfer_items ti JOIN transfers t ON t.id = ti.transferId
        WHERE ti.inventoryId = ? AND t.status IN ('pending','approved','in_transit')`).get(inventoryId)) {
        throw new Error('机器有进行中的调拨申请，请先处理调拨');
      }
      if (current.ram !== body.expectedRam || current.storage !== body.expectedStorage) {
        throw new Error('机器配置已变化，请刷新后重试');
      }
      const before = { ram: current.ram, storage: current.storage };
      const after = { ram: requestedRam ?? current.ram, storage: requestedStorage ?? current.storage };
      if (before.ram === after.ram && before.storage === after.storage) throw new Error('资产变更没有实际修改');
      const now = formatDateTime();
      const changed = db.prepare(`UPDATE inventory SET ram = ?, storage = ?, updatedAt = ?
        WHERE id = ? AND deleted = 0 AND status = 'in_stock' AND ram = ? AND storage = ?`)
        .run(after.ram, after.storage, now, inventoryId, before.ram, before.storage);
      if (changed.changes !== 1) throw new Error('机器配置或状态已变化，请刷新后重试');
      const details = [
        before.ram !== after.ram ? `内存 ${before.ram} → ${after.ram}` : '',
        before.storage !== after.storage ? `硬盘 ${before.storage} → ${after.storage}` : '',
      ].filter(Boolean);
      db.prepare(`INSERT INTO inventory_movements
        (id,inventoryId,warehouseId,movementType,referenceType,referenceId,actorId,note,statusFrom,statusTo,snapshot,createdAt)
        VALUES (?,?,?,'asset_change','inventory',?,?,?,?,?,?,?)`)
        .run(generateId('movement'), inventoryId, current.warehouseId, inventoryId, user.id,
          `库存资产变更：${details.join('；')}`, current.status, current.status,
          JSON.stringify({ before, after }), now);
      return { ...current, ...after, updatedAt: now };
    })();

    return NextResponse.json(successResponse(item));
  } catch (error) {
    return authErrorResponse(error) || NextResponse.json(
      errorResponse('VALIDATION_ERROR', error instanceof Error ? error.message : '资产变更失败'),
      { status: 400 },
    );
  }
}
