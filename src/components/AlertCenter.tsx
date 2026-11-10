'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Bell, CalendarClock, ChevronRight, LoaderCircle, RefreshCw, X } from 'lucide-react';

type AlertItem = {
  id: string;
  kind: string;
  level: 'info' | 'warning' | 'danger';
  title: string;
  detail: string;
  href: string;
};

type AlertPayload = { items?: AlertItem[] };

function levelClass(level: AlertItem['level']) {
  if (level === 'danger') return 'bg-danger/10 text-danger';
  if (level === 'warning') return 'bg-warning/10 text-warning';
  return 'bg-primary/10 text-primary';
}

function kindLabel(kind: string) {
  if (kind === 'rental') return '租赁';
  if (kind === 'after_sale') return '售后';
  if (kind === 'transfer') return '调拨';
  if (kind === 'users') return '账号';
  return '业务提醒';
}

export default function AlertCenter({ role }: { role: string }) {
  const pathname = usePathname();
  const [items, setItems] = useState<AlertItem[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const requestRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setRefreshing(true);
    setError('');
    try {
      const response = await fetch('/api/alerts', { cache: 'no-store', signal: controller.signal });
      const payload = await response.json() as { success?: boolean; data?: AlertPayload; error?: { message?: string } };
      if (!response.ok || !payload.success) {
        throw new Error(payload.error?.message || '消息加载失败，请重试');
      }
      setItems(Array.isArray(payload.data?.items) ? payload.data.items : []);
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(cause instanceof Error ? cause.message : '消息加载失败，请重试');
      }
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    if (role === 'viewer') return;
    void refresh();
    const interval = window.setInterval(() => void refresh(), 60_000);
    return () => {
      window.clearInterval(interval);
      requestRef.current?.abort();
    };
  }, [refresh, role]);

  useEffect(() => {
    if (!open) return;
    panelRef.current?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !containerRef.current?.contains(event.target)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  useEffect(() => setOpen(false), [pathname]);

  if (role === 'viewer') return null;

  return (
    <div ref={containerRef} className="relative shrink-0">
      <button
        ref={triggerRef}
        type="button"
        aria-label={items.length ? `消息，${items.length} 条待处理` : '消息'}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="alert-center-panel"
        title="消息"
        onClick={() => {
          const nextOpen = !open;
          setOpen(nextOpen);
          if (nextOpen) void refresh();
        }}
        className="relative inline-flex h-9 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-ink transition hover:bg-primary/8 hover:text-ink-deep active:scale-95"
      >
        <Bell className="h-4 w-4 text-primary" aria-hidden="true" />
        <span className="hidden min-[480px]:inline">消息</span>
        {items.length > 0 && <span aria-hidden="true" className="min-w-4 rounded-full bg-danger px-1 text-center text-[10px] leading-4 text-white">{items.length > 99 ? '99+' : items.length}</span>}
      </button>

      {open && (
        <section
          ref={panelRef}
          id="alert-center-panel"
          role="dialog"
          aria-label="消息"
          tabIndex={-1}
          className="fixed left-3 right-3 top-14 z-[2100] flex max-h-[min(72dvh,34rem)] flex-col overflow-hidden rounded-xl border border-line bg-white shadow-xl outline-none animate-fade-in sm:absolute sm:left-auto sm:right-0 sm:top-full sm:mt-2 sm:w-[min(24rem,calc(100vw-1.5rem))]"
        >
          <header className="flex shrink-0 items-center justify-between gap-3 border-b border-line/70 px-4 py-3">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-ink-deep">消息</h2>
              <p className="mt-0.5 text-[11px] text-ink-soft">{items.length ? `${items.length} 条待处理提醒` : '业务状态更新后，提醒会自动变化'}</p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <button type="button" onClick={() => void refresh()} disabled={refreshing} aria-label="刷新消息" title="刷新消息" className="rounded-md p-2 text-ink-soft transition hover:bg-primary/8 hover:text-primary active:scale-95 disabled:opacity-50">
                <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
              </button>
              <button type="button" onClick={() => { setOpen(false); triggerRef.current?.focus(); }} aria-label="关闭消息" className="rounded-md p-2 text-ink-soft transition hover:bg-primary/8 hover:text-ink-deep active:scale-95">
                <X className="h-4 w-4" />
              </button>
            </div>
          </header>

          {error && (
            <div role="alert" className="flex shrink-0 items-center justify-between gap-3 border-b border-danger/15 bg-danger/5 px-4 py-2.5 text-xs text-danger">
              <span>{error}</span>
              <button type="button" onClick={() => void refresh()} className="shrink-0 font-medium underline underline-offset-2">重试</button>
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            {loading && items.length === 0 ? (
              <div role="status" className="flex items-center justify-center gap-2 px-4 py-12 text-xs text-ink-soft"><LoaderCircle className="h-4 w-4 animate-spin" />正在加载消息…</div>
            ) : error && items.length === 0 ? (
              <div className="flex flex-col items-center px-5 py-10 text-center">
                <span className="rounded-full bg-danger/8 p-3 text-danger"><AlertTriangle className="h-5 w-5" /></span>
                <p className="mt-3 text-sm font-medium text-ink-deep">暂时无法加载消息</p>
                <button type="button" onClick={() => void refresh()} className="mt-2 rounded px-3 py-1.5 text-xs font-medium text-primary transition hover:bg-primary/8 active:scale-95">重新加载</button>
              </div>
            ) : items.length === 0 ? (
              <div className="flex flex-col items-center px-5 py-10 text-center">
                <span className="rounded-full bg-primary/8 p-3 text-primary"><Bell className="h-5 w-5" /></span>
                <p className="mt-3 text-sm font-medium text-ink-deep">当前没有待处理消息</p>
                <p className="mt-1 text-xs text-ink-soft">临近到期、逾期或待处理事项会显示在这里。</p>
              </div>
            ) : (
              <ul className="divide-y divide-line/70">
                {items.map((item) => (
                  <li key={item.id}>
                    <Link href={item.href} onClick={() => setOpen(false)} className="flex items-start gap-3 px-4 py-3.5 transition-colors hover:bg-primary/[0.035] focus-visible:bg-primary/[0.035] focus-visible:outline-none">
                      <span className={`mt-0.5 shrink-0 rounded-lg p-2 ${levelClass(item.level)}`} aria-hidden="true">{item.kind === 'rental' ? <CalendarClock className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}</span>
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-1.5">
                          <span className="break-words text-sm font-medium text-ink-deep [overflow-wrap:anywhere]">{item.title}</span>
                          <span className={`rounded px-1.5 py-0.5 text-[10px] ${levelClass(item.level)}`}>{kindLabel(item.kind)}</span>
                        </span>
                        <span className="mt-1 block break-words text-xs leading-relaxed text-ink-soft">{item.detail}</span>
                      </span>
                      <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-ink-soft" aria-hidden="true" />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <footer className="flex shrink-0 items-center justify-between border-t border-line/70 px-4 py-2.5 text-[11px] text-ink-soft">
            <span>{refreshing ? '正在更新…' : '每分钟自动更新'}</span>
            <button type="button" onClick={() => { setOpen(false); triggerRef.current?.focus(); }} className="rounded px-2 py-1 font-medium text-primary transition hover:bg-primary/8 active:scale-95">完成</button>
          </footer>
        </section>
      )}
    </div>
  );
}
