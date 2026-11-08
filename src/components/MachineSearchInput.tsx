'use client';

import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, ListPlus, LoaderCircle, ScanLine, Search, X } from 'lucide-react';
import { useWorkspace } from '@/components/WorkspaceContext';
import { formatProductName } from '@/lib/product-name';
import { formatCPUDisplay, formatGPUDisplay, formatScreenDisplay } from '@/lib/sku-display';
import { hasMachineScanDelimiter, splitMachineScanTokens, uniqueMachineScanTokens } from '@/lib/machine-scan';

export interface MachineSuggestion {
  id: string; sn: string; itemNumber?: string | null; brand?: string | null; model?: string | null; year?: number | string | null;
  cpu?: string | null; ram?: string | null; gpu?: string | null; storage?: string | null; screen?: string | null;
  purchasePrice?: number | null; supplierName?: string | null; purchaseNo?: string | null; warehouseId?: string | null; warehouseName?: string | null;
  status?: string; customStatusName?: string | null; customStatusColor?: string | null;
}
export interface MachineScanBatchDetails {
  duplicates: { serial: string; count: number }[];
}
export interface MachineSearchInputProps<T extends MachineSuggestion> {
  value: string; onChange: (value: string) => void; endpoint?: string; onSelect: (item: T) => void; onSearch?: (query: string) => void;
  onClear?: () => void;
  onSelectMany?: (items: T[], serials: string[], details: MachineScanBatchDetails) => string | void;
  onScanTokens?: (tokens: string[]) => void | Promise<void>;
  onScanToken?: (token: string) => void | Promise<void>;
  scanEnabled?: boolean;
  batchEnabled?: boolean;
  placeholder?: string; ariaLabel?: string; disabled?: boolean; minChars?: number;
  getItems?: (payload: unknown) => T[]; renderItem?: (item: T) => ReactNode; className?: string;
}
function defaultItems<T extends MachineSuggestion>(payload: unknown): T[] {
  const data = payload as { data?: { items?: unknown } } | null;
  return Array.isArray(data?.data?.items) ? data.data.items as T[] : [];
}
function productName(item: MachineSuggestion) {
  return formatProductName(item);
}
function configText(item: MachineSuggestion) { return [formatCPUDisplay(item.cpu), item.ram, item.storage, formatGPUDisplay(item.gpu), formatScreenDisplay(item.screen)].filter(Boolean).join(' / ') || '配置待补充'; }
const STATUS_NAMES: Record<string, string> = { in_stock: '在库', sold: '已售', returning: '供应商退货中', returned: '已退货', renting: '租赁中', after_sale: '售后中', reserved: '已预留', on_way: '在途' };
function HighlightSN({ sn, query }: { sn: string; query: string }) {
  return query && sn.toLowerCase().endsWith(query.toLowerCase()) ? <>{sn.slice(0, sn.length - query.length)}<mark className="rounded bg-primary/15 px-0.5 font-semibold text-primary">{sn.slice(-query.length)}</mark></> : <>{sn}</>;
}

