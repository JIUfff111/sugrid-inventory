'use client';

import { useEffect, useState } from 'react';
import { ChevronDown, History } from 'lucide-react';
import { assetChangeLines } from '@/lib/asset-change';
import { inventoryMovementLabel } from '@/lib/inventory-movement-labels';

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

const PAGE_SIZE = 20;

export default function InventoryMovementTimeline({ inventoryId }: { inventoryId: string }) {
  const [rows, setRows] = useState<Movement[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [moreError, setMoreError] = useState('');
  const [total, setTotal] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    setMoreError('');
    setRows([]);
    setTotal(0);
    void fetch(`/api/inventory/movements?inventoryId=${encodeURIComponent(inventoryId)}&page=1&pageSize=${PAGE_SIZE}`, { cache: 'no-store' })
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

  const loadMore = async () => {
    if (loadingMore || rows.length >= total) return;
    setLoadingMore(true);
    setMoreError('');
    try {
      const nextPage = Math.floor(rows.length / PAGE_SIZE) + 1;
      const response = await fetch(`/api/inventory/movements?inventoryId=${encodeURIComponent(inventoryId)}&page=${nextPage}&pageSize=${PAGE_SIZE}`, { cache: 'no-store' });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error?.message || '加载更早记录失败');
      setRows(current => [...current, ...(result.data?.items || [])]);
      setTotal(result.data?.total || 0);
    } catch (loadError) {
      setMoreError(loadError instanceof Error ? loadError.message : '加载更早记录失败');
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <section className="mt-5 border-t border-line/70 pt-5">
      <div className="mb-4 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-ink-deep"><History className="h-4 w-4 text-primary" />机器生命周期</h3>
        {total > 0 && <span className="text-xs text-ink-soft">共 {total} 条</span>}
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
                    <strong className="font-medium text-ink-deep">{inventoryMovementLabel(row.movementType)}</strong>
                    <time className="text-[11px] text-ink-soft">{row.createdAt.replace('T', ' ').slice(0, 19)}</time>
                  </div>
                  <p className="mt-1 text-xs text-ink-soft">{[row.fromWarehouseName, row.toWarehouseName].filter(Boolean).join(' → ') || row.warehouseName || '未记录仓库'} · {row.actorName || row.actorUsername || '系统'}</p>
                  {row.referenceId && <p className="mt-1 break-all font-mono text-[10px] text-ink-soft">关联：{row.referenceId}</p>}
                  {changes.map(change => <p key={change} className="mt-1 text-xs font-medium leading-5 text-ink-deep">{change}</p>)}
                  {row.note && !changes.length && <p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-ink-soft">{row.note}</p>}
                </li>;
              })}
            </ol>}
      {moreError && <p role="alert" className="mt-3 text-xs text-danger">{moreError}</p>}
      {total > rows.length && <button type="button" onClick={() => void loadMore()} disabled={loadingMore} className="btn-ghost mt-4 inline-flex items-center gap-1.5 text-xs"><ChevronDown className={`h-4 w-4 ${loadingMore ? 'animate-bounce' : ''}`} />{loadingMore ? '加载中...' : '加载更早记录'}</button>}
    </section>
  );
}
