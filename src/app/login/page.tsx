'use client';

import Link from 'next/link';
import { FormEvent, useState } from 'react';
import { ArrowRight, LoaderCircle, UserRound } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { accountRequest, AuthShell, PasswordField } from '@/components/AuthControls';
import { canVisit } from '@/lib/access';

function destination(role: string) {
  const fallback = role === 'admin' ? '/' : '/inventory';
  const params = new URLSearchParams(window.location.search); const requested = params.get('returnTo') || params.get('next');
  if (!requested || !requested.startsWith('/') || requested.startsWith('//') || /[\\\u0000-\u001f]/.test(requested)) return fallback;
  const target = new URL(requested, window.location.origin);
  if (target.origin !== window.location.origin || ['/login', '/register'].includes(target.pathname) || !canVisit(role, target.pathname)) return fallback;
  return `${target.pathname}${target.search}${target.hash}`;
}

export default function LoginPage() {
  const router = useRouter(); const [username, setUsername] = useState(''); const [password, setPassword] = useState(''); const [error, setError] = useState(''); const [loading, setLoading] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); if (loading) return; setLoading(true); setError('');
    try { const data = await accountRequest<{user:{role:string}}>('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) }); router.replace(destination(data.user.role)); router.refresh(); }
    catch (err) { setError(err instanceof Error ? err.message : '登录失败，请重试'); } finally { setLoading(false); }
  }
  return <AuthShell><div className="mb-7"><p className="text-xs font-semibold tracking-[.14em] text-primary">SUGRID WORKSPACE</p><h2 className="mt-3 text-2xl font-semibold text-ink-deep">欢迎回到溯格</h2><p className="mt-2 text-sm text-ink-soft">登录后继续你的工作。</p></div><form onSubmit={submit} className="space-y-5"><label className="block text-sm text-ink" htmlFor="login-username">用户名<div className="relative mt-1.5"><UserRound aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-soft" /><input id="login-username" name="username" value={username} onChange={event => setUsername(event.target.value)} className="field pl-10" autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={64} required /></div></label><PasswordField value={password} onChange={event => setPassword(event.target.value)} name="password" autoComplete="current-password" maxLength={200} required />{error && <p role="alert" className="rounded-xl border border-danger/15 bg-danger/6 px-3 py-3 text-sm leading-6 text-danger">{error}</p>}<button type="submit" disabled={loading} className="btn-primary inline-flex w-full items-center justify-center gap-2 py-3">{loading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}{loading ? '正在登录…' : error ? '重新登录' : '登录工作台'}</button></form><div className="mt-6 border-t border-line/60 pt-5 text-center text-sm text-ink-soft">还没有账号？<Link href="/register" className="ml-1 font-medium text-primary transition hover:text-primary-deep">申请加入</Link></div></AuthShell>;
}