/** Database-backed suggestions; typing never selects a machine implicitly. */
export default function MachineSearchInput<T extends MachineSuggestion>({
  value, onChange, endpoint = '/api/inventory/lookup?context=inventory', onSelect, onSearch, onClear, onSelectMany, onScanTokens, onScanToken, scanEnabled = true, batchEnabled = false,
  placeholder = '输入 SN 后四位或型号自动匹配', ariaLabel = '搜索机器', disabled = false,
  minChars = 4, getItems = defaultItems, renderItem, className = '',
}: MachineSearchInputProps<T>) {
  const { active } = useWorkspace(); const listId = useId();
  const [items, setItems] = useState<T[]>([]); const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false); const [error, setError] = useState('');
  const [open, setOpen] = useState(false); const [focused, setFocused] = useState(false); const [highlighted, setHighlighted] = useState(-1);
  const [expanded, setExpanded] = useState(false); const [page, setPage] = useState(1); const [retry, setRetry] = useState(0);
  const [position, setPosition] = useState<{ left: number; top?: number; bottom?: number; width: number; maxHeight: number }>({ left: 0, top: 0, width: 0, maxHeight: 360 });
  const [batchOpen, setBatchOpen] = useState(false); const [batchValue, setBatchValue] = useState(''); const [batchError, setBatchError] = useState('');
  const [batchPosition, setBatchPosition] = useState<{ left: number; top?: number; bottom?: number; width: number; maxHeight: number }>({ left: 12, top: 100, width: 520, maxHeight: 420 });
  const sequence = useRef(0); const abortRef = useRef<AbortController | null>(null); const selectedQuery = useRef<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null); const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null); const batchButtonRef = useRef<HTMLButtonElement>(null); const batchPanelRef = useRef<HTMLDivElement>(null); const batchTextareaRef = useRef<HTMLTextAreaElement>(null);
  const scanBusy = useRef(false); const scanQueue = useRef<string[]>([]);
  const preservedScanErrorQuery = useRef<string | null>(null);
  const [scanNotice, setScanNotice] = useState('');
  const limit = expanded ? 50 : 8; const query = value.trim();
  const batchTokens = splitMachineScanTokens(batchValue);
  const batchUniqueTokens = uniqueMachineScanTokens(batchTokens);
  useLayoutEffect(() => () => { setOpen(false); setFocused(false); }, []);

  useEffect(() => {
    const requestId = ++sequence.current;
    if (batchEnabled && hasMachineScanDelimiter(query)) {
      setOpen(false); setLoading(false); setItems([]);
      if (preservedScanErrorQuery.current !== query) setError('');
      return;
    }
    if (!active || !focused || disabled || query.length < minChars || selectedQuery.current === query) {
      setOpen(false); setLoading(false); setItems([]);
      if (preservedScanErrorQuery.current !== query) setError('');
      return;
    }
    const controller = new AbortController(); abortRef.current = controller;
    const timer = window.setTimeout(async () => {
      if (sequence.current !== requestId || controller.signal.aborted) return;
      setLoading(true);
      if (preservedScanErrorQuery.current !== query) setError('');
      setOpen(true); setHighlighted(-1);
      try {
        const url = new URL(endpoint, window.location.origin);
        url.searchParams.set('q', query); url.searchParams.set('limit', String(limit)); url.searchParams.set('page', String(page));
        const response = await fetch(url.toString(), { cache: 'no-store', signal: controller.signal }); const payload = await response.json();
        if (!response.ok || !payload.success) throw new Error(payload.error?.message || '搜索失败，请重试');
        if (sequence.current !== requestId) return;
        const next = getItems(payload); setItems(next); setTotal(Number(payload.data?.total ?? next.length));
      } catch (err) {
        if (controller.signal.aborted || sequence.current !== requestId) return;
        setItems([]); setError(err instanceof Error ? err.message : '搜索失败，请重试');
      } finally { if (sequence.current === requestId && !controller.signal.aborted) setLoading(false); }
    }, 250);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [active, batchEnabled, disabled, endpoint, focused, getItems, limit, minChars, page, query, retry]);

  useLayoutEffect(() => {
    if (!active || !open) return;
    const update = () => {
      const rect = containerRef.current?.getBoundingClientRect(); if (!rect) return;
      const room = window.innerHeight - rect.bottom - 12; const above = room < 180 && rect.top > room;
      const height = Math.min(420, above ? rect.top - 12 : room); const width = Math.min(Math.max(rect.width, 280), window.innerWidth - 24);
      setPosition({ left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)), ...(above ? { bottom: window.innerHeight - rect.top + 6 } : { top: rect.bottom + 6 }), width, maxHeight: Math.max(100, height) });
    };
    update(); window.addEventListener('resize', update); window.addEventListener('scroll', update, true);
    return () => { window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true); setOpen(false); };
  }, [active, open]);
  useEffect(() => {
    if (!active || !open) return;
    const close = (event: PointerEvent) => { if (!containerRef.current?.contains(event.target as Node) && !listRef.current?.contains(event.target as Node)) { ++sequence.current; abortRef.current?.abort(); setOpen(false); setLoading(false); } };
    document.addEventListener('pointerdown', close); return () => document.removeEventListener('pointerdown', close);
  }, [active, open]);
  useEffect(() => {
    if (!batchOpen) return;
    const updatePosition = () => {
      const rect = batchButtonRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(520, window.innerWidth - 24);
      const availableBelow = window.innerHeight - rect.bottom - 12;
      const showAbove = availableBelow < 240 && rect.top > availableBelow;
      const maxHeight = Math.max(220, Math.min(460, showAbove ? rect.top - 16 : availableBelow));
      setBatchPosition({
        left: Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12)),
        ...(showAbove ? { bottom: window.innerHeight - rect.top + 8 } : { top: rect.bottom + 8 }),
        width,
        maxHeight,
      });
    };
    const closeOutside = (event: PointerEvent) => {
      if (!batchPanelRef.current?.contains(event.target as Node) && !batchButtonRef.current?.contains(event.target as Node)) setBatchOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopPropagation(); setBatchOpen(false); batchButtonRef.current?.focus();
    };
    updatePosition();
    batchTextareaRef.current?.focus();
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [batchOpen]);
  useEffect(() => { listRef.current?.querySelector('[data-index="' + highlighted + '"]')?.scrollIntoView({ block: 'nearest' }); }, [highlighted]);
  function select(item: T) {
    selectedQuery.current = item.sn.trim(); ++sequence.current; abortRef.current?.abort(); setLoading(false); setOpen(false); setHighlighted(-1); onSelect(item);
  }
  function clearInput() {
    ++sequence.current; abortRef.current?.abort(); selectedQuery.current = null; preservedScanErrorQuery.current = null;
    setItems([]); setHighlighted(-1); setOpen(false); setLoading(false); setError(''); setScanNotice('');
    onClear?.();
  }
  function searchAll() { if (onSearch) { setOpen(false); onSearch(query); } else { setExpanded(true); setPage(1); setRetry(v => v + 1); } }
  function openBatchEntry() {
    ++sequence.current; abortRef.current?.abort(); setOpen(false); setLoading(false);
    setBatchValue(value.trim()); setBatchError(''); setBatchOpen(true);
  }
  async function submitBatchEntry() {
    if (!batchTokens.length) { setBatchError('请输入至少一个 SN'); return; }
    if (batchTokens.length > 100) { setBatchError('一次最多查询 100 个 SN'); return; }
    setBatchError(''); setError(''); setScanNotice('');
    await resolveScannedTokens(batchTokens);
    setBatchOpen(false);
  }
  async function resolveScannedTokens(tokens: string[], fallbackQuery?: string) {
    const counts = new Map<string, { serial: string; count: number }>();
    for (const rawToken of tokens) {
      const serial = rawToken.trim();
      if (!serial) continue;
      const key = serial.toLocaleLowerCase();
      const current = counts.get(key);
      if (current) current.count += 1;
      else counts.set(key, { serial, count: 1 });
    }
    const duplicates = [...counts.values()].filter(({ count }) => count > 1);
    const duplicateCount = duplicates.reduce((total, duplicate) => total + duplicate.count - 1, 0);
    const normalized = uniqueMachineScanTokens(tokens);
    if (!normalized.length) return;
    if (tokens.length > 100) { setError('一次最多查询 100 个 SN'); return; }
    if (!batchEnabled && normalized.length > 1) { setError('当前操作一次只能选择一台机器，请分开搜索或扫码'); return; }
    preservedScanErrorQuery.current = null;
    setScanNotice(duplicateCount ? `粘贴内容中有 ${duplicateCount} 个重复 SN，已按唯一机器识别：${duplicates.map(item => item.serial).join('、')}` : '');
    scanQueue.current.push(...normalized);
    if (scanBusy.current) return;
    scanBusy.current = true;
    ++sequence.current; abortRef.current?.abort(); setOpen(false); setLoading(true); setError('');
    const issues: string[] = [];
    const unmatchedTokens: string[] = [];
    let matchedCount = 0;
    try {
      while (scanQueue.current.length) {
        const batch = uniqueMachineScanTokens(scanQueue.current.splice(0, 100));
        if (onScanTokens) {
          try { await onScanTokens(batch); }
          catch (scanError) { unmatchedTokens.push(...batch); issues.push(scanError instanceof Error ? scanError.message : '机器查询失败'); }
          continue;
        }
        if (onScanToken) {
          for (const token of batch) {
            try { await onScanToken(token); matchedCount += 1; }
            catch (scanError) { unmatchedTokens.push(token); issues.push(`${token}：${scanError instanceof Error ? scanError.message : '无法识别'}`); }
          }
          continue;
        }

        const matches: T[] = [];
        const matchedTokens: string[] = [];
        try {
          const url = new URL(endpoint, window.location.origin);
          url.searchParams.set('limit', '100'); url.searchParams.set('page', '1');
          if (url.pathname.endsWith('/api/inventory/lookup')) {
            url.searchParams.delete('q'); url.searchParams.delete('search'); url.searchParams.delete('sn');
            batch.forEach(token => url.searchParams.append('sn', token));
            const response = await fetch(url.toString(), { cache: 'no-store' });
            const payload = await response.json();
            if (!response.ok || !payload.success) throw new Error(payload.error?.message || '查询失败');
            const resultItems = getItems(payload);
            for (const token of batch) {
              const exact = resultItems.find(item => item.sn.trim().toLocaleLowerCase() === token.toLocaleLowerCase()
                || item.itemNumber?.trim().toLocaleLowerCase() === token.toLocaleLowerCase());
              if (exact && !matches.some(item => item.id === exact.id)) { matches.push(exact); matchedTokens.push(token); }
              else if (!exact) { unmatchedTokens.push(token); issues.push(`${token}：没有找到符合当前操作条件的机器`); }
            }
          } else {
            for (const token of batch) {
              const tokenUrl = new URL(url.toString()); tokenUrl.searchParams.delete('sn'); tokenUrl.searchParams.set('q', token);
              const response = await fetch(tokenUrl.toString(), { cache: 'no-store' });
              const payload = await response.json();
              if (!response.ok || !payload.success) throw new Error(payload.error?.message || '查询失败');
              const exact = getItems(payload).find(item => item.sn.trim().toLocaleLowerCase() === token.toLocaleLowerCase()
                || item.itemNumber?.trim().toLocaleLowerCase() === token.toLocaleLowerCase());
              if (exact && !matches.some(item => item.id === exact.id)) { matches.push(exact); matchedTokens.push(token); }
              else if (!exact) { unmatchedTokens.push(token); issues.push(`${token}：没有找到符合当前操作条件的机器`); }
            }
          }
          if (matches.length) {
            matchedCount += matches.length;
            if (batchEnabled && onSelectMany) {
              const selectedValue = onSelectMany(matches, matchedTokens, { duplicates });
              selectedQuery.current = typeof selectedValue === 'string' ? selectedValue : matches[matches.length - 1]?.sn.trim() || null;
            } else matches.forEach(item => select(item));
          }
        } catch (scanError) {
          unmatchedTokens.push(...batch);
          issues.push(scanError instanceof Error ? scanError.message : '机器查询失败');
        }
      }
      if (fallbackQuery && matchedCount === 0) {
        setError('');
        if (onSearch) { setOpen(false); onSearch(fallbackQuery); }
        else { setExpanded(true); setPage(1); setRetry(current => current + 1); setOpen(true); }
        return;
      }
      const unresolved = uniqueMachineScanTokens(unmatchedTokens);
      if (unresolved.length) {
        const nextValue = unresolved.join(', ');
        preservedScanErrorQuery.current = nextValue;
        selectedQuery.current = nextValue;
        onChange(nextValue);
      }
      if (issues.length) setError(issues.slice(0, 5).join('；') + (issues.length > 5 ? `；另有 ${issues.length - 5} 条未匹配` : ''));
    } finally {
      setLoading(false); scanBusy.current = false;
      window.requestAnimationFrame(() => inputRef.current?.focus());
    }
  }
  const showList = active && open && !disabled && query.length >= minChars;

  return <>
  <div className={'flex min-w-0 items-start gap-2 ' + className}>
   <div ref={containerRef} className="relative min-w-0 flex-1">
    <Search className="pointer-events-none absolute left-3 top-1/2 z-[1] h-4 w-4 -translate-y-1/2 text-ink-soft" aria-hidden="true" />
    <input ref={inputRef} type="text" role="combobox" value={value} disabled={disabled}
      onFocus={() => { setFocused(true); if (query.length >= minChars && selectedQuery.current !== query) { setLoading(true); setOpen(true); setRetry(v => v + 1); } }}
      onBlur={() => { ++sequence.current; abortRef.current?.abort(); setFocused(false); setOpen(false); setLoading(false); }}
      onChange={event => {
        const nextValue = event.target.value;
        preservedScanErrorQuery.current = null;
        setScanNotice('');
        ++sequence.current; abortRef.current?.abort(); selectedQuery.current = null; setItems([]); setHighlighted(-1); setPage(1); setExpanded(false); setError(""); setLoading(nextValue.trim().length >= minChars); setOpen(nextValue.trim().length >= minChars); onChange(nextValue);
      }}
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); ++sequence.current; abortRef.current?.abort(); setOpen(false); setLoading(false); setHighlighted(-1); }
        else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); if (!loading && items.length) { setOpen(true); setHighlighted(current => event.key === 'ArrowDown' ? Math.min(current + 1, items.length - 1) : Math.max(current - 1, 0)); } }
        else if (event.key === 'Enter' && !loading && showList && highlighted >= 0 && items[highlighted]) { event.preventDefault(); select(items[highlighted]); }
        else if (event.key === 'Enter' && batchEnabled && query && !hasMachineScanDelimiter(query)) { event.preventDefault(); ++sequence.current; abortRef.current?.abort(); setOpen(false); selectedQuery.current = null; onChange(''); void resolveScannedTokens([query], onScanTokens ? undefined : query); }
        else if (event.key === 'Enter' && onSearch) { event.preventDefault(); setOpen(false); onSearch(query); }
      }}
      placeholder={placeholder} aria-label={ariaLabel} aria-autocomplete="list" aria-controls={listId} aria-expanded={showList}
      aria-activedescendant={showList && highlighted >= 0 ? listId + '-' + highlighted : undefined}
      className="field w-full pl-10 pr-10" />
    {onClear && value && !loading && <button type="button" className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-ink-soft transition hover:bg-primary/5 hover:text-ink-deep active:scale-95" onMouseDown={event => event.preventDefault()} onClick={clearInput} aria-label="清除搜索"><X className="h-4 w-4" /></button>}
    {loading ? <LoaderCircle className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-primary" aria-label="搜索中" /> : scanEnabled && (!onClear || !value) && <ScanLine className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-soft/60" aria-hidden="true" />}
    {scanEnabled && error && !showList && <p role="alert" className="mt-1 text-xs text-danger">{error}</p>}
    {scanEnabled && scanNotice && <p role="status" className="mt-1 text-xs text-primary">{scanNotice}</p>}
    {showList && typeof document !== 'undefined' && createPortal(<div ref={listRef} style={position} className="dropdown-surface fixed z-[12000] flex flex-col overflow-hidden rounded-xl border border-line-strong bg-white shadow-xl animate-fade-in" onMouseDown={event => event.preventDefault()}>
      <div id={listId} role="listbox" aria-label="机器匹配结果" className="min-h-0 overflow-y-auto overscroll-contain">
        {loading ? <p role="status" className="px-4 py-4 text-center text-xs text-ink-soft">正在匹配机器…</p> : error ? <div role="alert" className="px-4 py-4 text-center text-xs text-danger">{error}<button type="button" onClick={() => setRetry(v => v + 1)} className="ml-2 text-primary underline">重试</button></div> : !items.length ? <p role="status" className="px-4 py-4 text-center text-xs text-ink-soft">没有符合当前业务条件的机器</p> : items.map((item, index) => <button key={item.id} id={listId + '-' + index} data-index={index} type="button" role="option" aria-selected={highlighted === index}
          onMouseEnter={() => setHighlighted(index)} onClick={() => select(item)}
          className={'flex w-full items-start gap-3 border-b border-line/60 px-3 py-3 text-left transition-colors last:border-b-0 ' + (highlighted === index ? 'bg-primary/10' : 'hover:bg-primary/5')}>
          {renderItem ? renderItem(item) : <span className="min-w-0 flex-1"><span className="flex items-start justify-between gap-2"><span className="text-[13px] font-medium text-ink-deep">{productName(item)}</span>{item.status && <span className="shrink-0 text-[11px] text-ink-soft" style={item.status === 'custom' && item.customStatusColor ? { color: item.customStatusColor } : undefined}>{item.customStatusName || STATUS_NAMES[item.status] || item.status}</span>}</span><span className="mt-1 block break-all font-mono text-xs text-ink-deep">SN <HighlightSN sn={item.sn} query={query} /></span>{item.itemNumber && <span className="mt-1 block break-all font-mono text-[11px] text-primary">编号 {item.itemNumber}</span>}<span className="mt-1 block text-[11px] text-ink-soft">{configText(item)}{item.warehouseName ? ' · ' + item.warehouseName : ''}</span></span>}
        </button>)}
      </div>
      {!loading && !error && total > 8 && !expanded && <button type="button" onClick={searchAll} className="shrink-0 border-t border-line/70 px-4 py-3 text-left text-xs font-medium text-primary transition-colors hover:bg-primary/5">查看全部 {total} 条结果</button>}
      {expanded && total > limit && <div className="flex shrink-0 items-center justify-between border-t border-line/70 px-3 py-2 text-xs text-ink-soft"><button type="button" disabled={page <= 1} onClick={() => setPage(v => v - 1)} className="btn-ghost p-1 disabled:opacity-30" aria-label="上一页匹配结果"><ChevronLeft className="h-4 w-4" /></button>{page} / {Math.ceil(total / limit)} · {total} 台<button type="button" disabled={page * limit >= total} onClick={() => setPage(v => v + 1)} className="btn-ghost p-1 disabled:opacity-30" aria-label="下一页匹配结果"><ChevronRight className="h-4 w-4" /></button></div>}
    </div>, document.body)}
   </div>
   {batchEnabled && <button ref={batchButtonRef} type="button" className="btn-secondary inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap" disabled={disabled} onClick={openBatchEntry} aria-label="批量输入 SN"><ListPlus className="h-4 w-4" />批量 SN</button>}
  </div>
  {batchOpen && typeof document !== 'undefined' && createPortal(<div ref={batchPanelRef} style={batchPosition} role="dialog" aria-modal="false" aria-label="批量输入 SN" className="fixed z-[12001] flex flex-col overflow-hidden rounded-xl border border-line-strong bg-white shadow-xl animate-fade-in">
    <header className="flex shrink-0 items-center justify-between border-b border-line/70 px-4 py-3"><h3 className="text-sm font-semibold text-ink-deep">批量输入 SN</h3><button type="button" className="btn-ghost p-1.5" aria-label="关闭批量输入" onClick={() => { setBatchOpen(false); batchButtonRef.current?.focus(); }}><X className="h-4 w-4" /></button></header>
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
      {batchError && <p role="alert" className="text-xs text-danger">{batchError}</p>}
      <textarea ref={batchTextareaRef} className="field min-h-[180px] w-full flex-1 resize-y font-mono text-xs" aria-label="批量输入 SN 列表" value={batchValue} onChange={event => { setBatchValue(event.target.value); setBatchError(''); }} placeholder="输入或粘贴 SN" />
      <p role="status" className="text-[11px] text-ink-soft">{batchTokens.length} 个 SN{batchTokens.length !== batchUniqueTokens.length ? ` · 去重后 ${batchUniqueTokens.length} 个` : ''}</p>
    </div>
    <footer className="flex shrink-0 items-center justify-between gap-2 border-t border-line/70 bg-white/70 px-3 py-2.5"><button type="button" className="btn-ghost" onClick={() => { setBatchValue(''); setBatchError(''); }}>清空</button><button type="button" className="btn-primary inline-flex items-center gap-1.5" aria-label="查询批量 SN" disabled={loading || !batchTokens.length} onClick={() => void submitBatchEntry()}><Search className="h-4 w-4" />{loading ? '查询中…' : '查询'}</button></footer>
  </div>, document.body)}
  </>;
}


