"use client";

import Link from "next/link";
import { createPortal } from "react-dom";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { AlertCircle, ArrowRight, Check, CheckCheck, ClipboardList, History, LoaderCircle, PackageCheck, Plus, RefreshCw, ScanLine, Trash2, Truck, X } from "lucide-react";
import CustomSelect from "@/components/CustomSelect";
import ConfirmDialog from "@/components/ConfirmDialog";
import MachineSearchInput from "@/components/MachineSearchInput";
import { useWorkspace, useWorkspaceDirty } from "@/components/WorkspaceContext";
import { useMachineEligibility } from "@/components/useMachineEligibility";

interface InventoryItem {
  id: string;
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
  supplierName: string;
  inboundDate: string;
  skuRemark: string | null;
}

interface SalesChannel { id: string; channelName: string; channelType: string | null }
interface SelectedItem { item: InventoryItem; sellingPrice: string; remark: string }
interface SaleRecord {
  id: string;
  recordNo: string;
  saleChannel: string;
  saleOrderNo: string;
  saleDate: string;
  trackingNo: string | null;
  totalQuantity: number;
  totalAmount: number;
  totalCost: number;
  totalProfit: number;
  status: string;
  cancelReason?: string | null;
  cancelledAt?: string | null;
  remark?: string | null;
  items: Array<{ inventoryId: string; brand: string; model: string; year?: number | null; sn: string; sellingPrice: number; purchasePrice: number; profit: number; cpu?: string; ram?: string; storage?: string; gpu?: string; screen?: string; remark?: string | null }>;
}
interface SalesResponse { items: InventoryItem[]; channels: SalesChannel[]; records?: SaleRecord[] }

function today() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function money(value: number) {
  return `¥${Number(value || 0).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function productName(item: { brand: string; model: string; year?: number | null }) {
  const brand = item.brand?.trim() || "";
  const model = item.model?.trim() || "";
  const fullName = model.toLowerCase().startsWith(brand.toLowerCase()) ? model : [brand, model].filter(Boolean).join(" ");
  const year = item.year && !fullName.includes(String(item.year)) ? String(item.year) : "";
  return [fullName, year].filter(Boolean).join(" ") || "未命名商品";
}
function configText(item: InventoryItem) {
  return [item.cpu, item.ram, item.storage, item.gpu, item.screen, item.touchScreen ? "触屏" : "", item.skuRemark].filter(Boolean).join(" / ") || "未填写配置";
}
function validPrice(value: string) {
  return value.trim() !== "" && Number.isFinite(Number(value)) && Number(value) >= 0;
}
async function fetchSalesData(search = "", signal?: AbortSignal): Promise<SalesResponse> {
  const params = new URLSearchParams({ limit: "100" });
  if (search.trim()) params.set("search", search.trim());
  const response = await fetch(`/api/sales?${params}`, { cache: "no-store", signal });
  const result = await response.json();
  if (!response.ok || !result.success) throw new Error(result.error?.message || "加载销售出库数据失败");
  return result.data as SalesResponse;
}

async function fetchSaleMachines(search = "", signal?: AbortSignal): Promise<InventoryItem[]> {
  const params = new URLSearchParams({ context: "sale", q: search, limit: "100" });
  const response = await fetch("/api/inventory/lookup?" + params, { cache: "no-store", signal });
  const payload = await response.json();
  if (!response.ok || !payload.success) throw new Error(payload.error?.message || "搜索机器失败");
  return payload.data?.items || [];
}

/** Page-owned modal: escape the application's animated scroll container. */
function SalesDialog({ title, subtitle, onClose, children, footer, wide = false, busy = false }: {
  title: string; subtitle?: string; onClose: () => void; children: ReactNode; footer: ReactNode; wide?: boolean; busy?: boolean;
}) {
  const { active, user, activeRef } = useWorkspace();
  const titleId = useId();
  const [mounted, setMounted] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const busyRef = useRef(busy);
  useEffect(() => { closeRef.current = onClose; busyRef.current = busy; }, [onClose, busy]);
  useEffect(() => { setMounted(true); }, []);
  useEffect(() => {
    if (!mounted || !active) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusable = () => Array.from(panel?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), [tabindex="0"]') || []);
    (panel?.querySelector<HTMLElement>("[data-initial-focus]") || focusable()[0] || panel)?.focus();
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyRef.current) { event.preventDefault(); closeRef.current(); }
      if (event.key !== "Tab") return;
      const elements = focusable();
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (!first) { event.preventDefault(); panel?.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", keyDown);
    return () => {
      document.removeEventListener("keydown", keyDown);
      document.body.style.overflow = previousOverflow;
      if (activeRef.current && previousFocus?.isConnected) previousFocus.focus();
    };
  }, [mounted, active]);
  if (!mounted || !active) return null;
  return createPortal(
    <div style={{ top: user ? 100 : 0 }} className="fixed inset-0 z-[10000] flex items-center justify-center bg-ink-deep/25 p-3 backdrop-blur-sm animate-fade-in sm:p-6" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <div ref={panelRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-busy={busy} className={`flex max-h-[calc(100dvh-124px)] w-full min-w-0 flex-col overflow-hidden rounded-2xl border border-white bg-[#f8fbff] shadow-xl outline-none animate-scale-in ${wide ? "max-w-5xl" : "max-w-lg"}`}>
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-line-strong/70 bg-white/80 px-5 py-4">
          <div><h2 id={titleId} className="text-[16px] font-semibold text-ink-deep">{title}</h2>{subtitle && <p className="mt-1 text-[12px] text-ink-soft">{subtitle}</p>}</div>
          <button type="button" disabled={busy} onClick={onClose} aria-label="关闭弹窗" className="shrink-0 rounded-lg p-1.5 text-ink-soft transition hover:bg-primary/8 hover:text-ink-deep active:scale-95"><X className="h-4 w-4" /></button>
        </header>
        <div className="min-h-0 overflow-y-auto overscroll-contain p-4 sm:p-5">{children}</div>
        <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-line-strong/70 bg-white/90 px-4 py-3 sm:px-5">{footer}</footer>
      </div>
    </div>, document.body,
  );
}

