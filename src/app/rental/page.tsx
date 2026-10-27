'use client';

import { FormEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArchiveRestore, Check, Clock3, RotateCcw, X } from 'lucide-react';
import CustomSelect, { SelectOption } from '@/components/CustomSelect';
import BusinessDialog from '@/components/BusinessDialog';
import MachineSearchInput from '@/components/MachineSearchInput';
import { useWorkspace, useWorkspaceDirty } from '@/components/WorkspaceContext';
import { useMachineEligibility } from '@/components/useMachineEligibility';
import { formatProductName } from '@/lib/product-name';

type InventoryItem = { id: string; sn: string; brand: string; model: string; year: number | null; cpu: string; ram: string; storage: string; purchasePrice: number; supplierName: string };
type Rental = { id: string; rentalNo: string; inventoryId: string; sn: string; brand: string; model: string; year: number | null; config: string; customerName: string; customerPhone: string; customerAddress: string; rentalStartDate: string; rentalEndDate: string; rentalType: string; rentalUnitPrice: number; rentalDuration: number; rentalTotalPrice: number; deposit: number; status: string; returnDate: string | null; returnType: string | null; remark: string | null };
type ToastMessage = { text: string; tone: 'success' | 'error' };

function dateInput(offset = 0) {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function dueLabel(rental: Rental) { if (rental.status !== 'renting') return ''; const days = Math.ceil((new Date(rental.rentalEndDate + 'T00:00:00').getTime() - new Date(dateInput() + 'T00:00:00').getTime()) / 86400000); return days < 0 ? '已逾期 ' + (-days) + ' 天' : days === 0 ? '今日到期' : days <= 3 ? days + ' 天内到期' : ''; }

function money(value: number) { return '¥' + Number(value || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function configText(item: Pick<InventoryItem, 'cpu' | 'ram' | 'storage'>) { return [item.cpu, item.ram, item.storage].filter(Boolean).join(' · ') || '配置待补充'; }
function productName(item: { brand: string; model: string; year?: number | null }) { return formatProductName(item); }

function ModalShell({ title, subtitle, onClose, children, footer }: { title: string; subtitle?: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  return <BusinessDialog title={title} description={subtitle} onClose={onClose} footer={footer}>{children}</BusinessDialog>;
}

export default function RentalPage() {
  const { active } = useWorkspace();
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [rentals, setRentals] = useState<Rental[]>([]);
  const [summaryRentals, setSummaryRentals] = useState<Rental[]>([]);
  const [search, setSearch] = useState('');
  const [machineSearch, setMachineSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [selectedId, setSelectedId] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [customerAddress, setCustomerAddress] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [rentalType, setRentalType] = useState('day');
  const [unitPrice, setUnitPrice] = useState('');
  const [deposit, setDeposit] = useState('');
  const [remark, setRemark] = useState('');
  const [returnDate, setReturnDate] = useState('');
  const [returnType, setReturnType] = useState('正常归还');
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedRental, setSelectedRental] = useState<Rental | null>(null);
  const [returnOpen, setReturnOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [returning, setReturning] = useState(false);
  const [toast, setToast] = useState<ToastMessage | null>(null);

  const notify = (text: string, tone: ToastMessage['tone'] = 'success') => setToast({ text, tone });

  useEffect(() => {
    setStartDate((value) => value || dateInput());
    setEndDate((value) => value || dateInput(1));
    setReturnDate((value) => value || dateInput());
  }, []);

  const loadController = useRef<AbortController | null>(null);
  const loadData = useCallback(async () => {
    loadController.current?.abort(); const controller = new AbortController(); loadController.current = controller;
    setLoading(true);
    try {
      const inventoryUrl = '/api/inventory/lookup?context=rental&q=' + encodeURIComponent(machineSearch) + '&limit=100';
      const recordUrl = '/api/rentals?status=' + encodeURIComponent(status) + '&search=' + encodeURIComponent(search) + '&pageSize=100';
      const summaryUrl = '/api/rentals?status=all&pageSize=100';
      const [inventoryResponse, rentalsResponse, summaryResponse] = await Promise.all([
        fetch(inventoryUrl, { cache: 'no-store', signal: controller.signal }),
        fetch(recordUrl, { cache: 'no-store', signal: controller.signal }),
        fetch(summaryUrl, { cache: 'no-store', signal: controller.signal }),
      ]);
      const inventoryPayload = await inventoryResponse.json();
      const rentalsPayload = await rentalsResponse.json();
      const summaryPayload = await summaryResponse.json();
      if (!inventoryResponse.ok || !inventoryPayload.success) throw new Error(inventoryPayload.error?.message || '加载可租机器失败');
      if (!rentalsResponse.ok || !rentalsPayload.success) throw new Error(rentalsPayload.error?.message || '加载租赁记录失败');
      if (!summaryResponse.ok || !summaryPayload.success) throw new Error(summaryPayload.error?.message || '加载租赁统计失败');
      const summaryPageCount = Number(summaryPayload.data?.totalPages || 1);
      const summaryPageResponses = await Promise.all(Array.from({ length: Math.max(0, summaryPageCount - 1) }, (_, index) => fetch('/api/rentals?status=all&pageSize=100&page=' + (index + 2), { cache: 'no-store', signal: controller.signal })));
      const summaryPagePayloads = await Promise.all(summaryPageResponses.map((response) => response.json()));
      const failedSummaryPage = summaryPageResponses.findIndex((response, index) => !response.ok || !summaryPagePayloads[index]?.success);
      if (failedSummaryPage !== -1) throw new Error(summaryPagePayloads[failedSummaryPage]?.error?.message || '加载租赁统计失败');
      setInventory(current => { const next: InventoryItem[] = inventoryPayload.data?.items || []; return [...next, ...current.filter(item => item.id === selectedId && !next.some(row => row.id === item.id))]; });
      setRentals(rentalsPayload.data?.items || []);
      setSummaryRentals([...(summaryPayload.data?.items || []), ...summaryPagePayloads.flatMap((payload) => payload.data?.items || [])]);
    } catch (loadError) {
      if (!controller.signal.aborted) notify(loadError instanceof Error ? loadError.message : '加载租赁数据失败', 'error');
    } finally { if (!controller.signal.aborted) setLoading(false); }
  }, [machineSearch, search, status, selectedId]);

  useEffect(() => {
    if (!active) return;
    const timer = window.setTimeout(() => { void loadData(); }, 250);
    return () => { window.clearTimeout(timer); loadController.current?.abort(); };
  }, [active, loadData]);

  useEffect(() => {
    if (!active || (!createOpen && !selectedRental)) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setCreateOpen(false); setSelectedRental(null); setReturnOpen(false); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [active, createOpen, selectedRental]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 3800);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const selectedMachine = useMemo(() => inventory.find((item) => item.id === selectedId), [inventory, selectedId]);
  const validity = useMachineEligibility(selectedMachine && createOpen ? [selectedMachine] : [], 'rental');
  useWorkspaceDirty(Boolean((createOpen && (selectedId || customerName || customerPhone || customerAddress || unitPrice || deposit || remark || rentalType !== 'day')) || returnOpen));
  const duration = useMemo(() => {
    const start = new Date(startDate + 'T00:00:00').getTime();
    const end = new Date(endDate + 'T00:00:00').getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
    if (rentalType === 'month') {
      const s = new Date(start); const e = new Date(end);
      return Math.max(1, (e.getFullYear() - s.getFullYear()) * 12 + e.getMonth() - s.getMonth() + (e.getDate() >= s.getDate() ? 1 : 0));
    }
    return Math.max(1, Math.floor((end - start) / 86400000) + 1);
  }, [startDate, endDate, rentalType]);
  const totalPrice = duration * (Number(unitPrice) || 0);
  const rentingCount = summaryRentals.filter((rental) => rental.status === 'renting').length;
  const returnedCount = summaryRentals.filter((rental) => rental.status === 'returned').length;
  const activeDeposit = summaryRentals.filter((rental) => rental.status === 'renting').reduce((sum, rental) => sum + Number(rental.deposit || 0), 0);
  const activeRent = summaryRentals.filter((rental) => rental.status === 'renting').reduce((sum, rental) => sum + Number(rental.rentalTotalPrice || 0), 0);

  const resetCreateForm = () => {
    setSelectedId(''); setCustomerName(''); setCustomerPhone(''); setCustomerAddress(''); setStartDate(dateInput()); setEndDate(dateInput(1)); setRentalType('day'); setUnitPrice(''); setDeposit(''); setRemark(''); setMachineSearch('');
  };

  const submitRental = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedId) { notify('请选择一台可租机器', 'error'); return; }
    if (validity.checking || validity.error || validity.invalidIds.length) { notify(validity.error || '所选机器已不可租赁，请重新选择', 'error'); return; }
    setSubmitting(true);
    try {
      const response = await fetch('/api/rentals', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ inventoryId: selectedId, customerName, customerPhone, customerAddress, rentalStartDate: startDate, rentalEndDate: endDate, rentalType, rentalUnitPrice: Number(unitPrice), deposit: Number(deposit || 0), remark }) });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error?.message || '创建租赁记录失败');
      setCreateOpen(false); resetCreateForm(); notify('租赁单 ' + payload.data.rentalNo + ' 已创建');
      await loadData();
    } catch (submitError) { notify(submitError instanceof Error ? submitError.message : '创建租赁记录失败', 'error'); } finally { setSubmitting(false); }
  };

  const completeReturn = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedRental) return;
    setReturning(true);
    try {
      const response = await fetch('/api/rentals', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: selectedRental.id, action: 'return', returnDate, returnType }) });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error?.message || '归还失败');
      const rentalNo = selectedRental.rentalNo;
      setSelectedRental(null); setReturnOpen(false); notify('租赁单 ' + rentalNo + ' 已归还');
      await loadData();
    } catch (returnError) { notify(returnError instanceof Error ? returnError.message : '归还失败', 'error'); } finally { setReturning(false); }
  };

  const statusOptions: SelectOption[] = [
    { value: 'all', label: '全部状态' }, { value: 'renting', label: '租赁中' }, { value: 'returned', label: '已归还' },
  ];
  const typeOptions: SelectOption[] = [
    { value: 'day', label: '按日计费' }, { value: 'month', label: '按月计费' },
  ];
  const returnOptions: SelectOption[] = [
    { value: '正常归还', label: '正常归还' }, { value: '维修归还', label: '维修归还' }, { value: '其他', label: '其他' },
  ];

  return <div className="mx-auto max-w-[1400px] space-y-5 pb-8">
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div><p className="mb-1 text-[12px] font-medium uppercase tracking-[0.12em] text-primary">库存业务</p><h1 className="text-xl font-bold text-ink-deep">租赁管理</h1><p className="mt-2 text-[13px] text-ink-soft">维护租赁记录、收款周期与机器归还</p></div>
      <button type="button" onClick={() => { resetCreateForm(); setCreateOpen(true); }} className="btn-primary inline-flex items-center gap-2"><Check className="h-4 w-4" />新建租赁</button>
    </header>

    <section aria-label="租赁统计" className="grid grid-cols-2 gap-3 xl:grid-cols-4">
      {[
        { label: '租赁中', value: rentingCount + ' 台', icon: Clock3, color: 'text-amber-600 bg-amber-500/10' },
        { label: '已归还', value: returnedCount + ' 台', icon: RotateCcw, color: 'text-emerald-600 bg-emerald-500/10' },
        { label: '在租押金', value: money(activeDeposit), icon: ArchiveRestore, color: 'text-primary bg-primary/10' },
        { label: '预计租金', value: money(activeRent), icon: Check, color: 'text-indigo-600 bg-indigo-500/10' },
      ].map((item) => <div key={item.label} className="glass flex items-center justify-between gap-3 px-4 py-4 sm:px-5"><div><p className="text-xs text-ink-soft">{item.label}</p><p className="mt-1 text-lg font-semibold text-ink-deep">{item.value}</p></div><span className={'rounded-xl p-2.5 ' + item.color}><item.icon className="h-5 w-5" /></span></div>)}
    </section>

    <section className="glass overflow-hidden">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-line/70 px-4 py-4 sm:px-5">
        <div><h2 className="text-base font-semibold text-ink-deep">租赁记录</h2><p className="mt-1 text-xs text-ink-soft">共 {rentals.length} 条当前结果，选择记录查看详情</p></div>
        <button type="button" onClick={() => void loadData()} disabled={loading} className="btn-ghost inline-flex items-center gap-2 py-2 text-xs" title="刷新"><RotateCcw className={'h-4 w-4 ' + (loading ? 'animate-spin' : '')} />刷新</button>
      </div>
      <div className="grid gap-3 border-b border-line/70 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_200px] sm:px-5">
        <MachineSearchInput value={search} onChange={setSearch} endpoint="/api/inventory/lookup?context=inventory" onSelect={item => setSearch(item.sn)} onSearch={setSearch} placeholder="搜索租赁单号、SN 后四位、型号或客户" ariaLabel="搜索租赁记录" />
        <CustomSelect value={status} onChange={setStatus} options={statusOptions} placeholder="全部状态" />
      </div>
      {loading && rentals.length === 0 ? <div className="px-5 py-14 text-center text-sm text-ink-soft">正在加载租赁记录...</div> : rentals.length === 0 ? <div className="px-5 py-14 text-center"><p className="text-sm font-medium text-ink-deep">{search || status !== 'all' ? '没有符合条件的租赁记录' : '暂无租赁记录'}</p><p className="mt-1 text-xs text-ink-soft">{search || status !== 'all' ? '调整关键词或状态后重试' : '创建租赁后，机器和归还状态会在这里跟踪'}</p></div> : <div className="divide-y divide-line/70">
        {rentals.map((rental) => <button type="button" key={rental.id} onClick={() => { setSelectedRental(rental); setReturnOpen(false); }} className="grid w-full gap-3 px-4 py-4 text-left transition-colors hover:bg-white/45 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-center sm:px-5">
          <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="font-mono text-sm font-semibold text-ink-deep">{rental.rentalNo}</span><span className={'status-pill ' + (rental.status === 'renting' ? 'warn' : 'ok')}>{rental.status === 'renting' ? '租赁中' : '已归还'}</span>{dueLabel(rental) && <span className={'status-pill ' + (dueLabel(rental).startsWith('已逾期') || dueLabel(rental) === '今日到期' ? 'danger' : 'warn')}>{dueLabel(rental)}</span>}</div><p className="mt-1 truncate text-[13px] text-ink-deep">{productName(rental)}</p><p className="mt-0.5 truncate font-mono text-[11px] text-ink-soft">{rental.sn} · {rental.config || '配置待补充'}</p></div>
          <div className="text-xs text-ink-soft"><p>{rental.customerName} · {rental.customerPhone}</p><p className="mt-1">{rental.rentalStartDate} 至 {rental.rentalEndDate}</p></div>
          <div className="text-xs"><p className="font-medium text-ink-deep">{money(rental.rentalTotalPrice)} <span className="font-normal text-ink-soft">/ {rental.rentalDuration}{rental.rentalType === 'month' ? '月' : '日'}</span></p><p className="mt-1 text-ink-soft">押金 {money(rental.deposit)}</p></div>
          <span className="hidden text-xs text-primary sm:block">查看详情 →</span>
        </button>)}
      </div>}
    </section>

    {createOpen && <ModalShell title="新建租赁" subtitle="选择一台在库机器，并填写客户和租赁周期" onClose={() => setCreateOpen(false)} footer={<><button type="button" onClick={() => setCreateOpen(false)} className="btn-ghost">取消</button><button form="rental-create-form" type="submit" disabled={submitting || validity.checking || !!validity.error || validity.invalidIds.length > 0} className="btn-primary inline-flex items-center gap-2 disabled:opacity-60"><Check className="h-4 w-4" />{submitting ? '提交中...' : '开始租赁'}</button></>}>
      <form id="rental-create-form" onSubmit={submitRental} className="space-y-5">
        <section><div className="mb-2 flex items-center justify-between gap-3"><div><h3 className="text-sm font-semibold text-ink-deep">选择在库机器 <span className="text-danger">*</span></h3><p className="mt-1 text-xs text-ink-soft">仅显示当前可租机器</p></div>{selectedMachine && <span className="status-pill ok">已选</span>}</div>
          <MachineSearchInput<InventoryItem> value={machineSearch} onChange={setMachineSearch} endpoint="/api/inventory/lookup?context=rental" onSelect={item => { setInventory(current => [item, ...current.filter(row => row.id !== item.id)]); setSelectedId(item.id); setMachineSearch(item.sn); }} onSearch={setMachineSearch} ariaLabel="搜索可租机器" />
          <div className="mt-2 max-h-48 overflow-y-auto rounded-xl border border-line/80 bg-white/55">{inventory.length === 0 ? <p className="p-4 text-center text-xs text-ink-soft">暂无可租机器</p> : inventory.map((item) => <button type="button" key={item.id} onClick={() => setSelectedId(item.id)} className={'flex w-full items-center justify-between gap-3 border-b border-line/70 px-3 py-3 text-left last:border-0 ' + (selectedId === item.id ? 'bg-primary/10' : 'hover:bg-white/70')}><span className="min-w-0"><span className="block truncate text-[13px] font-medium text-ink-deep">{productName(item)}</span><span className="mt-1 block truncate font-mono text-[11px] text-ink-soft">{item.sn} · {configText(item)}</span></span><span className="shrink-0 text-xs text-ink-deep">{money(item.purchasePrice)}</span></button>)}</div>
        </section>
        {(validity.error || validity.invalidIds.length > 0) && <p role="alert" className="rounded-xl bg-danger/5 p-3 text-xs text-danger">{validity.error || '所选机器状态已变化，请重新选择机器。'}</p>}
        {selectedMachine && <div className="rounded-xl border border-primary/15 bg-primary/5 px-3 py-2.5 text-xs text-ink-deep">已选择：{productName(selectedMachine)} · {selectedMachine.sn}</div>}
        <section className="grid gap-3 sm:grid-cols-2">
          <label className="text-xs text-ink-soft">客户姓名 <span className="text-danger">*</span><input value={customerName} onChange={(event) => setCustomerName(event.target.value)} className="field mt-1.5" required /></label>
          <label className="text-xs text-ink-soft">联系电话 <span className="text-danger">*</span><input type="tel" value={customerPhone} onChange={(event) => setCustomerPhone(event.target.value)} className="field mt-1.5" required /></label>
          <label className="text-xs text-ink-soft sm:col-span-2">客户地址 <span className="text-danger">*</span><input value={customerAddress} onChange={(event) => setCustomerAddress(event.target.value)} className="field mt-1.5" required /></label>
          <label className="text-xs text-ink-soft">开始日期<input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} className="field mt-1.5" required /></label>
          <label className="text-xs text-ink-soft">结束日期<input type="date" value={endDate} min={startDate} onChange={(event) => setEndDate(event.target.value)} className="field mt-1.5" required /></label>
          <label className="text-xs text-ink-soft">计费方式<div className="mt-1.5"><CustomSelect value={rentalType} onChange={setRentalType} options={typeOptions} /></div></label>
          <label className="text-xs text-ink-soft">单价<input type="number" min="0.01" step="0.01" value={unitPrice} onChange={(event) => setUnitPrice(event.target.value)} className="field mt-1.5" required /></label>
          <label className="text-xs text-ink-soft">押金<input type="number" min="0" step="0.01" value={deposit} onChange={(event) => setDeposit(event.target.value)} className="field mt-1.5" placeholder="0.00" /></label>
          <label className="text-xs text-ink-soft">备注<input value={remark} onChange={(event) => setRemark(event.target.value)} className="field mt-1.5" /></label>
        </section>
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-primary/5 px-4 py-3"><span className="text-xs text-ink-soft">预计 {duration || '-'} 个{rentalType === 'month' ? '月' : '日'}计费单位</span><span className="text-xs text-ink-soft">预计租金 <b className="ml-1 font-mono text-sm text-ink-deep">{money(totalPrice)}</b></span></div>
      </form>
    </ModalShell>}

    {selectedRental && <ModalShell title={selectedRental.rentalNo} subtitle="租赁详情" onClose={() => { setSelectedRental(null); setReturnOpen(false); }} footer={selectedRental.status === 'renting' && !returnOpen ? <><button type="button" onClick={() => setSelectedRental(null)} className="btn-ghost">关闭</button><button type="button" onClick={() => { setReturnDate(dateInput()); setReturnOpen(true); }} className="btn-primary inline-flex items-center gap-2"><RotateCcw className="h-4 w-4" />完成归还</button></> : returnOpen ? <><button type="button" onClick={() => setReturnOpen(false)} className="btn-ghost">返回详情</button><button form="rental-return-form" type="submit" disabled={returning} className="btn-primary inline-flex items-center gap-2 disabled:opacity-60"><Check className="h-4 w-4" />{returning ? '处理中...' : '确认归还'}</button></> : <button type="button" onClick={() => setSelectedRental(null)} className="btn-primary">关闭</button>}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2"><span className={'status-pill ' + (selectedRental.status === 'renting' ? 'warn' : 'ok')}>{selectedRental.status === 'renting' ? '租赁中' : '已归还'}</span>{dueLabel(selectedRental) && <span className="status-pill danger">{dueLabel(selectedRental)}</span>}<span className="font-mono text-xs text-ink-soft">SN：{selectedRental.sn}</span></div>
        <section className="rounded-xl border border-line/80 bg-white/45 p-4"><h3 className="text-sm font-semibold text-ink-deep">机器信息</h3><p className="mt-2 text-sm text-ink-deep">{productName(selectedRental)}</p><p className="mt-1 text-xs text-ink-soft">{selectedRental.config || '配置待补充'}</p></section>
        <section className="grid gap-3 sm:grid-cols-2"><DetailValue label="客户" value={selectedRental.customerName + ' · ' + selectedRental.customerPhone} /><DetailValue label="地址" value={selectedRental.customerAddress || '未填写'} /><DetailValue label="租赁周期" value={selectedRental.rentalStartDate + ' 至 ' + selectedRental.rentalEndDate} /><DetailValue label="计费方式" value={(selectedRental.rentalType === 'month' ? '按月' : '按日') + ' · ' + selectedRental.rentalDuration + ' 个单位'} /><DetailValue label="租赁单价" value={money(selectedRental.rentalUnitPrice)} /><DetailValue label="预计租金" value={money(selectedRental.rentalTotalPrice)} /><DetailValue label="押金" value={money(selectedRental.deposit)} /><DetailValue label="备注" value={selectedRental.remark || '无'} /></section>
        {selectedRental.status === 'returned' && <section className="rounded-xl border border-success/15 bg-success/5 p-4"><h3 className="text-sm font-semibold text-ink-deep">归还信息</h3><p className="mt-2 text-xs text-ink-soft">{selectedRental.returnDate || '日期未记录'} · {selectedRental.returnType || '归还方式未记录'}</p></section>}
        {returnOpen && <form id="rental-return-form" onSubmit={completeReturn} className="rounded-xl border border-primary/20 bg-primary/5 p-4"><h3 className="text-sm font-semibold text-ink-deep">确认机器归还</h3><p className="mt-1 text-xs text-ink-soft">确认后机器将恢复为在库状态。</p><div className="mt-4 grid gap-3 sm:grid-cols-2"><label className="text-xs text-ink-soft">归还日期<input type="date" value={returnDate} onChange={(event) => setReturnDate(event.target.value)} className="field mt-1.5" required /></label><label className="text-xs text-ink-soft">归还方式<div className="mt-1.5"><CustomSelect value={returnType} onChange={setReturnType} options={returnOptions} /></div></label></div></form>}
      </div>
    </ModalShell>}

    {toast && <div role="status" aria-live="polite" className={'fixed bottom-5 right-5 z-[120] flex max-w-[calc(100vw-2.5rem)] items-center gap-3 rounded-xl border px-4 py-3 text-sm shadow-lg backdrop-blur-xl ' + (toast.tone === 'error' ? 'border-danger/20 bg-white/95 text-danger' : 'border-success/20 bg-white/95 text-success')}><span>{toast.text}</span><button type="button" onClick={() => setToast(null)} aria-label="关闭提示"><X className="h-4 w-4" /></button></div>}
  </div>;
}

function DetailValue({ label, value }: { label: string; value: string }) {
  return <div className="rounded-xl border border-line/70 bg-white/35 px-3 py-2.5"><p className="text-[11px] text-ink-soft">{label}</p><p className="mt-1 break-words text-[13px] text-ink-deep">{value}</p></div>;
}
