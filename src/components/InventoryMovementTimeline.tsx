'use client';

import { useEffect, useState } from 'react';
import { History } from 'lucide-react';
import { assetChangeLines } from '@/lib/asset-change';

type Movement = {
  id: string;
  movementType: string;
  createdAt: string;
  fromWarehouseName?: string;
  toWarehouseName?: string;
  warehouseName?: string;
  actorName?: string;
  actorUsername?: string;
  referenceId?: string;
  note?: string;
  snapshot?: string | null;
};

const labels: Record<string, string> = {
  asset_change: '资产配置变更', custom_status_start: '登记库存状态', custom_status_end: '结束库存状态',
  opening_balance: '期初库存', purchase_in: '采购入库', purchase_inbound: '采购入库',
  sale: '销售出库', sale_out: '销售出库', sale_cancel: '销售撤销',
  sales_return: '客户退货入库', supplier_return: '供应商退货出库', supplier_return_out: '供应商退货出库',
  rental_out: '租赁出库', rental_return: '租赁归还', after_sale_created: '创建售后',
  after_sale_receive: '售后收到', after_sale_release: '售后维修释放',
  after_sale_restock: '售后转正式库存', after_sale_cancel: '售后取消',
  exchange_in: '换货原机入库', exchange_out: '换货替换机出库',
  transfer_in: '调拨入库', transfer_out: '调拨出库',
};

export default function InventoryMovementTimeline({ inventoryId, onViewAll }: { inventoryId: string; onViewAll: () => void }) {
  const [rows, setRows] = useState<Movement[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [total, setTotal] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    void fetch(`/api/inventory/movements?inventoryId=${encodeURIComponent(inventoryId)}&pageSize=100`, { cache: 'no-store' })
      .then(async response => {
        const result = await response.json();
        if (!response.ok || !result.success) throw new Error(result.error?.message || '加载移动记录失败');
        if (!cancelled) {
          setRows(result.data?.items || []);
          setTotal(result.data?.total || 0);
        }
      })
      .catch(error => { if (!cancelled) setError(error instanceof Error ? error.message : '加载失败'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [inventoryId]);

  return (
    <section className="mt-5 border-t border-line/70 pt-5">
      <div className="mb-4 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-ink-deep"><History className="h-4 w-4 text-primary" />机器生命周期</h3>
        <button type="button" onClick={onViewAll} className="text-xs text-primary hover:underline">查看完整移动记录</button>
      </div>
      {loading ? <p className="text-xs text-ink-soft">正在加载移动记录...</p>
        : error ? <p role="alert" className="text-xs text-danger">{error}</p>
          : !rows.length ? <p className="text-xs text-ink-soft">暂无移动记录</p>
            : <ol className="ml-1 space-y-5 border-l border-line/80 pl-5">
              {rows.map(row => {
                const changes = row.movementType === 'asset_change' ? assetChangeLines(row.snapshot) : [];
                return <li key={row.id} className="relative">
                  <span className="absolute -left-[25px] top-1 h-2 w-2 rounded-full bg-primary ring-4 ring-paper" />
                  <div className="flex flex-wrap justify-between gap-1 text-xs">
                    <strong className="font-medium text-ink-deep">{labels[row.movementType] || row.movementType}</strong>
                    <time className="text-[11px] text-ink-soft">{row.createdAt.replace('T', ' ').slice(0, 19)}</time>
                  </div>
                  <p className="mt-1 text-xs text-ink-soft">{[row.fromWarehouseName, row.toWarehouseName].filter(Boolean).join(' → ') || row.warehouseName || '未记录仓库'} · {row.actorName || row.actorUsername || '系统'}</p>
                  {row.referenceId && <p className="mt-1 break-all font-mono text-[10px] text-ink-soft">关联：{row.referenceId}</p>}
                  {changes.map(change => <p key={change} className="mt-1 text-xs font-medium leading-5 text-ink-deep">{change}</p>)}
                  {row.note && !changes.length && <p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-ink-soft">{row.note}</p>}
                </li>;
              })}
            </ol>}
      {total > rows.length && <p className="mt-4 text-xs text-ink-soft">显示最近 {rows.length} 条，共 {total} 条。</p>}
    </section>
  );
}
