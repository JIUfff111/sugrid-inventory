'use client';

import { FormEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, CircleCheck, RotateCcw, Wrench, X } from 'lucide-react';
import CustomSelect, { SelectOption } from '@/components/CustomSelect';
import ConfirmDialog from '@/components/ConfirmDialog';
import BusinessDialog from '@/components/BusinessDialog';
import MachineSearchInput from '@/components/MachineSearchInput';
import { useWorkspace, useWorkspaceDirty } from '@/components/WorkspaceContext';
import { useMachineEligibility } from '@/components/useMachineEligibility';
import { useInventoryLabelPrinter } from '@/components/InventoryLabelPrint';
import { formatProductName } from '@/lib/product-name';
import { formatCPUDisplay, formatGPUDisplay, formatScreenDisplay } from '@/lib/sku-display';

type SoldItem = { id: string; sn: string; brand: string; model: string; year: number | null; cpu: string; ram: string; gpu?: string | null; storage: string; screen?: string | null; sellingPrice: number | null; purchasePrice: number; saleOrderNo: string | null; salesRecordNo?: string | null; saleChannel?: string | null; saleDate?: string | null; warehouseId?: string | null };
type ReplacementItem = { id: string; sn: string; brand: string; model: string; year: number | null; cpu: string; ram: string; gpu?: string | null; storage: string; screen?: string | null };
type AfterSale = { id: string; afterSaleNo: string; inventoryId: string; sn: string; brand?: string | null; model?: string | null; year?: number | null; cpu?: string | null; ram?: string | null; gpu?: string | null; storage?: string | null; screen?: string | null; customerName?: string | null; customerPhone?: string | null; issueType: string; issueDescription: string | null; resolutionType: string; status: string; refundAmount?: number | null; resolutionNote: string | null; saleOrderNo: string | null; salesRecordNo?: string | null; saleChannel?: string | null; saleDate?: string | null; sellingPrice?: number | null; purchasePrice?: number | null; warehouseId?: string | null; replacementInventoryId: string | null; createdAt: string; receivedAt?: string; stockStatus?: string };
type ToastMessage = { text: string; tone: 'success' | 'error' };

