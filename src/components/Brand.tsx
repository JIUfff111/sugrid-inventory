import type { SVGProps } from 'react';

/** SUGRID: an open grid traced by one continuous, returning path. */
export function BrandMark({ className = '', ...props }: SVGProps<SVGSVGElement>) {
  return <svg viewBox="0 0 48 48" fill="none" aria-hidden="true" className={className} {...props}>
    <path d="M37 9H16a7 7 0 0 0-7 7v8h23a7 7 0 0 1 7 7v1a7 7 0 0 1-7 7H11" stroke="currentColor" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M24 9v7m0 16v7M9 24v8m30-16v8" stroke="currentColor" strokeWidth="5" strokeLinecap="round" />
  </svg>;
}

export function BrandLogo({ className = '', compact = false }: { className?: string; compact?: boolean }) {
  return <span className={`inline-flex items-center gap-2.5 ${className}`} aria-label="溯格 SUGRID">
    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary text-white shadow-sm"><BrandMark className="h-8 w-8" /></span>
    {!compact && <span className="flex flex-col text-left"><span className="text-xl font-bold leading-tight tracking-[0.12em] text-ink-deep">溯格</span><span className="mt-0.5 text-[9px] font-semibold leading-tight tracking-[0.2em] text-primary">SUGRID</span></span>}
  </span>;
}
