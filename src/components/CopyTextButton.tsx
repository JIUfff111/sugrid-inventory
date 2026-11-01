'use client';

import { useEffect, useState, type MouseEvent } from 'react';
import { Check, Copy, TriangleAlert } from 'lucide-react';

export default function CopyTextButton({ value, label = '内容' }: { value: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  useEffect(() => {
    if (state === 'idle') return;
    const timeout = window.setTimeout(() => setState('idle'), 1600);
    return () => window.clearTimeout(timeout);
  }, [state]);

  async function copy(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    try {
      if (navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(value);
          setState('copied');
          return;
        } catch { /* Fall back for non-secure LAN origins and denied clipboard access. */ }
      }
      {
        const input = document.createElement('textarea');
        input.value = value;
        input.setAttribute('readonly', '');
        input.style.position = 'fixed';
        input.style.opacity = '0';
        document.body.appendChild(input);
        input.select();
        const copied = document.execCommand('copy');
        input.remove();
        if (!copied) throw new Error('copy failed');
      }
      setState('copied');
    } catch {
      setState('failed');
    }
  }

  const title = state === 'copied' ? `${label}已复制` : state === 'failed' ? '复制失败，请手动选择' : `复制${label}`;
  return <button type="button" onClick={copy} disabled={!value} title={title} aria-label={title}
    className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-soft transition hover:-translate-y-px hover:bg-primary/10 hover:text-primary active:translate-y-0 disabled:opacity-40">
    {state === 'copied' ? <Check className="h-3.5 w-3.5 text-success" /> : state === 'failed' ? <TriangleAlert className="h-3.5 w-3.5 text-danger" /> : <Copy className="h-3.5 w-3.5" />}
    <span className="sr-only" aria-live="polite">{title}</span>
  </button>;
}
