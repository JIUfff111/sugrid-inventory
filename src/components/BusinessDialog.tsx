'use client';

import { ReactNode, useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { useWorkspace } from '@/components/WorkspaceContext';

export default function BusinessDialog({ title, description, children, footer, onClose, size = 'default', placement = 'center' }: { title: string; description?: string; children: ReactNode; footer?: ReactNode; onClose: () => void; size?: 'default' | 'wide'; placement?: 'center' | 'side' }) {
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
        const elements = [...(panel.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, a[href], [tabindex="0"]') ?? [])].filter(element => element.getClientRects().length > 0 && element.tabIndex >= 0);
        if (!elements.length) return;
        const first = elements[0], last = elements[elements.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    }
    window.addEventListener('keydown', handleKey);
    return () => { document.body.style.overflow = overflow; window.removeEventListener('keydown', handleKey); previous?.focus(); };
  }, [active]);
  if (!active) return null;
  const side = placement === 'side';
  return <div style={side ? undefined : { top: user ? 100 : 0 }} className={`fixed inset-0 z-[110] flex bg-black/25 backdrop-blur-sm motion-safe:animate-fade-in ${side ? 'justify-end md:top-[100px]' : 'items-center justify-center p-3'}`} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} className={`flex w-full flex-col overflow-hidden shadow-2xl outline-none ${side ? `h-full bg-[#f9fbff] md:border-l md:border-line ${size === 'wide' ? 'md:max-w-3xl' : 'md:max-w-xl'}` : `glass-strong max-h-[calc(100dvh-124px)] rounded-2xl ${size === 'wide' ? 'max-w-5xl' : 'max-w-2xl'}`}`}>
      <header className="flex shrink-0 items-start justify-between gap-3 border-b border-line/70 p-5"><div><h2 className="text-base font-semibold text-ink-deep">{title}</h2>{description && <p className="mt-1 text-xs text-ink-soft">{description}</p>}</div><button type="button" onClick={onClose} aria-label="关闭" className="btn-ghost p-2"><X className="h-4 w-4" /></button></header>
      <div className="min-h-0 flex-1 overflow-y-auto p-5">{children}</div>
      {footer && <footer className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-line/70 bg-white/60 px-5 py-3">{footer}</footer>}
    </section>
  </div>;
}

