'use client';

import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, LoaderCircle, Search } from 'lucide-react';
import { useWorkspace } from '@/components/WorkspaceContext';

export interface MachineSuggestion {
  id: string; sn: string; brand?: string | null; model?: string | null; year?: number | string | null;
  cpu?: string | null; ram?: string | null; gpu?: string | null; storage?: string | null; screen?: string | null;
  purchasePrice?: number | null; supplierName?: string | null; purchaseNo?: string | null; warehouseName?: string | null;
  status?: string; customStatusName?: string | null; customStatusColor?: string | null;
}
interface MachineSearchInputProps<T extends MachineSuggestion> {
  value: string; onChange: (value: string) => void; endpoint?: string; onSelect: (item: T) => void; onSearch?: (query: string) => void;
  placeholder?: string; ariaLabel?: string; disabled?: boolean; minChars?: number;
  getItems?: (payload: unknown) => T[]; renderItem?: (item: T) => ReactNode; className?: string;
}
function defaultItems<T extends MachineSuggestion>(payload: unknown): T[] {
  const data = payload as { data?: { items?: unknown } } | null;
  return Array.isArray(data?.data?.items) ? data.data.items as T[] : [];
}
function productName(item: MachineSuggestion) {
  const brand = String(item.brand || '').trim(); const model = String(item.model || '').trim();
  const full = brand && model.toLowerCase().startsWith(brand.toLowerCase()) ? model : [brand, model].filter(Boolean).join(' ');
  return [full, item.year && !full.includes(String(item.year)) ? item.year : ''].filter(Boolean).join(' ') || '未命名商品';
}
function configText(item: MachineSuggestion) { return [item.cpu, item.ram, item.storage, item.gpu, item.screen].filter(Boolean).join(' / ') || '配置待补充'; }
const STATUS_NAMES: Record<string, string> = { in_stock: '在库', sold: '已售', returning: '供应商退货中', returned: '已退货', renting: '租赁中', after_sale: '售后中', reserved: '已预留', on_way: '在途' };
function HighlightSN({ sn, query }: { sn: string; query: string }) {
  return query && sn.toLowerCase().endsWith(query.toLowerCase()) ? <>{sn.slice(0, sn.length - query.length)}<mark className="rounded bg-primary/15 px-0.5 font-semibold text-primary">{sn.slice(-query.length)}</mark></> : <>{sn}</>;
}

