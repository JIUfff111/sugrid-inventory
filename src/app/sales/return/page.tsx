'use client';

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  ArchiveRestore,
  CalendarDays,
  Check,
  CircleDollarSign,
  Clock3,
  PackageOpen,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
  X,
} from 'lucide-react';
import ConfirmDialog from '@/components/ConfirmDialog';
import CustomSelect from '@/components/CustomSelect';
import MachineSearchInput from '@/components/MachineSearchInput';
import { useWorkspace, useWorkspaceDirty } from '@/components/WorkspaceContext';
import { useMachineEligibility } from '@/components/useMachineEligibility';
import { formatProductName } from '@/lib/product-name';
import { formatCPUDisplay, formatGPUDisplay, formatScreenDisplay } from '@/lib/sku-display';

type InventoryItem = {
  id: string;
  purchaseOrderId: string;
  purchaseNo: string | null;
  purchaseItemId: string;
  sn: string;
  productType: string;
  brand: string;
  model: string;
  year: number | null;
  cpu: string;
  ram: string;
  gpu: string | null;
  storage: string;
  screen: string;
  touchScreen: number | null;
  purchasePrice: number;
  supplierId: string;
  supplierName: string;
  status: string;
  inboundDate: string;
};

type ReturnItem = {
  inventoryId: string;
  sn: string;
  brand: string;
  model: string;
  year: number | null;
  cpu: string;
  ram: string;
  gpu: string | null;
  storage: string;
  screen: string;
  purchasePrice: number;
};

type ReturnOrder = {
  id: string;
  returnNo: string;
  items: ReturnItem[];
  purchaseOrderId: string;
  purchaseOrderNo: string;
  supplierId: string;
  supplierName: string;
  returnReason: string;
  returnDescription: string | null;
  refundAmount: number;
  status: 'returning' | 'completed' | string;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  itemCount: number;
};

type ApiEnvelope<T> = { success?: boolean; data?: T; error?: { message?: string } };
type ListResponse<T> = { items: T[]; total: number; totalPages: number; page: number; pageSize: number };

const RETURN_REASONS = ['质量问题', '规格不符', '多余库存', '其他'];
const STATUS_OPTIONS = [
  { value: 'all', label: '全部状态' },
  { value: 'returning', label: '退货中' },
  { value: 'completed', label: '已完成' },
];

