'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Bell, CalendarClock, ChevronRight, X } from 'lucide-react';

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

export default function AlertCenter() {
  const pathname = usePathname();
  const [items, setItems] = useState<AlertItem[]>([]);
  const [open, setOpen] = useState(false);

  const shouldCheck = useMemo(() => pathname === '/' || pathname === '/rental' || pathname === '/after-sales' || pathname.startsWith('/inventory'), [pathname]);

  useEffect(() => {
    if (!shouldCheck) return;
    let cancelled = false;
    fetch('/api/alerts', { cache: 'no-store' })
      .then(async (response) => {
        if (response.status === 401 || response.status === 403) return null;
        const payload = await response.json() as { success?: boolean; data?: AlertPayload };
        return payload.success ? payload.data : null;
      })
      .then((data) => {
        if (cancelled || !data?.items?.length) return;
        const day = new Date().toISOString().slice(0, 10);
        const seenKey = `zcode-alerts:${day}`;
        let seen: string[] = [];
        try { seen = JSON.parse(sessionStorage.getItem(seenKey) || '[]') as string[]; } catch { /* ignore */ }
        const unseen = data.items.filter((item) => !seen.includes(item.id));
        if (!unseen.length) return;
        try { sessionStorage.setItem(seenKey, JSON.stringify([...seen, ...unseen.map((item) => item.id)].slice(-100))); } catch { /* ignore */ }
        setItems(unseen);
        setOpen(true);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [shouldCheck]);

  if (!open || items.length === 0) return null;

  return (
    <div className="fixed inset-0 z-[140] flex items-start justify-center bg-ink-deep/20 p-4 pt-[12vh] backdrop-blur-[2px] animate-fade-in" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}>
      <section role="dialog" aria-modal="true" aria-labelledby="alert-center-title" className="glass w-full max-w-lg overflow-hidden rounded-2xl shadow-2xl animate-scale-in">
        <header className="flex items-start justify-between border-b border-line/70 px-5 py-4">
          <div className="flex items-start gap-3">
            <span className="rounded-xl bg-warning/10 p-2 text-warning"><Bell className="h-5 w-5" /></span>
            <div><h2 id="alert-center-title" className="text-base font-semibold text-ink-deep">需要关注的业务提醒</h2><p className="mt-1 text-xs text-ink-soft">共有 {items.length} 条待处理提醒</p></div>
          </div>
          <button type="button" onClick={() => setOpen(false)} aria-label="关闭提醒" className="rounded-lg p-2 text-ink-soft transition-colors hover:bg-white/70 hover:text-ink-deep"><X className="h-4 w-4" /></button>
        </header>
        <div className="max-h-[60vh] divide-y divide-line/70 overflow-y-auto">
          {items.map((item) => (
            <Link key={item.id} href={item.href} onClick={() => setOpen(false)} className="flex items-start gap-3 px-5 py-4 transition-colors hover:bg-white/55">
              <span className={`mt-0.5 rounded-lg p-2 ${levelClass(item.level)}`}>{item.kind === 'rental' ? <CalendarClock className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}</span>
              <span className="min-w-0 flex-1"><span className="block text-sm font-medium text-ink-deep">{item.title}</span><span className="mt-1 block text-xs leading-relaxed text-ink-soft">{item.detail}</span></span>
              <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-ink-soft" />
            </Link>
          ))}
        </div>
        <footer className="flex justify-end border-t border-line/70 px-5 py-3"><button type="button" onClick={() => setOpen(false)} className="btn-primary px-4 py-2 text-xs">知道了</button></footer>
      </section>
    </div>
  );
}
