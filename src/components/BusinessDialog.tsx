'use client';

import { ReactNode, useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { useWorkspace } from '@/components/WorkspaceContext';

export default function BusinessDialog({ title, description, children, footer, onClose }: { title: string; description?: string; children: ReactNode; footer?: ReactNode; onClose: () => void }) {
  const { active, user } = useWorkspace();
  const panel = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  useEffect(() => { close.current = onClose; }, [onClose]);
  useEffect(() => {
    if (!active) return;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panel.current?.focus();
    function handleKey(event: KeyboardEvent) {
      if (event.key === 'Escape') close.current();
      if (event.key === 'Tab') {
        const elements = panel.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), a[href], [tabindex="0"]');
        if (!elements?.length) return;
        const first = elements[0], last = elements[elements.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    }
    window.addEventListener('keydown', handleKey);
    return () => { document.body.style.overflow = overflow; window.removeEventListener('keydown', handleKey); previous?.focus(); };
  }, [active]);
  if (!active) return null;
  return <div style={{ top: user ? 100 : 0 }} className="fixed inset-0 z-[110] flex items-center justify-center bg-black/25 p-3 backdrop-blur-sm animate-fade-in" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} className="glass-strong flex max-h-[calc(100dvh-124px)] w-full max-w-2xl flex-col overflow-hidden rounded-2xl shadow-2xl outline-none">
      <header className="flex shrink-0 items-start justify-between gap-3 border-b border-line/70 p-5"><div><h2 className="text-base font-semibold text-ink-deep">{title}</h2>{description && <p className="mt-1 text-xs text-ink-soft">{description}</p>}</div><button type="button" onClick={onClose} aria-label="关闭" className="btn-ghost p-2"><X className="h-4 w-4" /></button></header>
      <div className="min-h-0 flex-1 overflow-y-auto p-5">{children}</div>
      {footer && <footer className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-line/70 bg-white/60 px-5 py-3">{footer}</footer>}
    </section>
  </div>;
}