function formatMoney(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '-';
  return `¥${Number(value).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(value: string | null | undefined) {
  if (!value) return '-';
  return value.replace('T', ' ').slice(0, 16);
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: 'no-store', ...init });
  const payload = await response.json() as ApiEnvelope<T>;
  if (!response.ok || payload.success === false) throw new Error(payload.error?.message || '请求失败');
  return payload.data as T;
}

function machineSummary(item: InventoryItem | ReturnItem) {
  const config = [formatCPUDisplay(item.cpu), item.ram, formatGPUDisplay(item.gpu), item.storage, formatScreenDisplay(item.screen)].filter(Boolean).join(' / ');
  return config || '配置待补充';
}

function productName(item: Pick<InventoryItem | ReturnItem, 'brand' | 'model' | 'year'>) {
  return formatProductName(item);
}

export default function SalesReturnPage() {
  const { active, user } = useWorkspace();
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [inventorySearch, setInventorySearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [returns, setReturns] = useState<ReturnOrder[]>([]);
  const [recordSearch, setRecordSearch] = useState('');
  const [recordSearchInput, setRecordSearchInput] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const [refundAmount, setRefundAmount] = useState('');
  const [description, setDescription] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [loadingInventory, setLoadingInventory] = useState(true);
  const [loadingReturns, setLoadingReturns] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [detailOrder, setDetailOrder] = useState<ReturnOrder | null>(null);
  const [pendingComplete, setPendingComplete] = useState<ReturnOrder | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [completingId, setCompletingId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const selectedIdsRef = useRef(selectedIds);
  useEffect(() => { selectedIdsRef.current = selectedIds; }, [selectedIds]);
  const selectedInventory = useMemo(() => inventory.filter((item) => selectedIds.includes(item.id)), [inventory, selectedIds]);
  const validity = useMachineEligibility(showCreate ? selectedInventory : [], 'supplier-return');
  useWorkspaceDirty(Boolean(showCreate && (selectedIds.length || reason || refundAmount || description)));
  const inProgressCount = returns.filter((order) => order.status === 'returning').length;
  const completedCount = returns.filter((order) => order.status === 'completed').length;
  const totalRefund = returns.reduce((sum, order) => sum + Number(order.refundAmount || 0), 0);

  const loadInventory = useCallback(async (search = '') => {
    setLoadingInventory(true);
    try {
      const params = new URLSearchParams({ context: 'supplier-return', q: search.trim(), limit: '100' });
      const data = await requestJson<ListResponse<InventoryItem>>('/api/inventory/lookup?' + params.toString());
      setInventory(current => [...data.items, ...current.filter(item => selectedIdsRef.current.includes(item.id) && !data.items.some(row => row.id === item.id))]);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载在库机器失败');
    } finally {
      setLoadingInventory(false);
    }
  }, []);

  const loadReturns = useCallback(async () => {
    setLoadingReturns(true);
    try {
      const params = new URLSearchParams({ page: '1', pageSize: '100' });
      if (statusFilter !== 'all') params.set('status', statusFilter);
      if (recordSearch.trim()) params.set('search', recordSearch.trim());
      const data = await requestJson<ListResponse<ReturnOrder>>(`/api/returns?${params.toString()}`);
      setReturns(data.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载退货记录失败');
    } finally {
      setLoadingReturns(false);
    }
  }, [recordSearch, statusFilter]);

  useEffect(() => { if (active) void loadInventory(inventorySearch); }, [active, loadInventory]);
  useEffect(() => { if (active) void loadReturns(); }, [active, loadReturns]);

  function submitInventorySearch(event: FormEvent) {
    event.preventDefault();
    setInventorySearch(searchInput);
    void loadInventory(searchInput);
  }

  function submitRecordSearch(event: FormEvent) {
    event.preventDefault();
    setRecordSearch(recordSearchInput);
  }

  function toggleSelected(id: string) {
    const candidate = inventory.find((item) => item.id === id);
    const selectedOrder = selectedInventory[0];
    if (!selectedIds.includes(id) && candidate && selectedOrder && (candidate.purchaseOrderId !== selectedOrder.purchaseOrderId || candidate.supplierId !== selectedOrder.supplierId)) {
      setError('一张退货单只能选择同一供应商、同一采购单的机器');
      return;
    }
    setSelectedIds((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);
    setError('');
  }

  function clearForm() {
    setSelectedIds([]);
    setReason('');
    setRefundAmount('');
    setDescription('');
  }

  function closeCreate() {
    if (!submitting) {
      setShowCreate(false);
      setError('');
    }
  }

  async function submitReturn(event: FormEvent) {
    event.preventDefault();
    setError('');
    setNotice('');
    if (selectedIds.length === 0) return setError('请先选择至少一台可退货机器');
    if (validity.checking || validity.error || validity.invalidIds.length) return setError(validity.error || '部分机器状态已变化，请取消选择并重新查询');
    if (!reason) return setError('请选择退货原因');
    const refund = Number(refundAmount);
    if (!Number.isFinite(refund) || refund < 0) return setError('请输入有效的退款金额');
    setSubmitting(true);
    try {
      const order = await requestJson<ReturnOrder>('/api/returns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inventoryIds: selectedIds, returnReason: reason, returnDescription: description, refundAmount: refund }),
      });
      setNotice(`退货申请 ${order.returnNo} 已提交，${order.itemCount} 台机器进入退货中状态`);
      clearForm();
      setShowCreate(false);
      await Promise.all([loadInventory(inventorySearch), loadReturns()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : '提交退货申请失败');
    } finally {
      setSubmitting(false);
    }
  }

  async function completeReturn(order: ReturnOrder) {
    setError('');
    setNotice('');
    setCompletingId(order.id);
    try {
      await requestJson('/api/returns', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: order.id, action: 'complete' }),
      });
      setNotice(`供应商退货单 ${order.returnNo} 已完成，${order.itemCount} 台机器已标记退货并从在库清单移出`);
      setPendingComplete(null);
      setDetailOrder(null);
      await Promise.all([loadInventory(inventorySearch), loadReturns()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : '完成退货失败');
    } finally {
      setCompletingId(null);
    }
  }

  const selectedPurchaseTotal = selectedInventory.reduce((sum, item) => sum + Number(item.purchasePrice || 0), 0);

  return (
    <div className="mx-auto max-w-[1240px] space-y-5 page-transition-enter">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="mb-2 text-xl font-bold text-ink-deep">供应商退货</h1>
          <p className="text-[13px] text-ink-soft">管理采购退货申请和退款进度，并保留机器流转历史</p>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => { setError(''); setShowCreate(true); void loadInventory(inventorySearch); }} className="btn-primary inline-flex items-center gap-2"><Plus className="h-4 w-4" />新建供应商退货</button>
          <button type="button" onClick={() => { void Promise.all([loadInventory(inventorySearch), loadReturns()]); }} className="btn-ghost p-2.5" title="刷新退货数据" aria-label="刷新退货数据"><RefreshCw className={`h-4 w-4 ${loadingReturns ? 'animate-spin' : ''}`} /></button>
        </div>
      </header>

      {(error || notice) && <div role={error ? 'alert' : 'status'} className={`rounded-xl border px-4 py-3 text-sm ${error ? 'border-danger/20 bg-danger/5 text-danger' : 'border-success/20 bg-success/5 text-success'}`}>{error || notice}</div>}

      <section className="grid gap-3 sm:grid-cols-3">
        <StatTile icon={<Clock3 className="h-4 w-4" />} label="退货中" value={String(inProgressCount)} tone="warning" />
        <StatTile icon={<Check className="h-4 w-4" />} label="已完成" value={String(completedCount)} tone="success" />
        <StatTile icon={<CircleDollarSign className="h-4 w-4" />} label="退款金额" value={formatMoney(totalRefund)} tone="primary" />
      </section>

      <section className="glass overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-line/70 p-4 lg:flex-row lg:items-center">
          <form onSubmit={submitRecordSearch} className="relative min-w-0 flex-1">
            <MachineSearchInput value={recordSearchInput} onChange={setRecordSearchInput} endpoint="/api/inventory/lookup?context=inventory" onSelect={item => { setRecordSearchInput(item.sn); setRecordSearch(item.sn); }} onSearch={setRecordSearch} placeholder="搜索退货单、SN 后四位、采购单或供应商" ariaLabel="搜索退货记录" />
          </form>
          <div className="flex items-center gap-2">
            <div className="min-w-[150px]"><CustomSelect value={statusFilter} onChange={setStatusFilter} options={STATUS_OPTIONS} aria-label="退货状态" /></div>
            <button type="button" onClick={() => { setRecordSearch(recordSearchInput); void loadReturns(); }} className="btn-ghost p-2.5" title="刷新记录" aria-label="刷新记录"><RefreshCw className={`h-4 w-4 ${loadingReturns ? 'animate-spin' : ''}`} /></button>
          </div>
        </div>

        {loadingReturns ? <div className="px-5 py-14 text-center text-sm text-ink-soft">正在加载退货记录...</div> : returns.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-5 py-14 text-center"><ArchiveRestore className="h-8 w-8 text-ink-soft/60" /><p className="text-sm text-ink-soft">暂无匹配的退货记录</p></div>
        ) : (
          <div className="divide-y divide-line/70">
            {returns.map((order) => (
              <button key={order.id} type="button" onClick={() => setDetailOrder(order)} className="grid w-full gap-3 px-5 py-4 text-left transition-colors hover:bg-white/45 md:grid-cols-[minmax(160px,1fr)_minmax(150px,1fr)_120px_110px_120px] md:items-center">
                <span className="min-w-0"><span className="block truncate font-mono text-sm font-semibold text-ink-deep">{order.returnNo}</span><span className="mt-1 block truncate text-xs text-ink-soft">{formatDate(order.createdAt)}</span></span>
                <span className="min-w-0"><span className="block truncate text-sm text-ink-deep">{order.supplierName}</span><span className="mt-1 block truncate text-xs text-ink-soft">采购单 {order.purchaseOrderNo}</span></span>
                <span className="text-sm text-ink-deep">{order.itemCount} 台 · {formatMoney(order.refundAmount)}</span>
                <span className={`status-pill w-fit ${order.status === 'returning' ? 'warn' : 'ok'}`}>{order.status === 'returning' ? '退货中' : '已完成'}</span>
                <span className="text-xs text-ink-soft">{order.returnReason}</span>
              </button>
            ))}
          </div>
        )}
        <footer className="border-t border-line/70 px-5 py-3 text-xs text-ink-soft">显示 {returns.length} 条记录</footer>
      </section>

      {active && showCreate && (
        <div style={{ top: user ? 100 : 0 }} className="fixed inset-0 z-[80] flex items-center justify-center bg-ink-deep/25 p-3 backdrop-blur-sm sm:p-6" onMouseDown={(event) => { if (event.target === event.currentTarget) closeCreate(); }}>
          <section role="dialog" aria-modal="true" aria-labelledby="return-create-title" className="glass flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl shadow-2xl">
            <header className="flex items-start justify-between border-b border-line/70 px-5 py-4 sm:px-6">
              <div><h2 id="return-create-title" className="text-base font-semibold text-ink-deep">新建供应商退货</h2><p className="mt-1 text-xs text-ink-soft">一次申请只能包含同一采购单、同一供应商的在库机器</p></div>
              <button type="button" onClick={closeCreate} title="关闭" aria-label="关闭" className="rounded-lg p-2 text-ink-soft hover:bg-white/70"><X className="h-4 w-4" /></button>
            </header>

            <div className="grid min-h-0 flex-1 overflow-y-auto lg:grid-cols-[1.1fr_0.9fr]">
              <section className="min-h-[300px] border-b border-line/70 p-4 sm:p-5 lg:border-b-0 lg:border-r">
                <div className="mb-3 flex items-center justify-between gap-2"><div><h3 className="text-sm font-semibold text-ink-deep">选择在库机器</h3><p className="mt-1 text-xs text-ink-soft">已选 {selectedIds.length} 台</p></div><span className="text-xs text-ink-soft">{inventory.length} 台可选</span></div>
                <form onSubmit={submitInventorySearch} className="relative mb-3">
                  <MachineSearchInput<InventoryItem> value={searchInput} onChange={setSearchInput} endpoint={"/api/inventory/lookup?context=supplier-return" + (selectedInventory[0] ? "&supplierId=" + encodeURIComponent(selectedInventory[0].supplierId) + "&purchaseOrderId=" + encodeURIComponent(selectedInventory[0].purchaseOrderId) : "")} onSelect={item => { const first = selectedInventory[0]; if (first && (item.supplierId !== first.supplierId || item.purchaseOrderId !== first.purchaseOrderId)) { setError("只能选择同一供应商、同一采购单的机器"); return; } setInventory(current => [item, ...current.filter(row => row.id !== item.id)]); setSelectedIds(current => current.includes(item.id) ? current : [...current, item.id]); setSearchInput(item.sn); }} onSearch={query => { setInventorySearch(query); void loadInventory(query); }} ariaLabel="搜索在库机器" />
                </form>
                <div className="max-h-[50vh] divide-y divide-line overflow-y-auto rounded-xl border border-line/70 bg-white/35">
                  {loadingInventory ? <div className="px-4 py-10 text-center text-sm text-ink-soft">加载在库机器...</div> : inventory.length === 0 ? <div className="flex flex-col items-center gap-2 px-4 py-10 text-center text-sm text-ink-soft"><PackageOpen className="h-7 w-7" />暂无符合条件的机器</div> : inventory.map((item) => {
                    const selected = selectedIds.includes(item.id);
                    return <label key={item.id} className={`flex cursor-pointer items-start gap-3 px-3 py-3 ${selected ? 'bg-primary/8' : 'hover:bg-white/60'}`}>
                      <input type="checkbox" checked={selected} onChange={() => toggleSelected(item.id)} className="mt-1 h-4 w-4 accent-primary" />
                      <span className="min-w-0 flex-1"><span className="flex flex-wrap justify-between gap-x-2 text-sm font-medium text-ink-deep"><span>{productName(item)}</span><span>{formatMoney(item.purchasePrice)}</span></span><span className="mt-1 block truncate font-mono text-xs text-ink-soft">{item.sn}</span><span className="mt-1 block truncate text-[11px] text-ink-soft">{machineSummary(item)} · {item.supplierName} · {item.purchaseNo || item.purchaseOrderId}</span></span>
                    </label>;
                  })}
                </div>
              </section>

              <form onSubmit={submitReturn} className="flex flex-col p-4 sm:p-5">
                <h3 className="mb-4 text-sm font-semibold text-ink-deep">退货申请信息</h3>
                <div className="space-y-4">
                  <label className="block"><span className="mb-1.5 block text-xs font-medium text-ink-deep">退货原因 <span className="text-danger">*</span></span><CustomSelect value={reason} onChange={setReason} options={[{ value: '', label: '请选择退货原因' }, ...RETURN_REASONS.map((value) => ({ value, label: value }))]} required /></label>
                  <label className="block"><span className="mb-1.5 block text-xs font-medium text-ink-deep">退款金额 <span className="text-danger">*</span></span><input type="number" min="0" step="0.01" value={refundAmount} onChange={(event) => setRefundAmount(event.target.value)} className="field" placeholder="请输入退款金额" aria-label="退款金额" /></label>
                  <label className="block"><span className="mb-1.5 block text-xs font-medium text-ink-deep">退货说明</span><textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={4} className="field resize-y" placeholder="补充退货原因或处理说明" aria-label="退货说明" /></label>
                  <div className="rounded-xl border border-line/70 bg-white/45 p-3 text-xs text-ink-soft"><div className="flex items-center justify-between"><span>选中机器</span><b className="text-ink-deep">{selectedIds.length} 台</b></div><div className="mt-2 flex items-center justify-between"><span>原采购成本</span><b className="font-mono text-ink-deep">{formatMoney(selectedPurchaseTotal)}</b></div></div>
                  {(error || validity.error || validity.invalidIds.length > 0) && <p role="alert" className="text-xs text-danger">{error || validity.error || "部分所选机器已不可退货，请重新选择。"}</p>}
                </div>
                <footer className="mt-auto flex items-center justify-end gap-2 border-t border-line/70 pt-4">
                  <button type="button" onClick={clearForm} disabled={submitting} className="btn-ghost">清空</button>
                  <button type="submit" disabled={submitting || validity.checking || !!validity.error || validity.invalidIds.length > 0} className="btn-primary inline-flex items-center gap-1.5"><RotateCcw className="h-4 w-4" />{submitting ? '提交中...' : '提交申请'}</button>
                </footer>
              </form>
            </div>
          </section>
        </div>
      )}

      {active && detailOrder && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-ink-deep/25 p-3 backdrop-blur-sm sm:p-6" onMouseDown={(event) => { if (event.target === event.currentTarget) setDetailOrder(null); }}>
          <section role="dialog" aria-modal="true" aria-labelledby="return-detail-title" className="glass flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl shadow-2xl">
            <header className="flex items-start justify-between border-b border-line/70 px-5 py-4"><div><div className="flex flex-wrap items-center gap-2"><h2 id="return-detail-title" className="font-mono text-base font-semibold text-ink-deep">{detailOrder.returnNo}</h2><span className={`status-pill ${detailOrder.status === 'returning' ? 'warn' : 'ok'}`}>{detailOrder.status === 'returning' ? '退货中' : '已完成'}</span></div><p className="mt-1 text-xs text-ink-soft">{detailOrder.supplierName} · 采购单 {detailOrder.purchaseOrderNo}</p></div><button type="button" onClick={() => setDetailOrder(null)} title="关闭" aria-label="关闭" className="rounded-lg p-2 text-ink-soft hover:bg-white/70"><X className="h-4 w-4" /></button></header>
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
              <div className="grid gap-3 sm:grid-cols-3"><DetailTile icon={<CalendarDays className="h-4 w-4" />} label="申请时间" value={formatDate(detailOrder.createdAt)} /><DetailTile icon={<RotateCcw className="h-4 w-4" />} label="退货原因" value={detailOrder.returnReason} /><DetailTile icon={<CircleDollarSign className="h-4 w-4" />} label="退款金额" value={formatMoney(detailOrder.refundAmount)} /></div>
              <div className="overflow-x-auto rounded-xl border border-line/70 bg-white/35"><table className="data-table w-full min-w-[620px]"><thead><tr><th>机器</th><th>SN / IMEI</th><th>配置</th><th className="text-right">原采购价</th></tr></thead><tbody>{detailOrder.items.map((item) => <tr key={`${detailOrder.id}-${item.inventoryId || item.sn}`}><td className="font-medium text-ink-deep">{productName(item)}</td><td className="font-mono text-xs">{item.sn}</td><td className="text-xs text-ink-soft">{machineSummary(item)}</td><td className="text-right font-mono">{formatMoney(item.purchasePrice)}</td></tr>)}</tbody></table></div>
              {detailOrder.returnDescription && <div className="rounded-xl border border-line/70 bg-white/40 px-4 py-3 text-sm text-ink-soft">{detailOrder.returnDescription}</div>}
              {detailOrder.completedAt && <p className="text-xs text-ink-soft">完成时间：{formatDate(detailOrder.completedAt)}</p>}
            </div>
            <footer className="flex items-center justify-end gap-2 border-t border-line/70 px-5 py-4"><button type="button" onClick={() => setDetailOrder(null)} className="btn-ghost">关闭</button>{detailOrder.status === 'returning' && <button type="button" onClick={() => setPendingComplete(detailOrder)} disabled={completingId === detailOrder.id} className="btn-primary inline-flex items-center gap-1.5"><Trash2 className="h-4 w-4" />完成退货</button>}</footer>
          </section>
        </div>
      )}

      <ConfirmDialog isOpen={Boolean(pendingComplete)} title="确认完成供应商退货" message={pendingComplete ? `${pendingComplete.itemCount} 台机器将标记为已退货并从在库清单移出，SN 和流转历史仍会保留。` : ''} confirmText={completingId ? '处理中...' : '确认完成'} cancelText="返回检查" danger onConfirm={() => { if (pendingComplete) void completeReturn(pendingComplete); }} onCancel={() => { if (!completingId) setPendingComplete(null); }} />
    </div>
  );
}

function StatTile({ icon, label, value, tone }: { icon: ReactNode; label: string; value: string; tone: 'warning' | 'success' | 'primary' }) {
  const toneClass = { warning: 'bg-warning/10 text-warning', success: 'bg-success/10 text-success', primary: 'bg-primary/10 text-primary' }[tone];
  return <div className="glass flex items-center gap-3 px-4 py-3"><span className={`flex h-9 w-9 items-center justify-center rounded-lg ${toneClass}`}>{icon}</span><div><p className="text-xs text-ink-soft">{label}</p><p className="mt-0.5 text-base font-semibold text-ink-deep">{value}</p></div></div>;
}

function DetailTile({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return <div className="rounded-xl border border-line/70 bg-white/40 px-3 py-3"><div className="flex items-center gap-2 text-xs text-ink-soft">{icon}{label}</div><p className="mt-2 truncate text-sm font-medium text-ink-deep">{value}</p></div>;
}

