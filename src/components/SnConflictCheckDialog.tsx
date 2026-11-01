'use client';

import { useState, type FormEvent } from 'react';
import { AlertCircle, CheckCircle2, Database, Search, ShieldCheck } from 'lucide-react';
import BusinessDialog from '@/components/BusinessDialog';
import { useWorkspaceDirty } from '@/components/WorkspaceContext';

type CheckResult = {
  sn: string;
  canUse: boolean;
  requiresMigration: boolean;
  message: string;
  blockedBy: Array<{ type: string; id: string; itemId?: string; purchaseNo?: string; detail: string }>;
  softDeletedInventory: Array<{ id: string; sn: string; status: string; purchaseNo: string | null; warehouseName: string | null }>;
  purchaseHistory: Array<{ itemId: string; orderId: string; purchaseNo: string; purchaseDate: string; isInbounded: number; orderDeleted: number; itemDeleted: number }>;
};

export default function SnConflictCheckDialog({
  onClose,
  onOpenResource,
}: {
  onClose: () => void;
  onOpenResource: (resource: 'inventory' | 'purchase_orders', search: string, includeDeleted: boolean) => void;
}) {
  const [sn, setSn] = useState('');
  const [result, setResult] = useState<CheckResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  useWorkspaceDirty(false);

  const check = async (event: FormEvent) => {
    event.preventDefault();
    const value = sn.trim();
    if (!value) return;
    setLoading(true);
    setError('');
    setResult(null);
    try {
      const response = await fetch(`/api/purchase-orders/sn-check?sn=${encodeURIComponent(value)}`, { cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error?.message || 'SN 检查失败');
      setResult(payload.data as CheckResult);
    } catch (checkError) {
      setError(checkError instanceof Error ? checkError.message : 'SN 检查失败');
    } finally {
      setLoading(false);
    }
  };

  return <BusinessDialog
    title="SN 冲突排查"
    description="检查有效库存、软删除档案、未入库采购草稿和历史采购明细。只读检查，不会修改数据。"
    onClose={onClose}
    footer={<button type="button" className="btn-ghost" onClick={onClose}>关闭</button>}
  >
    <form className="flex flex-wrap gap-2" onSubmit={event => void check(event)}>
      <input autoFocus value={sn} onChange={event => setSn(event.target.value)} className="field min-w-0 flex-1" maxLength={120} placeholder="输入完整 SN" aria-label="完整 SN" />
      <button type="submit" disabled={loading || !sn.trim()} className="btn-primary inline-flex items-center gap-1.5"><Search className="h-4 w-4" />{loading ? '检查中' : '检查 SN'}</button>
    </form>
    {error && <p role="alert" className="mt-4 rounded-lg border border-danger/20 bg-danger/5 p-3 text-sm text-danger">{error}</p>}
    {result && <div className="mt-4 space-y-3">
      <div className={`flex items-start gap-2 rounded-lg border p-3 text-sm ${result.canUse ? 'border-success/20 bg-success/5 text-success' : 'border-warning/30 bg-warning/5 text-ink-deep'}`}>
        {result.canUse ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />}
        <div><p className="font-medium">{result.canUse ? '当前可重新入库' : '发现占用或数据库条件未满足'}</p><p className="mt-1 text-xs leading-5">{result.message}</p></div>
      </div>
      {result.requiresMigration && <div className="rounded-lg border border-warning/30 bg-warning/5 p-3 text-xs leading-5 text-ink-deep"><p className="flex items-center gap-1.5 font-medium"><ShieldCheck className="h-4 w-4 text-warning" />数据库迁移待执行</p><p className="mt-1">请在当前服务使用的数据库上运行 <code>npm run db:init</code> 并重启服务；不要对其他数据库副本运行后就假设本服务已更新。</p></div>}
      {result.blockedBy.length > 0 && <section className="space-y-2"><h3 className="text-xs font-semibold text-ink-deep">当前占用</h3>{result.blockedBy.map((item, index) => <article key={`${item.type}-${item.id}-${index}`} className="rounded-lg border border-line/70 bg-white/60 p-3 text-xs"><p className="text-ink-deep">{item.detail}</p><p className="mt-1 break-all font-mono text-ink-soft">记录 ID：{item.id}{item.itemId ? ` · 明细 ID：${item.itemId}` : ''}</p><button type="button" className="mt-2 text-primary hover:underline" onClick={() => onOpenResource(item.type === 'purchase_draft' ? 'purchase_orders' : 'inventory', item.type === 'purchase_draft' ? (item.purchaseNo || item.id) : result.sn, false)}>定位记录</button></article>)}</section>}
      {result.softDeletedInventory.length > 0 && <section className="rounded-lg border border-line/70 bg-white/60 p-3"><div className="flex items-center gap-1.5 text-xs font-semibold text-ink-deep"><Database className="h-4 w-4 text-primary" />已删除库存档案（{result.softDeletedInventory.length}）</div><ul className="mt-2 space-y-2">{result.softDeletedInventory.map(item => <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 text-xs"><span className="min-w-0"><span className="font-mono text-ink-deep">{item.sn}</span><span className="ml-2 text-ink-soft">{item.purchaseNo || '无采购单号'} · {item.warehouseName || '未分仓'}</span></span><button type="button" className="shrink-0 text-primary hover:underline" onClick={() => onOpenResource('inventory', result.sn, true)}>查看/清理残留</button></li>)}</ul><p className="mt-2 text-[11px] leading-5 text-ink-soft">有销售、租赁、售后或调拨关联的档案会被保护，不能强制清理；升级后的数据库允许保留历史档案并复用 SN。</p></section>}
      {result.purchaseHistory.length > 0 && <section className="rounded-lg border border-line/70 bg-white/60 p-3"><h3 className="text-xs font-semibold text-ink-deep">保留的采购历史（{result.purchaseHistory.length}）</h3><ul className="mt-2 space-y-1 text-xs text-ink-soft">{result.purchaseHistory.slice(0, 6).map(row => <li key={row.itemId}>{row.purchaseNo || row.orderId} · {row.purchaseDate || '日期未记录'} · {row.isInbounded ? '已入库历史' : '已删除历史'} · 明细 {row.itemId}</li>)}</ul><p className="mt-2 text-[11px] text-ink-soft">已入库采购历史会保留，不会单独阻止重新入库。</p></section>}
    </div>}
  </BusinessDialog>;
}