export default function SalesOutPage() {
  const { active } = useWorkspace();
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [channels, setChannels] = useState<SalesChannel[]>([]);
  const [records, setRecords] = useState<SaleRecord[]>([]);
  const [selected, setSelected] = useState<Record<string, SelectedItem>>({});
  const [saleChannelId, setSaleChannelId] = useState("");
  const [baselineChannel, setBaselineChannel] = useState("");
  const [saleOrderNo, setSaleOrderNo] = useState("");
  const [saleDate, setSaleDate] = useState("");
  const [trackingNo, setTrackingNo] = useState("");
  const [remark, setRemark] = useState("");
  const [quickSearch, setQuickSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [querying, setQuerying] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerSearch, setPickerSearch] = useState("");
  const [pickerItems, setPickerItems] = useState<InventoryItem[]>([]);
  const [pickerSelected, setPickerSelected] = useState<Record<string, InventoryItem>>({});
  const [pickerError, setPickerError] = useState("");
  const [pickerLoading, setPickerLoading] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [expandedRecordId, setExpandedRecordId] = useState<string | null>(null);
  const [cancelRecord, setCancelRecord] = useState<SaleRecord | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const cancelLock = useRef(false);
  const errorRef = useRef<HTMLDivElement>(null);
  const submitLock = useRef(false);
  const pickerRequest = useRef(0);
  const loadController = useRef<AbortController | null>(null);
  const queryController = useRef<AbortController | null>(null);
  const pickerController = useRef<AbortController | null>(null);

  const loadData = useCallback(async () => {
    loadController.current?.abort(); const controller = new AbortController(); loadController.current = controller;
    setLoading(true);
    try {
      const data = await fetchSalesData("", controller.signal);
      setInventory(Array.isArray(data.items) ? data.items : []);
      setChannels(Array.isArray(data.channels) ? data.channels : []);
      setRecords(Array.isArray(data.records) ? data.records : []);
    } catch (loadError) { if (!controller.signal.aborted) setError(loadError instanceof Error ? loadError.message : "加载数据失败，请重试"); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }, []);
  useEffect(() => { if (!active) return; setSaleDate(value => value || today()); void loadData(); return () => { loadController.current?.abort(); queryController.current?.abort(); pickerController.current?.abort(); }; }, [active, loadData]);
  useEffect(() => { if (active && error) errorRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }); }, [active, error]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const selectedItems = useMemo(() => Object.values(selected), [selected]);
  const validity = useMachineEligibility(selectedItems.map(entry => entry.item), "sale");
  useWorkspaceDirty(Boolean(selectedItems.length || Object.keys(pickerSelected).length || saleOrderNo || trackingNo || remark || saleChannelId !== baselineChannel || (saleDate && saleDate !== today()) || (cancelRecord && cancelReason)));
  const totalCost = selectedItems.reduce((sum, entry) => sum + Number(entry.item.purchasePrice || 0), 0);
  const totalAmount = selectedItems.reduce((sum, entry) => sum + (validPrice(entry.sellingPrice) ? Number(entry.sellingPrice) : 0), 0);
  const incompleteCount = selectedItems.filter((entry) => !validPrice(entry.sellingPrice)).length;
  const totalProfit = totalAmount - totalCost;
  const pendingItems = Object.values(pickerSelected);
  const allVisibleChecked = pickerItems.length > 0 && pickerItems.every((item) => selected[item.id] || pickerSelected[item.id]);

  const updateSelected = (id: string, field: "sellingPrice" | "remark", value: string) => setSelected((current) => current[id] ? { ...current, [id]: { ...current[id], [field]: value } } : current);
  const removeSelected = (id: string) => setSelected((current) => { const next = { ...current }; delete next[id]; return next; });
  const addItems = (items: InventoryItem[]) => {
    setSelected((current) => {
      const next = { ...current };
      items.forEach((item) => { if (!next[item.id]) next[item.id] = { item, sellingPrice: "", remark: "" }; });
      return next;
    });
    setError("");
  };
  const openPicker = (items = inventory, search = "") => {
    setPickerItems(items); setPickerSearch(search); setPickerSelected({}); setPickerError(""); setPickerOpen(true);
  };
  const closePicker = useCallback(() => { pickerRequest.current += 1; pickerController.current?.abort(); setPickerOpen(false); setPickerLoading(false); }, []);
  const searchPicker = async (event?: FormEvent) => {
    event?.preventDefault();
    const requestId = ++pickerRequest.current;
    pickerController.current?.abort(); const controller = new AbortController(); pickerController.current = controller;
    setPickerLoading(true); setPickerError("");
    try {
      const items = await fetchSaleMachines(pickerSearch, controller.signal);
      if (!controller.signal.aborted && requestId === pickerRequest.current) setPickerItems(items);
    } catch (searchError) { if (!controller.signal.aborted && requestId === pickerRequest.current) setPickerError(searchError instanceof Error ? searchError.message : "搜索失败，请重试"); }
    finally { if (!controller.signal.aborted && requestId === pickerRequest.current) setPickerLoading(false); }
  };
  const quickAdd = async (query = quickSearch) => {
    const value = query.trim();
    if (!value) { openPicker(); return; }
    if (querying) return;
    queryController.current?.abort(); const controller = new AbortController(); queryController.current = controller;
    setQuerying(true); setError("");
    try {
      const items = await fetchSaleMachines(value, controller.signal);
      if (controller.signal.aborted) return;
      const exact = items.find((item) => item.sn.toLowerCase() === value.toLowerCase());
      if (exact) {
        if (selected[exact.id]) setNotice(`SN ${exact.sn} 已在本单中`);
        else { addItems([exact]); setNotice(`已添加 SN ${exact.sn}`); }
        setQuickSearch("");
      } else { openPicker(items, value); }
    } catch (searchError) { if (!controller.signal.aborted) setError(searchError instanceof Error ? searchError.message : "搜索失败，请重试"); }
    finally { setQuerying(false); }
  };
  const togglePending = (item: InventoryItem) => {
    if (selected[item.id]) return;
    setPickerSelected((current) => { const next = { ...current }; if (next[item.id]) delete next[item.id]; else next[item.id] = item; return next; });
  };
  const toggleVisible = () => setPickerSelected((current) => {
    const next = { ...current };
    pickerItems.forEach((item) => { if (!selected[item.id]) { if (allVisibleChecked) delete next[item.id]; else next[item.id] = item; } });
    return next;
  });
  const resetOrder = () => {
    setBaselineChannel(saleChannelId); setSelected({}); setSaleOrderNo(""); setTrackingNo(""); setRemark(""); setQuickSearch(""); setSaleDate(today()); setError("");
  };
  const requestSubmit = (event: FormEvent) => {
    event.preventDefault(); setError("");
    if (validity.checking || validity.error || validity.invalidIds.length) { setError(validity.error || "部分所选机器状态已变化，请移除后重新选择"); return; }
    const validationError = !saleChannelId ? "请选择销售渠道" : !saleDate ? "请选择销售日期" : !saleOrderNo.trim() ? "请输入销售订单号" : !selectedItems.length ? "请至少添加一台在库机器" : incompleteCount ? `请填写 ${incompleteCount} 台机器的有效销售价格` : "";
    if (validationError) { setError(validationError); return; }
    setConfirmOpen(true);
  };
  const submitSale = async () => {
    if (submitLock.current) return;
    submitLock.current = true; setSubmitting(true); setError("");
    try {
      const response = await fetch("/api/sales", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: selectedItems.map(({ item, sellingPrice, remark: itemRemark }) => ({ inventoryId: item.id, sellingPrice: Number(sellingPrice), remark: itemRemark.trim() || null })),
          saleChannelId, saleOrderNo: saleOrderNo.trim(), saleDate, trackingNo: trackingNo.trim() || null, remark: remark.trim() || null,
        }),
      });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error?.message || "销售出库失败");
      const record = result.data as { recordNo?: string; totalQuantity?: number };
      resetOrder(); setConfirmOpen(false);
      setNotice(`出库成功，${record.totalQuantity || selectedItems.length} 台机器已售出${record.recordNo ? ` · ${record.recordNo}` : ""}`);
      await loadData();
    } catch (submitError) { setConfirmOpen(false); setError(submitError instanceof Error ? submitError.message : "销售出库失败，请重试"); }
    finally { submitLock.current = false; setSubmitting(false); }
  };

  async function cancelSale() {
    if (!cancelRecord || cancelLock.current) return;
    cancelLock.current = true; setCancelling(true);
    try {
      const response = await fetch('/api/sales', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: cancelRecord.id, action: 'cancel', cancelReason }) });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error?.message || '取消销售失败');
      setCancelRecord(null); setCancelReason(''); setNotice('销售记录已取消，机器已恢复在库'); await loadData(); setHistoryOpen(true);
    } catch (error) { setCancelRecord(null); setHistoryOpen(false); setError(error instanceof Error ? error.message : '取消销售失败'); }
    finally { setCancelling(false); cancelLock.current = false; }
  }
  const priceInput = (entry: SelectedItem) => <input type="number" inputMode="decimal" min="0" step="0.01" value={entry.sellingPrice} onChange={(event) => updateSelected(entry.item.id, "sellingPrice", event.target.value)} disabled={submitting} placeholder="输入销售价" aria-label={`SN ${entry.item.sn} 的销售价格`} className="field min-w-0 py-2 font-mono text-[13px]" />;
  const remarkInput = (entry: SelectedItem) => <input type="text" value={entry.remark} onChange={(event) => updateSelected(entry.item.id, "remark", event.target.value)} disabled={submitting} placeholder="机器备注（选填）" aria-label={`SN ${entry.item.sn} 的备注`} className="field min-w-0 py-2 text-[12px]" />;
  const itemProfit = (entry: SelectedItem) => validPrice(entry.sellingPrice) ? <span className={`font-mono ${Number(entry.sellingPrice) - entry.item.purchasePrice < 0 ? "text-danger" : "text-ok"}`}>{money(Number(entry.sellingPrice) - entry.item.purchasePrice)}</span> : <span className="text-ink-soft">待填写</span>;

  return (
    <div className="mx-auto flex min-h-[calc(100dvh-148px)] max-w-[1440px] min-w-0 flex-col page-transition-enter">
      <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div><h1 className="text-xl font-bold tracking-wide text-ink-deep">销售出库</h1><p className="mt-1.5 text-[13px] text-ink-soft">添加机器、填写售价，完成本次出库</p></div>
        <div className="flex items-center gap-2"><button type="button" onClick={() => { setExpandedRecordId(null); setHistoryOpen(true); }} className="btn-ghost inline-flex items-center gap-2 text-[13px]"><History className="h-4 w-4" />最近出库</button><button type="button" onClick={() => void loadData()} disabled={loading || submitting} aria-label="刷新销售出库数据" title="刷新数据" className="rounded-full border border-line-strong bg-white/60 p-2.5 text-ink-soft transition hover:bg-white hover:text-primary active:scale-95"><RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} /></button></div>
      </header>
      {error && <div ref={errorRef} role="alert" className="mb-4 flex items-start gap-2 rounded-xl border border-danger/20 bg-red-50 px-4 py-3 text-[13px] text-danger animate-fade-in"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /><span className="flex-1">{error}</span><button type="button" aria-label="关闭错误提示" onClick={() => setError("")} className="p-0.5"><X className="h-4 w-4" /></button></div>}
      {notice && <div role="status" className="mb-4 flex items-start gap-2 rounded-xl border border-ok/20 bg-emerald-50 px-4 py-3 text-[13px] text-emerald-700 animate-fade-in"><Check className="mt-0.5 h-4 w-4 shrink-0" /><span className="flex-1">{notice}</span><button type="button" aria-label="关闭提示" onClick={() => setNotice("")} className="p-0.5"><X className="h-4 w-4" /></button></div>}

      <form id="sales-out-form" onSubmit={requestSubmit} noValidate className="flex min-w-0 flex-1 flex-col gap-4">
        <section className="glass relative z-30 p-4 sm:p-5" aria-labelledby="sales-basic-title">
          <h2 id="sales-basic-title" className="mb-4 flex items-center gap-2 text-[14px] font-semibold text-ink-deep"><ClipboardList className="h-4 w-4 text-primary" />基础信息</h2>
          <div className="grid min-w-0 grid-cols-1 gap-x-5 gap-y-4 sm:grid-cols-2 xl:grid-cols-4">
            <div className="min-w-0"><label className="mb-1.5 block text-[12px] font-medium text-ink-deep">销售渠道 <span className="text-danger">*</span></label><CustomSelect value={saleChannelId} onChange={setSaleChannelId} searchable disabled={loading || submitting || !channels.length} options={channels.map((channel) => ({ value: channel.id, label: channel.channelName + (channel.channelType ? ` · ${channel.channelType}` : "") }))} placeholder={loading ? "正在加载渠道..." : "请选择销售渠道"} aria-label="销售渠道" required /></div>
            <label className="min-w-0"><span className="mb-1.5 block text-[12px] font-medium text-ink-deep">销售日期 <span className="text-danger">*</span></span><input type="date" value={saleDate} disabled={submitting} onChange={(event) => setSaleDate(event.target.value)} className="field min-w-0" /></label>
            <label className="min-w-0"><span className="mb-1.5 block text-[12px] font-medium text-ink-deep">销售订单号 <span className="text-danger">*</span></span><input type="text" value={saleOrderNo} disabled={submitting} onChange={(event) => setSaleOrderNo(event.target.value)} placeholder="平台订单号或内部单号" className="field" /></label>
            <label className="min-w-0"><span className="mb-1.5 flex items-center gap-1.5 text-[12px] font-medium text-ink-deep">快递单号 <span className="font-normal text-ink-soft">选填</span></span><input type="text" value={trackingNo} maxLength={100} disabled={submitting} onChange={(event) => setTrackingNo(event.target.value)} placeholder="填写快递运单号" className="field" /></label>
            <label className="min-w-0 sm:col-span-2 xl:col-span-4"><span className="mb-1.5 block text-[12px] font-medium text-ink-deep">出库备注 <span className="font-normal text-ink-soft">选填</span></span><input type="text" value={remark} disabled={submitting} onChange={(event) => setRemark(event.target.value)} placeholder="填写本次出库的补充说明" className="field" /></label>
          </div>
          {!loading && channels.length === 0 && <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl bg-primary/5 px-3 py-2.5 text-[12px] text-ink-soft"><AlertCircle className="h-4 w-4 shrink-0 text-primary" />尚未配置可用的销售渠道。<Link href="/sales/channels" className="inline-flex items-center gap-1 font-medium text-primary hover:underline">设置销售渠道<ArrowRight className="h-3.5 w-3.5" /></Link></div>}
        </section>

        <section className="glass min-w-0 flex-1 overflow-hidden" aria-labelledby="sales-items-title">
          <div className="border-b border-line-strong/70 p-4 sm:p-5">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h2 id="sales-items-title" className="flex items-center gap-2 text-[14px] font-semibold text-ink-deep"><PackageCheck className="h-4 w-4 text-primary" />机器明细 <span className="rounded-full bg-primary/8 px-2 py-0.5 font-mono text-[12px] text-primary">{selectedItems.length} 台</span></h2>{selectedItems.length > 0 && <span className="text-[12px] text-ink-soft">{incompleteCount ? `待填写 ${incompleteCount} 台售价` : "售价已填齐"}</span>}</div>
            <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
              <MachineSearchInput<InventoryItem> value={quickSearch} onChange={setQuickSearch} endpoint="/api/inventory/lookup?context=sale" onSelect={item => { addItems([item]); setQuickSearch(""); setNotice("已添加 SN " + item.sn); }} onSearch={query => { void quickAdd(query); }} disabled={submitting || querying} placeholder="输入 SN 后四位匹配，完整 SN 回车添加" ariaLabel="快速添加机器" className="min-w-0 flex-1" />
              <button type="button" onClick={() => openPicker()} disabled={loading || submitting || querying} className="btn-primary inline-flex shrink-0 items-center justify-center gap-1.5 text-[13px]"><Plus className="h-4 w-4" />从库存选择</button>
            </div>
          </div>
          {(validity.error || validity.invalidIds.length > 0) && <p role="alert" className="mx-4 rounded-xl bg-danger/5 p-3 text-xs text-danger">{validity.error || "以下机器状态已变化，请移除后重新选择："}{!validity.error && selectedItems.filter(entry => validity.invalidIds.includes(entry.item.id)).map(entry => entry.item.sn).join("、")}</p>}
          {selectedItems.length === 0 ? <div className="flex min-h-[230px] flex-col items-center justify-center px-5 py-10 text-center"><div className="mb-3 rounded-2xl bg-primary/7 p-3.5"><ScanLine className="h-7 w-7 text-primary/80" /></div><h3 className="text-[14px] font-medium text-ink-deep">添加本次要出库的机器</h3><p className="mt-2 max-w-sm text-[12px] leading-relaxed text-ink-soft">扫描 SN 可快速添加一台；从库存选择可批量加入。<br />机器加入后，在此填写各台售价和备注。</p></div> : <>
            <div className="hidden min-w-0 overflow-x-auto lg:block"><table className="data-table w-full min-w-[1050px] table-fixed"><thead><tr><th className="w-12">序号</th><th className="w-[29%]">机器 / 配置</th><th className="w-[15%]">SN</th><th className="w-28">采购成本</th><th className="w-36">销售价格 <span className="text-danger">*</span></th><th className="w-28">预计利润</th><th className="w-44">机器备注</th><th className="w-14">操作</th></tr></thead><tbody>{selectedItems.map((entry, index) => <tr key={entry.item.id} className="animate-fade-in"><td className="font-mono text-[12px] text-ink-soft">{String(index + 1).padStart(2, "0")}</td><td><div className="break-words text-[13px] font-medium leading-relaxed text-ink-deep">{productName(entry.item)}</div><div className="mt-1 break-words text-[11px] leading-relaxed text-ink-soft">{configText(entry.item)}</div></td><td className="break-all font-mono text-[12px] text-ink-deep">{entry.item.sn}</td><td className="font-mono text-[12px] text-ink-soft">{money(entry.item.purchasePrice)}</td><td>{priceInput(entry)}</td><td className="text-[12px]">{itemProfit(entry)}</td><td>{remarkInput(entry)}</td><td><button type="button" disabled={submitting} onClick={() => removeSelected(entry.item.id)} aria-label={`移除 SN ${entry.item.sn}`} className="rounded-lg p-2 text-ink-soft transition hover:bg-danger/7 hover:text-danger active:scale-95"><Trash2 className="h-4 w-4" /></button></td></tr>)}</tbody></table></div>
            <div className="divide-y divide-line-strong/60 lg:hidden">{selectedItems.map((entry, index) => <article key={entry.item.id} className="p-4 animate-fade-in sm:p-5"><div className="flex items-start gap-2"><span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-primary/8 font-mono text-[10px] text-primary">{index + 1}</span><div className="min-w-0 flex-1"><h3 className="break-words text-[13px] font-medium text-ink-deep">{productName(entry.item)}</h3><p className="mt-1 break-all font-mono text-[12px] text-ink-soft">SN {entry.item.sn}</p><p className="mt-1.5 break-words text-[11px] leading-relaxed text-ink-soft">{configText(entry.item)}</p></div><button type="button" disabled={submitting} onClick={() => removeSelected(entry.item.id)} aria-label={`移除 SN ${entry.item.sn}`} className="rounded-lg p-1.5 text-ink-soft transition hover:bg-danger/7 hover:text-danger active:scale-95"><Trash2 className="h-4 w-4" /></button></div><div className="mt-3 grid min-w-0 grid-cols-2 gap-3"><label className="min-w-0"><span className="mb-1 block text-[11px] text-ink-soft">销售价格 <span className="text-danger">*</span></span>{priceInput(entry)}</label><div className="self-end pb-2 text-right text-[11px] text-ink-soft"><div>成本 <span className="font-mono">{money(entry.item.purchasePrice)}</span></div><div className="mt-1">利润 {itemProfit(entry)}</div></div><label className="col-span-2 min-w-0"><span className="sr-only">机器备注</span>{remarkInput(entry)}</label></div></article>)}</div>
          </>}
        </section>

        <footer className="glass-strong sticky bottom-0 z-40 mt-auto flex flex-col gap-4 px-4 py-4 shadow-lg sm:px-5 xl:flex-row xl:items-center xl:justify-between">
          <div className="grid min-w-0 grid-cols-2 gap-x-5 gap-y-3 sm:grid-cols-4"><div className="text-[11px] text-ink-soft">已选机器<strong className="mt-0.5 block text-[17px] font-semibold text-ink-deep">{selectedItems.length}<span className="ml-1 text-[11px] font-normal text-ink-soft">台</span></strong></div><div className="text-[11px] text-ink-soft">采购总成本<strong className="mt-1 block break-all font-mono text-[14px] font-medium text-ink-deep">{money(totalCost)}</strong></div><div className="text-[11px] text-ink-soft">销售总金额<strong className="mt-1 block break-all font-mono text-[14px] font-semibold text-primary">{money(totalAmount)}</strong></div><div className="text-[11px] text-ink-soft">预计利润<strong className={`mt-1 block break-all font-mono text-[14px] font-semibold ${incompleteCount ? "text-ink-soft" : totalProfit < 0 ? "text-danger" : "text-ok"}`}>{incompleteCount ? "售价待填齐" : money(totalProfit)}</strong></div></div>
          <div className="flex shrink-0 items-center justify-end gap-2 border-t border-line-strong/70 pt-3 xl:border-0 xl:pt-0"><button type="button" disabled={submitting || querying || (!selectedItems.length && !saleOrderNo && !trackingNo && !remark && !saleChannelId)} onClick={() => setClearOpen(true)} className="btn-ghost inline-flex items-center justify-center gap-1.5 text-[13px]"><Trash2 className="h-3.5 w-3.5" />清空本单</button><button type="submit" disabled={loading || submitting || querying || validity.checking || !!validity.error || validity.invalidIds.length > 0} className="btn-primary inline-flex flex-1 items-center justify-center gap-2 text-[13px] sm:flex-none"><PackageCheck className="h-4 w-4" />{submitting ? "出库处理中..." : "确认销售出库"}</button></div>
        </footer>
      </form>

      {pickerOpen && <SalesDialog title="选择在库机器" subtitle="勾选后加入本单；已加入的机器不会重复添加" wide onClose={closePicker} footer={<><span className="mr-auto text-[12px] text-ink-soft">待加入 <b className="font-mono text-primary">{pendingItems.length}</b> 台</span><button type="button" onClick={closePicker} className="btn-ghost text-[13px]">取消</button><button type="button" disabled={!pendingItems.length} onClick={() => { addItems(pendingItems); closePicker(); setQuickSearch(""); setNotice(`已添加 ${pendingItems.length} 台机器`); }} className="btn-primary inline-flex items-center gap-1.5 text-[13px]"><Check className="h-4 w-4" />确认加入</button></>}>
        <form onSubmit={searchPicker} className="mb-3 flex min-w-0 gap-2"><MachineSearchInput<InventoryItem> value={pickerSearch} onChange={setPickerSearch} endpoint="/api/inventory/lookup?context=sale" onSelect={item => { setPickerItems(current => [item, ...current.filter(row => row.id !== item.id)]); setPickerSelected(current => ({ ...current, [item.id]: item })); setPickerSearch(item.sn); }} placeholder="输入 SN 后四位、品牌型号或配置" ariaLabel="搜索在库机器" className="min-w-0 flex-1" /><button type="submit" disabled={pickerLoading} className="btn-primary text-[13px]">{pickerLoading ? "搜索中" : "搜索"}</button></form>
        {pickerError && <p role="alert" className="mb-3 rounded-lg bg-red-50 p-3 text-[12px] text-danger">{pickerError}</p>}
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-[12px] text-ink-soft"><span>{pickerItems.length === 100 ? "当前显示前 100 台，可搜索缩小范围" : `找到 ${pickerItems.length} 台在库机器`}</span><button type="button" disabled={!pickerItems.length || pickerLoading} onClick={toggleVisible} className="inline-flex items-center gap-1 text-primary hover:underline"><CheckCheck className="h-3.5 w-3.5" />{allVisibleChecked ? "取消当前结果" : "全选当前结果"}</button></div>
        {pickerLoading ? <div className="flex min-h-40 items-center justify-center gap-2 text-[13px] text-ink-soft"><LoaderCircle className="h-4 w-4 animate-spin" />正在加载在库机器...</div> : !pickerItems.length ? <div className="rounded-xl border border-dashed border-line-strong bg-white/50 px-4 py-12 text-center text-[13px] text-ink-soft">没有匹配的在库机器，试试其他 SN 或型号</div> : <div className="space-y-2">{pickerItems.map((item) => { const alreadyAdded = Boolean(selected[item.id]); const checked = alreadyAdded || Boolean(pickerSelected[item.id]); return <label key={item.id} className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition duration-150 sm:p-4 ${alreadyAdded ? "cursor-default border-line bg-white/40" : checked ? "border-primary/40 bg-primary/5" : "border-line-strong/70 bg-white/80 hover:border-primary/30 hover:bg-white"}`}><input type="checkbox" checked={checked} disabled={alreadyAdded} onChange={() => togglePending(item)} className="mt-1 h-4 w-4 shrink-0 accent-primary" aria-label={`选择 SN ${item.sn}`} /><div className="min-w-0 flex-1"><div className="flex flex-wrap items-start justify-between gap-2"><span className="break-words text-[13px] font-medium text-ink-deep">{productName(item)}</span>{alreadyAdded ? <span className="rounded-full bg-line px-2 py-0.5 text-[10px] text-ink-soft">已在本单</span> : <span className="font-mono text-[12px] text-ink-deep">{money(item.purchasePrice)}</span>}</div><p className="mt-1 break-all font-mono text-[12px] text-primary">SN {item.sn}</p><p className="mt-1 break-words text-[11px] leading-relaxed text-ink-soft">{configText(item)}</p><p className="mt-1 text-[11px] text-ink-soft">{item.supplierName || "未填写供应商"}</p></div></label>; })}</div>}
      </SalesDialog>}

      {confirmOpen && <SalesDialog title="确认销售出库" subtitle="确认后，所选机器将更新为已售并生成销售记录" busy={submitting} onClose={() => { if (!submitting) setConfirmOpen(false); }} footer={<><button type="button" disabled={submitting} onClick={() => setConfirmOpen(false)} className="btn-ghost text-[13px]">返回检查</button><button type="button" disabled={submitting} onClick={() => void submitSale()} className="btn-primary inline-flex items-center gap-2 text-[13px]">{submitting ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <PackageCheck className="h-4 w-4" />}{submitting ? "正在出库..." : "确认出库"}</button></>}>
        <dl className="space-y-3 text-[13px]"><div className="flex justify-between gap-5"><dt className="shrink-0 text-ink-soft">销售渠道</dt><dd className="break-words text-right text-ink-deep">{channels.find((channel) => channel.id === saleChannelId)?.channelName}</dd></div><div className="flex justify-between gap-5"><dt className="shrink-0 text-ink-soft">销售订单号</dt><dd className="break-all text-right font-mono text-ink-deep">{saleOrderNo}</dd></div><div className="flex justify-between gap-5"><dt className="shrink-0 text-ink-soft">销售日期</dt><dd className="text-ink-deep">{saleDate}</dd></div>{trackingNo.trim() && <div className="flex justify-between gap-5"><dt className="shrink-0 text-ink-soft">快递单号</dt><dd className="break-all text-right font-mono text-ink-deep">{trackingNo}</dd></div>}</dl><div className="mt-5 rounded-xl border border-primary/15 bg-primary/5 p-4"><div className="flex items-center justify-between gap-3 text-[13px]"><span className="text-ink-deep">本次出库 <b className="font-mono">{selectedItems.length}</b> 台</span><strong className="font-mono text-[18px] text-primary">{money(totalAmount)}</strong></div><div className="mt-2 flex justify-between gap-3 text-[12px] text-ink-soft"><span>采购成本 {money(totalCost)}</span><span className={totalProfit < 0 ? "text-danger" : "text-ok"}>预计利润 {money(totalProfit)}</span></div></div>
      </SalesDialog>}

      {clearOpen && <SalesDialog title="清空本次出库单？" onClose={() => setClearOpen(false)} footer={<><button type="button" onClick={() => setClearOpen(false)} className="btn-ghost text-[13px]">保留本单</button><button type="button" onClick={() => { resetOrder(); setSaleChannelId(""); setClearOpen(false); setNotice("已清空本次出库单"); }} className="btn-primary bg-danger text-[13px] hover:bg-red-600">确认清空</button></>}><p className="text-[13px] leading-relaxed text-ink-soft">将清除已选机器、售价和本单信息，库存不会发生变化。</p></SalesDialog>}

      <ConfirmDialog isOpen={Boolean(cancelRecord)} title="确认取消销售" message={`销售单 ${cancelRecord?.recordNo || ""} 将标记为已取消，所含机器将恢复在库。已有后续业务的销售无法取消。`} confirmText={cancelling ? "取消中..." : "确认取消销售"} cancelText="返回检查" danger onConfirm={() => void cancelSale()} onCancel={() => { if (!cancelling) { setCancelRecord(null); setHistoryOpen(true); } }} />
      {historyOpen && <SalesDialog title="最近出库记录" subtitle="最近 20 笔销售记录，点击查看成交快照与取消状态" wide onClose={() => setHistoryOpen(false)} footer={<button type="button" onClick={() => setHistoryOpen(false)} className="btn-ghost text-[13px]">关闭</button>}>
        {!records.length ? <div className="py-12 text-center text-[13px] text-ink-soft">暂无出库记录</div> : <div className="space-y-2">{records.map((record) => <article key={record.id} className="overflow-hidden rounded-xl border border-line-strong/70 bg-white/70"><button type="button" onClick={() => setExpandedRecordId(expandedRecordId === record.id ? null : record.id)} aria-expanded={expandedRecordId === record.id} className="flex w-full flex-wrap items-center justify-between gap-3 px-4 py-3 text-left transition hover:bg-primary/4"><span className="min-w-0"><span className="block break-all font-mono text-[12px] font-medium text-ink-deep">{record.recordNo}</span><span className="mt-1 block text-[11px] text-ink-soft">{record.saleChannel} · {record.saleDate?.slice(0, 10)} · {record.totalQuantity} 台 · {record.status === "cancelled" ? "已取消" : "已完成"}</span></span><span className="font-mono text-[14px] font-medium text-primary">{money(record.totalAmount)}</span></button>{expandedRecordId === record.id && <div className="border-t border-line bg-white/65 px-4 py-3 animate-fade-in"><dl className="grid gap-2 text-[12px] sm:grid-cols-2"><div className="min-w-0"><dt className="text-ink-soft">销售订单号</dt><dd className="mt-1 break-all font-mono text-ink-deep">{record.saleOrderNo}</dd></div><div className="min-w-0"><dt className="inline-flex items-center gap-1 text-ink-soft"><Truck className="h-3.5 w-3.5" />快递单号</dt><dd className="mt-1 break-all font-mono text-ink-deep">{record.trackingNo || "未填写"}</dd></div></dl><div className="mt-3 space-y-2 border-t border-line pt-3">{(Array.isArray(record.items) ? record.items : []).map((item) => <div key={item.inventoryId || item.sn} className="flex flex-wrap items-center justify-between gap-2 text-[12px]"><span className="min-w-0"><span className="text-ink-deep">{productName(item)}</span><span className="mt-1 block break-all font-mono text-[11px] text-ink-soft">SN {item.sn}</span></span><span className="font-mono text-ink-deep">售价 {money(item.sellingPrice)}<span className="mt-1 block text-[11px] text-ink-soft">成本 {money(item.purchasePrice)} · 利润 {money(item.profit)}</span></span><p className="w-full text-[11px] text-ink-soft">{[item.cpu, item.ram, item.storage, item.gpu, item.screen, item.remark].filter(Boolean).join(" / ")}</p></div>)}</div><div className="mt-4 border-t border-line pt-3 text-[12px] text-ink-soft">总成本 {money(record.totalCost)} · 总利润 {money(record.totalProfit)}{record.remark && <p className="mt-2">备注：{record.remark}</p>}</div>{record.status === "cancelled" ? <p className="mt-3 text-[12px] text-ink-soft">取消时间：{record.cancelledAt || "-"} · 原因：{record.cancelReason || "未填写"}</p> : <div className="mt-4 flex flex-wrap gap-2"><input value={cancelReason} onChange={(event) => setCancelReason(event.target.value)} placeholder="取消原因（选填）" aria-label="取消销售原因" className="field min-w-0 flex-1 text-[12px]" /><button type="button" onClick={() => { setHistoryOpen(false); setCancelRecord(record); }} className="btn-ghost text-[12px] text-danger">取消销售</button></div>}</div>}</article>)}</div>}
      </SalesDialog>}
    </div>
  );
}
