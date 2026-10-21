'use client';

import { useId, useState, type InputHTMLAttributes, type ReactNode } from 'react';
import { Eye, EyeOff, LockKeyhole } from 'lucide-react';
import { BrandLogo, BrandMark } from '@/components/Brand';
import AuthAmbient from '@/components/AuthAmbient';

export async function accountRequest<T = Record<string, unknown>>(url: string, options: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal, cache: 'no-store' });
    if ((response.status === 401 || response.status === 403) && !/^\/api\/auth\/(login|register)(?:\?|$)/.test(url)) window.dispatchEvent(new Event('auth-session-invalid'));
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.success) throw new Error(payload?.error?.message || (response.status >= 500 ? '服务暂时不可用，请稍后重试' : '请求失败，请重试'));
    return payload.data as T;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw new Error('请求超时，请检查网络后重试');
    if (error instanceof TypeError) throw new Error('暂时无法连接服务，请检查网络后重试');
    throw error;
  } finally { window.clearTimeout(timer); }
}

export function PasswordField({ label = '密码', className = '', ...props }: InputHTMLAttributes<HTMLInputElement> & { label?: string }) {
  const id = useId(); const [visible, setVisible] = useState(false); const [caps, setCaps] = useState(false);
  return <label className={`block text-sm text-ink ${className}`} htmlFor={id}>{label}<div className="relative mt-1.5"><LockKeyhole aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-soft" /><input {...props} id={id} type={visible ? 'text' : 'password'} className="field pl-10 pr-11" onKeyUp={event => { setCaps(event.getModifierState('CapsLock')); props.onKeyUp?.(event); }} onKeyDown={event => { setCaps(event.getModifierState('CapsLock')); props.onKeyDown?.(event); }} onBlur={event => { setCaps(false); props.onBlur?.(event); }} /><button type="button" onClick={() => setVisible(!visible)} aria-label={visible ? `隐藏${label}` : `显示${label}`} aria-pressed={visible} className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-2 text-ink-soft transition hover:bg-primary/8 hover:text-primary active:scale-95">{visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button></div>{caps && <span role="status" className="mt-1.5 block text-xs text-amber-700">大写锁定已开启</span>}</label>;
}

export function AuthShell({ children }: { children: ReactNode }) {
  return <div className="relative isolate -mx-4 min-h-screen overflow-hidden px-4">
    <AuthAmbient />
    <div className="absolute left-5 top-5 z-20 animate-fade-in sm:left-8 sm:top-7">
      <BrandLogo />
    </div>
    <div className="relative z-10 mx-auto flex min-h-screen w-full max-w-5xl items-center justify-center py-24 lg:justify-end lg:py-12">
      <div aria-hidden="true" className="sugrid-auth-emblem"><BrandMark /></div>
      <section className="glass w-full max-w-[440px] rounded-3xl p-6 shadow-xl sm:p-8 animate-scale-in">{children}</section>
    </div>
  </div>;
}