function money(value: number | null | undefined) { return '¥' + Number(value || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function configText(item: Pick<SoldItem, 'cpu' | 'ram' | 'storage'> & { gpu?: string | null; screen?: string | null }) { return [formatCPUDisplay(item.cpu), item.ram, item.storage, formatGPUDisplay(item.gpu), formatScreenDisplay(item.screen)].filter(Boolean).join(' · ') || '配置待补充'; }
function statusLabel(status: string) { return ({ created: '待收机', received: '已收到', processing: '处理中', resolved: '已完成', cancelled: '已取消' } as Record<string, string>)[status] || status; }
function statusClass(status: string) { return ['created', 'received', 'processing'].includes(status) ? 'warn' : status === 'resolved' ? 'ok' : 'danger'; }
function resolutionLabel(type: string) { return type === 'repair' ? '维修' : type === 'exchange' ? '换货' : '退货退款'; }
function productName(item: { brand?: string | null; model?: string | null; year?: number | null }) { return formatProductName(item); }

function ModalShell({ title, subtitle, onClose, children, footer }: { title: string; subtitle?: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  return <BusinessDialog title={title} description={subtitle} onClose={onClose} footer={footer}>{children}</BusinessDialog>;
}

export default function AfterSalesPage() {
  const { active, searchParams } = useWorkspace();
  const recordId = searchParams.get('recordId') || '';
  const openedRecord = useRef('');
  const [soldItems, setSoldItems] = useState<SoldItem[]>([]);
  const [replacementItems, setReplacementItems] = useState<ReplacementItem[]>([]);
  const [records, setRecords] = useState<AfterSale[]>([]);
  const [summaryRecords, setSummaryRecords] = useState<AfterSale[]>([]);
  const [search, setSearch] = useState('');
  const [checkedAt, setCheckedAt] = useState(0);
  const [machineSearch, setMachineSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [selectedId, setSelectedId] = useState('');
  const [issueType, setIssueType] = useState('质量问题');
  const [issueDescription, setIssueDescription] = useState('');
  const [resolutionType, setResolutionType] = useState('repair');
  const [remark, setRemark] = useState('');
  const [replacementId, setReplacementId] = useState('');
  const [replacementSearch, setReplacementSearch] = useState('');
  const [handlingNote, setHandlingNote] = useState('');
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [returnConfirmOpen, setReturnConfirmOpen] = useState(false);
  const [pendingPrint, setPendingPrint] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedRecord, setSelectedRecord] = useState<AfterSale | null>(null);
  const [cancelConfirm, setCancelConfirm] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const { printLabels, printing, printPortal } = useInventoryLabelPrinter();

  const notify = (text: string, tone: ToastMessage['tone'] = 'success') => setToast({ text, tone });

  useEffect(() => {
    if (!active || !recordId || openedRecord.current === recordId) return;
    const controller = new AbortController();
    void fetch('/api/after-sales?id=' + encodeURIComponent(recordId), { cache: 'no-store', signal: controller.signal }).then(async response => {
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error?.message || '关联售后单加载失败');
      if (controller.signal.aborted) return;
      const record = payload.data?.items?.[0];
      if (!record) throw new Error('关联售后单已不存在');
      openedRecord.current = recordId;
      setSelectedRecord(record); setReplacementId(''); setHandlingNote('');
    }).catch(error => { if (!controller.signal.aborted) setToast({ text: error.message || '关联售后单加载失败', tone: 'error' }); });
    return () => controller.abort();
  }, [active, recordId]);

  const loadController = useRef<AbortController | null>(null);
  const loadData = useCallback(async () => {
    loadController.current?.abort(); const controller = new AbortController(); loadController.current = controller;
    setLoading(true);
    try {
      const recordStatus = status === 'stored' ? 'all' : status;
      const recordUrl = '/api/after-sales?status=' + encodeURIComponent(recordStatus) + '&search=' + encodeURIComponent(search) + '&pageSize=100';
      const summaryUrl = '/api/after-sales?status=all&pageSize=100';
      const replacementUrl = '/api/inventory/lookup?context=exchange&limit=100';
      const [recordsResponse, summaryResponse, replacementResponse] = await Promise.all([
        fetch(recordUrl, { cache: 'no-store', signal: controller.signal }),
        fetch(summaryUrl, { cache: 'no-store', signal: controller.signal }),
        fetch(replacementUrl, { cache: 'no-store', signal: controller.signal }),
      ]);
      const recordsPayload = await recordsResponse.json();
      const summaryPayload = await summaryResponse.json();
      const replacementPayload = await replacementResponse.json();
      if (!recordsResponse.ok || !recordsPayload.success) throw new Error(recordsPayload.error?.message || '加载售后记录失败');
      if (!summaryResponse.ok || !summaryPayload.success) throw new Error(summaryPayload.error?.message || '加载售后统计失败');
      if (!replacementResponse.ok || !replacementPayload.success) throw new Error(replacementPayload.error?.message || '加载替换机器失败');
      const summaryPageCount = Number(summaryPayload.data?.totalPages || 1);
      const summaryPageResponses = await Promise.all(Array.from({ length: Math.max(0, summaryPageCount - 1) }, (_, index) => fetch('/api/after-sales?status=all&pageSize=100&page=' + (index + 2), { cache: 'no-store', signal: controller.signal })));
      const summaryPagePayloads = await Promise.all(summaryPageResponses.map((response) => response.json()));
      const failedSummaryPage = summaryPageResponses.findIndex((response, index) => !response.ok || !summaryPagePayloads[index]?.success);
      if (failedSummaryPage !== -1) throw new Error(summaryPagePayloads[failedSummaryPage]?.error?.message || '加载售后统计失败');
      setCheckedAt(Date.now());
      const loadedRecords = recordsPayload.data?.items || [];
      setRecords(status === 'stored' ? loadedRecords.filter((record: AfterSale) => ['received', 'processing'].includes(record.status)) : loadedRecords);
      setSummaryRecords([...(summaryPayload.data?.items || []), ...summaryPagePayloads.flatMap((payload) => payload.data?.items || [])]);
      setReplacementItems(current => { const next: ReplacementItem[] = replacementPayload.data?.items || []; return [...next, ...current.filter(item => item.id === replacementId && !next.some(row => row.id === item.id))]; });
    } catch (loadError) {
      if (!controller.signal.aborted) notify(loadError instanceof Error ? loadError.message : '加载售后数据失败', 'error');
    } finally { if (!controller.signal.aborted) setLoading(false); }
  }, [search, status, replacementId]);

  const soldController = useRef<AbortController | null>(null);
  const loadSoldItems = useCallback(async () => {
    soldController.current?.abort(); const controller = new AbortController(); soldController.current = controller;
    try {
      const response = await fetch('/api/inventory/lookup?context=after-sale&q=' + encodeURIComponent(machineSearch) + '&limit=100', { cache: 'no-store', signal: controller.signal });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error?.message || '加载已售机器失败');
      setSoldItems(current => { const next: SoldItem[] = payload.data?.items || []; return [...next, ...current.filter(item => item.id === selectedId && !next.some(row => row.id === item.id))]; });
    } catch (loadError) { if (!controller.signal.aborted) notify(loadError instanceof Error ? loadError.message : '加载已售机器失败', 'error'); }
  }, [machineSearch, selectedId]);

  useEffect(() => {
    if (!active) return;
    const timer = window.setTimeout(() => { void loadData(); }, 250);
    return () => { window.clearTimeout(timer); loadController.current?.abort(); };
  }, [active, loadData]);

  useEffect(() => {
    if (!active || !createOpen) return;
    const timer = window.setTimeout(() => { void loadSoldItems(); }, 200);
    return () => { window.clearTimeout(timer); soldController.current?.abort(); };
  }, [active, createOpen, loadSoldItems]);

  useEffect(() => {
    if (!active || (!createOpen && !selectedRecord)) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setCreateOpen(false); setSelectedRecord(null); setCancelConfirm(false); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [active, createOpen, selectedRecord]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 3800);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const selectedMachine = useMemo(() => soldItems.find((item) => item.id === selectedId), [soldItems, selectedId]);
  const selectedReplacement = replacementItems.find(item => item.id === replacementId);
  const validity = useMachineEligibility(selectedMachine && createOpen ? [selectedMachine] : [], 'after-sale');
  const replacementValidity = useMachineEligibility(selectedReplacement && selectedRecord ? [selectedReplacement] : [], 'exchange');
  useWorkspaceDirty(Boolean((createOpen && (selectedId || issueDescription || remark || issueType !== '质量问题' || resolutionType !== 'repair')) || (selectedRecord && (replacementId || handlingNote))));
  const overdueCount = summaryRecords.filter((record) => ['received', 'processing'].includes(record.status) && record.receivedAt && checkedAt - new Date(record.receivedAt.replace(' ', 'T')).getTime() > 86400000).length;
  const storedCount = summaryRecords.filter((record) => ['received', 'processing'].includes(record.status) && record.stockStatus === 'stored').length;
  const processingCount = summaryRecords.filter((record) => ['created', 'received', 'processing'].includes(record.status)).length;
  const resolvedCount = summaryRecords.filter((record) => record.status === 'resolved').length;
  const cancelledCount = summaryRecords.filter((record) => record.status === 'cancelled').length;

  const resetCreateForm = () => {
    setSelectedId(''); setIssueType('质量问题'); setIssueDescription(''); setResolutionType('repair'); setRemark(''); setMachineSearch(''); setReturnConfirmOpen(false);
  };

  const createAfterSale = async () => {
    if (!selectedMachine || !issueType.trim()) { notify('请选择已售机器并填写售后原因', 'error'); return; }
    if (validity.checking || validity.error || validity.invalidIds.length) { notify(validity.error || '所选机器已不可登记售后，请重新选择', 'error'); return; }
    setSubmitting(true);
    try {
      const response = await fetch('/api/after-sales', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ inventoryId: selectedId, issueType, issueDescription, resolutionType, remark }) });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error?.message || '创建售后单失败');
      const returnedToStock = resolutionType === 'customer_return';
      setCreateOpen(false); resetCreateForm(); setReturnConfirmOpen(false);
      if (returnedToStock) {
        setPendingPrint(payload.data?.inventoryId || selectedMachine.id);
        notify('退货退款已完成，机器已恢复正式库存');
      } else notify('售后单 ' + payload.data.afterSaleNo + ' 已创建，等待收机');
      await loadData();
    } catch (submitError) { notify(submitError instanceof Error ? submitError.message : '创建售后单失败', 'error'); } finally { setSubmitting(false); }
  };

  const submitAfterSale = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedMachine || !issueType.trim()) { notify('请选择已售机器并填写售后原因', 'error'); return; }
    if (resolutionType === 'customer_return') { setReturnConfirmOpen(true); return; }
    void createAfterSale();
  };

  const updateRecord = async (record: AfterSale, action: string) => {
    if (action === 'exchange' && !replacementId) { notify('换机前请选择替换机器', 'error'); return; }
    if (action === 'exchange' && (replacementValidity.checking || replacementValidity.error || replacementValidity.invalidIds.length)) { notify(replacementValidity.error || '替换机器状态已变化，请重新选择', 'error'); return; }
    setUpdating(true);
    try {
      const body = { id: record.id, action, replacementInventoryId: action === 'exchange' ? replacementId : undefined, resolutionNote: handlingNote.trim() || (action === 'repair_complete' ? '维修完成并归还客户' : action === 'cancel' ? '取消售后' : '售后处理'), note: handlingNote.trim() || null };
      const response = await fetch('/api/after-sales', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error?.message || '更新售后单失败');
      setSelectedRecord(null); setPendingAction(null); setCancelConfirm(false); setReplacementId(''); setHandlingNote(''); notify(record.afterSaleNo + ' 已更新');
      await loadData();
    } catch (updateError) { notify(updateError instanceof Error ? updateError.message : '更新售后单失败', 'error'); } finally { setUpdating(false); }
  };

  const statusOptions: SelectOption[] = [
    { value: 'all', label: '全部状态' }, { value: 'stored', label: '售后暂存' }, { value: 'created', label: '待收机' }, { value: 'received', label: '已收到' }, { value: 'processing', label: '处理中' }, { value: 'resolved', label: '已完成' }, { value: 'cancelled', label: '已取消' },
  ];
  const issueOptions: SelectOption[] = [
    { value: '质量问题', label: '质量问题' }, { value: '使用故障', label: '使用故障' }, { value: '外观问题', label: '外观问题' }, { value: '其他', label: '其他' },
  ];
  const resolutionOptions: SelectOption[] = [
    { value: 'customer_return', label: '退货退款' }, { value: 'exchange', label: '换货' }, { value: 'repair', label: '维修' },
  ];
  

  return <div className="mx-auto max-w-[1400px] space-y-5 pb-8 page-transition-enter">
    <header className="flex flex-wrap items-end justify-between gap-4"><div><p className="mb-1 text-[12px] font-medium uppercase tracking-[0.12em] text-primary">销售业务</p><h1 className="text-xl font-bold text-ink-deep">售后处理</h1><p className="mt-2 text-[13px] text-ink-soft">从已售机器发起，销售渠道、订单和金额自动沿用原销售记录</p></div><button type="button" onClick={() => { resetCreateForm(); setCreateOpen(true); }} className="btn-primary inline-flex items-center gap-2"><Wrench className="h-4 w-4" />登记售后</button></header>

    <section aria-label="售后统计" className="grid grid-cols-2 gap-3 lg:grid-cols-5">
      {[
        { label: '待处理', value: processingCount + ' 单', icon: Wrench, color: 'text-amber-600 bg-amber-500/10' },
        { label: '售后暂存', value: storedCount + ' 台', icon: RotateCcw, color: 'text-primary bg-primary/10' },
        { label: '超时待处理', value: overdueCount + ' 台', icon: RotateCcw, color: overdueCount ? 'text-danger bg-danger/10' : 'text-ink-soft bg-ink-soft/10' },
        { label: '已完成', value: resolvedCount + ' 单', icon: CircleCheck, color: 'text-emerald-600 bg-emerald-500/10' },
        { label: '已取消', value: cancelledCount + ' 单', icon: X, color: 'text-ink-soft bg-ink-soft/10' },
      ].map((item) => <div key={item.label} className="glass flex items-center justify-between gap-3 px-4 py-4 sm:px-5"><div><p className="text-xs text-ink-soft">{item.label}</p><p className="mt-1 text-lg font-semibold text-ink-deep">{item.value}</p></div><span className={'rounded-xl p-2.5 ' + item.color}><item.icon className="h-5 w-5" /></span></div>)}
    </section>

    <section className="glass overflow-hidden">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-line/70 px-4 py-4 sm:px-5"><div><h2 className="text-base font-semibold text-ink-deep">售后工作台</h2><p className="mt-1 text-xs text-ink-soft">暂存机器、待处理单和历史结果统一在此查询</p></div><button type="button" onClick={() => void loadData()} disabled={loading} className="btn-ghost inline-flex items-center gap-2 py-2 text-xs" title="刷新"><RotateCcw className={'h-4 w-4 ' + (loading ? 'animate-spin' : '')} />刷新</button></div>
      <div className="grid gap-3 border-b border-line/70 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_200px] sm:px-5"><MachineSearchInput value={search} onChange={setSearch} endpoint="/api/inventory/lookup?context=inventory" onSelect={item => setSearch(item.sn)} onSearch={setSearch} placeholder="搜索售后单号、SN 后四位、销售单号或渠道" ariaLabel="搜索售后记录" /><CustomSelect value={status} onChange={setStatus} options={statusOptions} placeholder="全部状态" /></div>
      {loading && records.length === 0 ? <div className="px-5 py-14 text-center text-sm text-ink-soft">正在加载售后记录...</div> : records.length === 0 ? <div className="px-5 py-14 text-center"><p className="text-sm font-medium text-ink-deep">{search || status !== 'all' ? '没有符合条件的售后记录' : '暂无售后记录'}</p><p className="mt-1 text-xs text-ink-soft">{search || status !== 'all' ? '调整关键词或状态后重试' : '登记后，售后处理进度和暂存信息会在这里跟踪'}</p></div> : <div className="divide-y divide-line/70">{records.map((record) => {
        const overdue = ['received', 'processing'].includes(record.status) && Boolean(record.receivedAt) && checkedAt - new Date(record.receivedAt!.replace(' ', 'T')).getTime() > 86400000;
        return <button type="button" key={record.id} onClick={() => { setSelectedRecord(record); setReplacementId(''); setReplacementSearch(''); setCancelConfirm(false); setHandlingNote(''); }} className="grid w-full gap-3 px-4 py-4 text-left transition-colors hover:bg-white/45 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,0.8fr)_auto] sm:items-center sm:px-5">
          <span className="min-w-0"><span className="flex flex-wrap items-center gap-2"><span className="font-mono text-sm font-semibold text-ink-deep">{record.afterSaleNo}</span><span className={'status-pill ' + statusClass(record.status)}>{statusLabel(record.status)}</span>{overdue && <span className="status-pill danger">超24小时</span>}</span><span className="mt-1 block truncate text-[13px] text-ink-deep">{productName(record)} · {record.issueType}</span><span className="mt-0.5 block truncate font-mono text-[11px] text-ink-soft">SN {record.sn} · {resolutionLabel(record.resolutionType)}</span></span>
          <span className="min-w-0 text-xs text-ink-soft"><span className="block truncate">渠道：{record.saleChannel || '未记录'}</span><span className="mt-1 block truncate">销售单：{record.salesRecordNo || record.saleOrderNo || '未关联'}</span></span>
          <span className="text-xs"><span className="block font-medium text-ink-deep">原销售价 {money(record.sellingPrice)}</span><span className="mt-1 block text-ink-soft">{record.stockStatus === 'stored' ? '机器已暂存' : '创建于 ' + (record.createdAt || '—')}</span></span>
          <span className="hidden text-xs text-primary sm:block">查看详情 →</span>
        </button>;
      })}</div>}
    </section>

    {createOpen && <ModalShell title="登记销售售后" subtitle="原销售渠道、售价和成本会随机器自动带入" onClose={() => setCreateOpen(false)} footer={<><button type="button" onClick={() => setCreateOpen(false)} className="btn-ghost">取消</button><button form="after-sale-create-form" type="submit" disabled={submitting || validity.checking || !!validity.error || validity.invalidIds.length > 0} className="btn-primary inline-flex items-center gap-2 disabled:opacity-60"><Check className="h-4 w-4" />{submitting ? '处理中...' : resolutionType === 'customer_return' ? '确认退货退款' : '创建售后单'}</button></>}>
      <form id="after-sale-create-form" onSubmit={submitAfterSale} className="space-y-5">
        <section><div className="mb-2"><h3 className="text-sm font-semibold text-ink-deep">选择已售机器 <span className="text-danger">*</span></h3><p className="mt-1 text-xs text-ink-soft">仅显示当前已售且未有进行中售后的机器</p></div><MachineSearchInput<SoldItem> value={machineSearch} onChange={setMachineSearch} endpoint="/api/inventory/lookup?context=after-sale" onSelect={item => { setSoldItems(current => [item, ...current.filter(row => row.id !== item.id)]); setSelectedId(item.id); setMachineSearch(item.sn); }} onSearch={setMachineSearch} placeholder="输入 SN 后四位、型号或销售单号" ariaLabel="搜索已售机器" /><div className="mt-2 max-h-48 overflow-y-auto rounded-xl border border-line/80 bg-white/55">{soldItems.length === 0 ? <p className="p-4 text-center text-xs text-ink-soft">暂无可登记售后的已售机器</p> : soldItems.map((item) => <button type="button" key={item.id} onClick={() => setSelectedId(item.id)} className={'flex w-full items-center justify-between gap-3 border-b border-line/70 px-3 py-3 text-left last:border-0 ' + (selectedId === item.id ? 'bg-primary/10' : 'hover:bg-white/70')}><span className="min-w-0"><span className="block truncate text-[13px] font-medium text-ink-deep">{productName(item)}</span><span className="mt-1 block truncate font-mono text-[11px] text-ink-soft">{item.sn} · {configText(item)}</span></span><span className="shrink-0 text-xs text-ink-deep">{money(item.sellingPrice)}</span></button>)}</div></section>
        {(validity.error || validity.invalidIds.length > 0) && <p role="alert" className="rounded-xl bg-danger/5 p-3 text-xs text-danger">{validity.error || '所选机器状态已变化，请重新选择。'}</p>}
        {selectedMachine && <section className="grid gap-3 rounded-xl border border-primary/15 bg-primary/5 p-3 sm:grid-cols-2"><DetailValue label="机器 SN / 配置" value={selectedMachine.sn + ' · ' + configText(selectedMachine)} /><DetailValue label="原销售单 / 渠道" value={(selectedMachine.salesRecordNo || selectedMachine.saleOrderNo || '未关联销售单') + ' · ' + (selectedMachine.saleChannel || '未记录渠道')} /><DetailValue label="原销售日期 / 售售价" value={(selectedMachine.saleDate || '—') + ' · ' + money(selectedMachine.sellingPrice)} /><DetailValue label="原采购成本" value={money(selectedMachine.purchasePrice)} /></section>}
        <section className="grid gap-3 sm:grid-cols-2"><label className="text-xs text-ink-soft">售后原因<div className="mt-1.5"><CustomSelect value={issueType} onChange={setIssueType} options={issueOptions} /></div></label><label className="text-xs text-ink-soft">处理方式<div className="mt-1.5"><CustomSelect value={resolutionType} onChange={setResolutionType} options={resolutionOptions} /></div></label><label className="text-xs text-ink-soft sm:col-span-2">问题描述<textarea value={issueDescription} onChange={(event) => setIssueDescription(event.target.value)} rows={3} className="field mt-1.5 resize-y" placeholder="记录机器故障或客户反馈" /></label><label className="text-xs text-ink-soft sm:col-span-2">备注<textarea value={remark} onChange={(event) => setRemark(event.target.value)} rows={2} className="field mt-1.5 resize-y" placeholder="可选" /></label></section>
      </form>
    </ModalShell>}

    {selectedRecord && <ModalShell title={selectedRecord.afterSaleNo} subtitle="已售机器的售后处理记录" onClose={() => { setSelectedRecord(null); setCancelConfirm(false); }} footer={['created', 'received', 'processing'].includes(selectedRecord.status) ? <><button type="button" disabled={updating} onClick={() => setPendingAction('cancel')} className="btn-ghost mr-auto text-danger">取消售后</button>{selectedRecord.status === 'created' ? <button type="button" disabled={updating} onClick={() => setPendingAction('receive')} className="btn-primary">确认收到机器</button> : <>{selectedRecord.status === 'received' && <button type="button" disabled={updating} onClick={() => setPendingAction('start_processing')} className="btn-ghost">开始处理</button>}{selectedRecord.resolutionType === 'repair' && <button type="button" disabled={updating} onClick={() => setPendingAction('repair_complete')} className="btn-primary">维修完成并归还</button>}{selectedRecord.resolutionType === 'exchange' && <button type="button" disabled={updating || !replacementId || replacementValidity.checking || !!replacementValidity.error || replacementValidity.invalidIds.length > 0} onClick={() => setPendingAction('exchange')} className="btn-primary">确认换货</button>}{selectedRecord.resolutionType === 'customer_return' && <button type="button" disabled={updating} onClick={() => setPendingAction('customer_return')} className="btn-primary">完成退货退款入库</button>}</>}</> : <button type="button" onClick={() => setSelectedRecord(null)} className="btn-primary">关闭</button>}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2"><span className={'status-pill ' + statusClass(selectedRecord.status)}>{statusLabel(selectedRecord.status)}</span><span className="status-pill info">{resolutionLabel(selectedRecord.resolutionType)}</span>{selectedRecord.stockStatus === 'stored' && <span className="status-pill warn">售后暂存</span>}</div>
        {selectedRecord.receivedAt && <p className="rounded-xl border border-line/70 bg-white/50 p-3 text-xs text-ink-soft">收机并暂存：{selectedRecord.receivedAt} · 不计入正式库存{['received','processing'].includes(selectedRecord.status) && checkedAt - new Date(selectedRecord.receivedAt.replace(' ', 'T')).getTime() > 86400000 && <span className="ml-2 font-medium text-danger">已超过24小时未完成</span>}</p>}
        <section className="grid gap-3 sm:grid-cols-2"><DetailValue label="机器型号 / SN" value={productName(selectedRecord) + ' · ' + selectedRecord.sn} /><DetailValue label="配置" value={configText({ cpu: selectedRecord.cpu || '', ram: selectedRecord.ram || '', storage: selectedRecord.storage || '', gpu: selectedRecord.gpu, screen: selectedRecord.screen })} /><DetailValue label="销售单 / 渠道" value={(selectedRecord.salesRecordNo || selectedRecord.saleOrderNo || '未关联销售单') + ' · ' + (selectedRecord.saleChannel || '未记录渠道')} /><DetailValue label="原销售价 / 原采购成本" value={money(selectedRecord.sellingPrice) + ' / ' + money(selectedRecord.purchasePrice)} /><DetailValue label="售后原因 / 创建时间" value={selectedRecord.issueType + ' · ' + selectedRecord.createdAt} /><DetailValue label="替换机器" value={selectedRecord.replacementInventoryId || '—'} /></section>
        <section className="rounded-xl border border-line/80 bg-white/45 p-4"><h3 className="text-sm font-semibold text-ink-deep">问题与处理记录</h3><p className="mt-3 whitespace-pre-wrap text-[13px] leading-6 text-ink-soft">{selectedRecord.issueDescription || '未填写问题描述'}</p>{selectedRecord.resolutionNote && <p className="mt-3 rounded-lg bg-primary/5 px-3 py-2 text-xs text-ink-deep">处理备注：{selectedRecord.resolutionNote}</p>}</section>
        {['received', 'processing'].includes(selectedRecord.status) && selectedRecord.resolutionType === 'exchange' && <section className="rounded-xl border border-primary/15 bg-primary/5 p-4"><h3 className="text-sm font-semibold text-ink-deep">选择换货机器</h3><p className="mt-1 text-xs text-ink-soft">替换机器将按原销售渠道和售价关联到原销售记录。</p><label className="mt-3 block text-xs text-ink-soft">在库替换机器<div className="mt-1.5"><MachineSearchInput<ReplacementItem> value={replacementSearch} onChange={setReplacementSearch} endpoint="/api/inventory/lookup?context=exchange" onSelect={item => { setReplacementItems(current => [item, ...current.filter(row => row.id !== item.id)]); setReplacementId(item.id); setReplacementSearch(item.sn); }} ariaLabel="搜索换货替换机器" /></div></label>{selectedReplacement && <p className="mt-2 text-xs text-ink-deep">已选择：{productName(selectedReplacement)} · {selectedReplacement.sn}<button type="button" className="ml-2 text-primary" onClick={() => { setReplacementId(''); setReplacementSearch(''); }}>取消选择</button></p>}{(replacementValidity.error || replacementValidity.invalidIds.length > 0) && <p role="alert" className="mt-2 text-xs text-danger">{replacementValidity.error || '替换机器已不可用，请重新选择。'}</p>}</section>}
        {['received', 'processing'].includes(selectedRecord.status) && selectedRecord.resolutionType === 'customer_return' && <p className="rounded-xl border border-primary/15 bg-primary/5 p-4 text-xs leading-5 text-ink-soft">退货退款将沿用原销售记录、原采购成本和原仓库恢复正式库存，随后可打印库存标签。</p>}
        {selectedRecord.status === 'resolved' && <section className="rounded-xl border border-success/15 bg-success/5 p-4"><h3 className="text-sm font-semibold text-ink-deep">处理已完成</h3><p className="mt-1 text-xs text-ink-soft">{resolutionLabel(selectedRecord.resolutionType)} · {selectedRecord.resolutionNote || '已完成'}</p></section>}
        {cancelConfirm && selectedRecord.status === 'processing' && <p className="rounded-lg border border-danger/15 bg-danger/5 px-3 py-2 text-xs text-danger">确认取消此售后单？取消后原机器将恢复为已售状态。</p>}
      </div>
    </ModalShell>}

    <ConfirmDialog isOpen={!!pendingAction} title={({ receive: '确认收到售后机器', start_processing: '开始售后处理', repair_complete: '维修完成并归还客户', customer_return: '确认完成退货退款', exchange: '确认完成换货', cancel: '取消售后' } as Record<string, string>)[pendingAction || ''] || '确认处理'} message={pendingAction === 'receive' ? '机器将进入售后暂存，开始计算24小时处理提醒，不计入正式库存。' : pendingAction === 'exchange' ? '原售后机器完成处理，选中的替换机器将沿用原销售记录出库给客户。' : pendingAction === 'customer_return' ? '机器将沿用原采购成本和仓库恢复正式库存，销售来源记录保留。' : pendingAction === 'repair_complete' ? '确认维修已完成，机器归还客户并恢复已售状态？' : pendingAction === 'cancel' ? '确认取消售后？原机器将恢复为已售状态，暂存记录保留。' : '确认开始处理此售后单？'} confirmText={updating ? '处理中...' : '确认'} cancelText="返回" danger={pendingAction === 'cancel'} onConfirm={() => { if (selectedRecord && pendingAction && !updating) void updateRecord(selectedRecord, pendingAction); }} onCancel={() => setPendingAction(null)} />
    <ConfirmDialog isOpen={returnConfirmOpen} title="确认退货退款并入库" message={selectedMachine ? `${productName(selectedMachine)}（SN ${selectedMachine.sn}）将沿用原销售记录和采购成本，直接恢复到原仓库。` : ''} confirmText={submitting ? '处理中...' : '确认退货退款'} cancelText="返回修改" onConfirm={() => { if (!submitting) void createAfterSale(); }} onCancel={() => { if (!submitting) setReturnConfirmOpen(false); }} />
    <ConfirmDialog isOpen={Boolean(pendingPrint)} title="打印库存标签" message="退货退款已入库，是否使用默认标签样式立即打印？" confirmText={printing ? '准备打印...' : '立即打印'} cancelText="稍后打印" onConfirm={() => { if (!printing && pendingPrint) void printLabels([pendingPrint]).then(() => setPendingPrint(null)).catch((error) => { notify(error instanceof Error ? error.message : '打印失败，请重试', 'error'); setPendingPrint(null); }); }} onCancel={() => { if (!printing) setPendingPrint(null); }} />
    {toast && <div role="status" aria-live="polite" className={'fixed bottom-5 right-5 z-[120] flex max-w-[calc(100vw-2.5rem)] items-center gap-3 rounded-xl border px-4 py-3 text-sm shadow-lg backdrop-blur-xl ' + (toast.tone === 'error' ? 'border-danger/20 bg-white/95 text-danger' : 'border-success/20 bg-white/95 text-success')}><span>{toast.text}</span><button type="button" onClick={() => setToast(null)} aria-label="关闭提示"><X className="h-4 w-4" /></button></div>}
    {printPortal}
  </div>;
}

function DetailValue({ label, value }: { label: string; value: string }) {
  return <div className="rounded-xl border border-line/70 bg-white/35 px-3 py-2.5"><p className="text-[11px] text-ink-soft">{label}</p><p className="mt-1 break-words text-[13px] text-ink-deep">{value}</p></div>;
}