/** Database-backed suggestions; typing never selects a machine implicitly. */
export default function MachineSearchInput<T extends MachineSuggestion>({
  value, onChange, endpoint = '/api/inventory/lookup?context=inventory', onSelect, onSearch,
  placeholder = '输入 SN 后四位或型号自动匹配', ariaLabel = '搜索机器', disabled = false,
  minChars = 4, getItems = defaultItems, renderItem, className = '',
}: MachineSearchInputProps<T>) {
  const { active } = useWorkspace(); const listId = useId();
  const [items, setItems] = useState<T[]>([]); const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false); const [error, setError] = useState('');
  const [open, setOpen] = useState(false); const [focused, setFocused] = useState(false); const [highlighted, setHighlighted] = useState(-1);
  const [expanded, setExpanded] = useState(false); const [page, setPage] = useState(1); const [retry, setRetry] = useState(0);
  const [position, setPosition] = useState<{ left: number; top?: number; bottom?: number; width: number; maxHeight: number }>({ left: 0, top: 0, width: 0, maxHeight: 360 });
  const sequence = useRef(0); const abortRef = useRef<AbortController | null>(null); const selectedQuery = useRef<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null); const listRef = useRef<HTMLDivElement>(null);
  const limit = expanded ? 50 : 8; const query = value.trim();
  useLayoutEffect(() => () => { setOpen(false); setFocused(false); }, []);

  useEffect(() => {
    const requestId = ++sequence.current;
    if (!active || !focused || disabled || query.length < minChars || selectedQuery.current === query) {
      setOpen(false); setLoading(false); setItems([]); setError(''); return;
    }
    const controller = new AbortController(); abortRef.current = controller;
    const timer = window.setTimeout(async () => {
      if (sequence.current !== requestId || controller.signal.aborted) return;
      setLoading(true); setError(''); setOpen(true); setHighlighted(-1);
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
  }, [active, disabled, endpoint, focused, getItems, limit, minChars, page, query, retry]);

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
  useEffect(() => { listRef.current?.querySelector('[data-index="' + highlighted + '"]')?.scrollIntoView({ block: 'nearest' }); }, [highlighted]);
  function select(item: T) { selectedQuery.current = item.sn.trim(); ++sequence.current; abortRef.current?.abort(); setLoading(false); setOpen(false); setHighlighted(-1); onSelect(item); }
  function searchAll() { if (onSearch) { setOpen(false); onSearch(query); } else { setExpanded(true); setPage(1); setRetry(v => v + 1); } }
  const showList = active && open && !disabled && query.length >= minChars;

  return <div ref={containerRef} className={'relative ' + className}>
    <Search className="pointer-events-none absolute left-3 top-1/2 z-[1] h-4 w-4 -translate-y-1/2 text-ink-soft" aria-hidden="true" />
    <input type="search" role="combobox" value={value} disabled={disabled}
      onFocus={() => { setFocused(true); if (query.length >= minChars && selectedQuery.current !== query) { setLoading(true); setOpen(true); setRetry(v => v + 1); } }}
      onBlur={() => { ++sequence.current; abortRef.current?.abort(); setFocused(false); setOpen(false); setLoading(false); }}
      onChange={event => { ++sequence.current; abortRef.current?.abort(); selectedQuery.current = null; setItems([]); setHighlighted(-1); setPage(1); setExpanded(false); setError(""); setLoading(event.target.value.trim().length >= minChars); setOpen(event.target.value.trim().length >= minChars); onChange(event.target.value); }}
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); ++sequence.current; abortRef.current?.abort(); setOpen(false); setLoading(false); setHighlighted(-1); }
        else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); if (!loading && items.length) { setOpen(true); setHighlighted(current => event.key === 'ArrowDown' ? Math.min(current + 1, items.length - 1) : Math.max(current - 1, 0)); } }
        else if (event.key === 'Enter' && !loading && showList && highlighted >= 0 && items[highlighted]) { event.preventDefault(); select(items[highlighted]); }
        else if (event.key === 'Enter' && onSearch) { event.preventDefault(); setOpen(false); onSearch(query); }
      }}
      placeholder={placeholder} aria-label={ariaLabel} aria-autocomplete="list" aria-controls={listId} aria-expanded={showList}
      aria-activedescendant={showList && highlighted >= 0 ? listId + '-' + highlighted : undefined}
      className="field w-full pl-10 pr-10" />
    {loading && <LoaderCircle className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-primary" aria-label="搜索中" />}
    {showList && typeof document !== 'undefined' && createPortal(<div ref={listRef} style={position} className="dropdown-surface fixed z-[12000] flex flex-col overflow-hidden rounded-xl border border-line-strong bg-white shadow-xl animate-fade-in" onMouseDown={event => event.preventDefault()}>
      <div id={listId} role="listbox" aria-label="机器匹配结果" className="min-h-0 overflow-y-auto overscroll-contain">
        {loading ? <p role="status" className="px-4 py-4 text-center text-xs text-ink-soft">正在匹配机器…</p> : error ? <div role="alert" className="px-4 py-4 text-center text-xs text-danger">{error}<button type="button" onClick={() => setRetry(v => v + 1)} className="ml-2 text-primary underline">重试</button></div> : !items.length ? <p role="status" className="px-4 py-4 text-center text-xs text-ink-soft">没有符合当前业务条件的机器</p> : items.map((item, index) => <button key={item.id} id={listId + '-' + index} data-index={index} type="button" role="option" aria-selected={highlighted === index}
          onMouseEnter={() => setHighlighted(index)} onClick={() => select(item)}
          className={'flex w-full items-start gap-3 border-b border-line/60 px-3 py-3 text-left transition-colors last:border-b-0 ' + (highlighted === index ? 'bg-primary/10' : 'hover:bg-primary/5')}>
          {renderItem ? renderItem(item) : <span className="min-w-0 flex-1"><span className="flex items-start justify-between gap-2"><span className="text-[13px] font-medium text-ink-deep">{productName(item)}</span>{item.status && <span className="shrink-0 text-[11px] text-ink-soft" style={item.status === 'custom' && item.customStatusColor ? { color: item.customStatusColor } : undefined}>{item.customStatusName || STATUS_NAMES[item.status] || item.status}</span>}</span><span className="mt-1 block break-all font-mono text-xs text-ink-deep">SN <HighlightSN sn={item.sn} query={query} /></span><span className="mt-1 block text-[11px] text-ink-soft">{configText(item)}{item.warehouseName ? ' · ' + item.warehouseName : ''}</span></span>}
        </button>)}
      </div>
      {!loading && !error && total > 8 && !expanded && <button type="button" onClick={searchAll} className="shrink-0 border-t border-line/70 px-4 py-3 text-left text-xs font-medium text-primary transition-colors hover:bg-primary/5">查看全部 {total} 条结果</button>}
      {expanded && total > limit && <div className="flex shrink-0 items-center justify-between border-t border-line/70 px-3 py-2 text-xs text-ink-soft"><button type="button" disabled={page <= 1} onClick={() => setPage(v => v - 1)} className="btn-ghost p-1 disabled:opacity-30" aria-label="上一页匹配结果"><ChevronLeft className="h-4 w-4" /></button>{page} / {Math.ceil(total / limit)} · {total} 台<button type="button" disabled={page * limit >= total} onClick={() => setPage(v => v + 1)} className="btn-ghost p-1 disabled:opacity-30" aria-label="下一页匹配结果"><ChevronRight className="h-4 w-4" /></button></div>}
    </div>, document.body)}
  </div>;
}

