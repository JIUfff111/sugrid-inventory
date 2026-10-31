"use client";

import { Activity, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react';
import dynamic from 'next/dynamic';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import TopNav from '@/components/TopNav';
import { TabBar, type Tab } from '@/components/TabBar';
import AlertCenter from '@/components/AlertCenter';
import ConfirmDialog from '@/components/ConfirmDialog';
import { WorkspaceProvider } from '@/components/WorkspaceContext';
import { canVisit, type SessionUser } from '@/lib/access';
import { LoaderCircle, RefreshCw, WifiOff } from 'lucide-react';

const Loading = () => <div className="flex min-h-40 items-center justify-center text-sm text-ink-soft"><LoaderCircle className="mr-2 h-4 w-4 animate-spin" />正在加载…</div>;
const workspaceRoutes: Record<string, { id: string; label: string; Component: ComponentType }> = {
  '/': { id: 'home', label: '首页', Component: dynamic(() => import('@/app/page'), { loading: Loading }) },
  '/orders': { id: 'orders', label: '采购订单', Component: dynamic(() => import('@/app/orders/page'), { loading: Loading }) },
  '/inventory': { id: 'inventory', label: '在库清单', Component: dynamic(() => import('@/app/inventory/page'), { loading: Loading }) },
  '/inventory/analysis': { id: 'inventory-analysis', label: '库存分析', Component: dynamic(() => import('@/app/inventory/analysis/page'), { loading: Loading }) },
  '/suppliers': { id: 'suppliers', label: '供应商', Component: dynamic(() => import('@/app/suppliers/page'), { loading: Loading }) },
  '/sales/out': { id: 'sales-out', label: '销售出库', Component: dynamic(() => import('@/app/sales/out/page'), { loading: Loading }) },
  '/sales/records': { id: 'sales-records', label: '销售出库管理', Component: dynamic(() => import('@/app/sales/records/page'), { loading: Loading }) },
  '/sales/return': { id: 'sales-return', label: '供应商退货', Component: dynamic(() => import('@/app/sales/return/page'), { loading: Loading }) },
  '/rental': { id: 'rental', label: '租赁管理', Component: dynamic(() => import('@/app/rental/page'), { loading: Loading }) },
  '/after-sales': { id: 'after-sales', label: '售后处理', Component: dynamic(() => import('@/app/after-sales/page'), { loading: Loading }) },
  '/warehouses': { id: 'warehouses', label: '仓库管理', Component: dynamic(() => import('@/app/warehouses/page'), { loading: Loading }) },
  '/settings/users': { id: 'users', label: '账号与权限', Component: dynamic(() => import('@/app/settings/users/page'), { loading: Loading }) },
  '/settings/data': { id: 'data-management', label: '数据管理', Component: dynamic(() => import('@/app/settings/data/page'), { loading: Loading }) },
  '/settings/account': { id: 'account', label: '个人账号', Component: dynamic(() => import('@/app/settings/account/page'), { loading: Loading }) },
  '/sales/channels': { id: 'channels', label: '销售渠道', Component: dynamic(() => import('@/app/sales/channels/page'), { loading: Loading }) },
  '/settings/print': { id: 'settings-print', label: '标签设计', Component: dynamic(() => import('@/app/settings/print/page'), { loading: Loading }) },
  '/settings/print/preview': { id: 'settings-print-preview', label: '打印预览', Component: dynamic(() => import('@/app/settings/print/preview/page'), { loading: Loading }) },
};
const aliases: Record<string, string> = { '/transfers': '/inventory?view=transfers', '/inventory/movements': '/inventory?view=movements', '/after-sales/stock': '/after-sales', '/sales/customer-return': '/after-sales' };

function WorkspaceSlot({ tab, active, user, onDirtyChange }: { tab: Tab; active: boolean; user: SessionUser; onDirtyChange: (id: string, source: string, dirty: boolean) => void }) {
  const route = workspaceRoutes[new URL(tab.href, 'http://workspace.local').pathname];
  const setDirty = useCallback((source: string, dirty: boolean) => onDirtyChange(tab.id, source, dirty), [onDirtyChange, tab.id]);
  if (!route) return null;
  const Component = route.Component;
  return <WorkspaceProvider active={active} href={tab.href} user={user} setDirty={setDirty}>
    <Activity mode={active ? 'visible' : 'hidden'}>
      <section data-workspace-id={tab.id} data-workspace-active={active} className="h-full overflow-y-auto overscroll-contain px-3 py-4 sm:px-6 lg:px-8 lg:py-6" aria-label={tab.label}>
        <Component />
      </section>
    </Activity>
  </WorkspaceProvider>;
}

function WorkspaceHost({ user, pathname, href, testMode, children }: { user: SessionUser; pathname: string; href: string; testMode: boolean; children: ReactNode }) {
  const router = useRouter();
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [visited, setVisited] = useState<Set<string>>(() => new Set());
  const [hydrated, setHydrated] = useState(false);
  const [dirtyTabs, setDirtyTabs] = useState<Record<string, Record<string, boolean>>>({});
  const [pendingClose, setPendingClose] = useState<string | null>(null);
  const [instances, setInstances] = useState<Record<string, number>>({});
  const closingId = useRef<string | null>(null);
  const closingHref = useRef<string | null>(null);
  const storageKey = testMode ? `app_tabs:test:${user.id}` : `app_tabs:${user.id}`;
  const activeRoute = workspaceRoutes[pathname];
  const activeId = activeRoute?.id || '';
  const onDirtyChange = useCallback((id: string, source: string, dirty: boolean) => setDirtyTabs(current => {
    if (!!current[id]?.[source] === dirty) return current;
    return { ...current, [id]: { ...current[id], [source]: dirty } };
  }), []);
  const dirtyIds = useMemo(() => new Set(Object.entries(dirtyTabs).filter(([, entries]) => Object.values(entries).some(Boolean)).map(([id]) => id)), [dirtyTabs]);

  useEffect(() => {
    let restored: Tab[] = [];
    try {
      const stored = JSON.parse(sessionStorage.getItem(storageKey) || '[]');
      restored = Array.isArray(stored) ? stored.flatMap((item: Tab) => {
        if (typeof item?.href !== 'string') return [];
        const path = new URL(item.href, window.location.origin).pathname;
        const route = workspaceRoutes[path];
        return route && canVisit(user.role, path) ? [{ id: route.id, label: route.label, href: item.href, pinned: route.id === 'home' }] : [];
      }).filter((tab: Tab, index: number, all: Tab[]) => all.findIndex(t => t.id === tab.id) === index) : [];
    } catch { /* Invalid tab metadata never blocks the workspace. */ }
    const homeTab: Tab[] = user.role === 'admin' ? [{ id: 'home', label: '首页', href: '/', pinned: true }] : [];
    setTabs([...homeTab, ...restored.filter(tab => tab.id !== 'home')]);
    setHydrated(true);
  }, [storageKey, user.role]);

  useEffect(() => {
    if (!hydrated || !activeRoute || !canVisit(user.role, pathname)) return;
    if (closingId.current === activeRoute.id && closingHref.current === href) return;
    closingId.current = null;
    closingHref.current = null;
    setTabs(current => {
      const next: Tab = { id: activeRoute.id, label: activeRoute.label, href, pinned: activeRoute.id === 'home' };
      const existing = current.find(tab => tab.id === next.id);
      if (!existing) return [...current, next];
      return existing.href === href && existing.pinned === next.pinned ? current : current.map(tab => tab.id === next.id ? next : tab);
    });
    setVisited(current => current.has(activeRoute.id) ? current : new Set([...current, activeRoute.id]));
  }, [activeRoute, href, hydrated, pathname, user.role]);

  useEffect(() => {
    if (hydrated) { try { sessionStorage.setItem(storageKey, JSON.stringify(tabs)); } catch {} }
  }, [hydrated, storageKey, tabs]);
  useEffect(() => {
    if (!dirtyIds.size) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [dirtyIds]);
  useEffect(() => {
    setTabs(current => current.filter(tab => canVisit(user.role, new URL(tab.href, 'http://workspace.local').pathname)));
  }, [user.role]);

  const closeTab = (id: string) => {
    if (tabs.find(tab => tab.id === id)?.pinned) return;
    const remaining = tabs.filter(tab => tab.id !== id);
    const index = tabs.findIndex(tab => tab.id === id);
    if (id === activeId) { closingId.current = id; closingHref.current = href; }
    setTabs(remaining);
    setVisited(current => { const next = new Set(current); next.delete(id); return next; });
    setDirtyTabs(current => { const next = { ...current }; delete next[id]; return next; });
    setPendingClose(null);
    if (id === activeId) {
      const target = (remaining[index] || remaining[index - 1] || remaining[0])?.href || (user.role === 'admin' ? '/' : '/inventory');
      if (!remaining.length && target === href && activeRoute) {
        closingId.current = null;
        closingHref.current = null;
        setInstances(current => ({ ...current, [id]: (current[id] || 0) + 1 }));
        setTabs([{ id, label: activeRoute.label, href }]);
        setVisited(new Set([id]));
      } else router.push(target);
    }
  };

  return <>
    <TopNav user={user} />
    {testMode && <div role="status" className="flex h-6 items-center justify-center border-y border-primary/15 bg-primary/8 px-3 text-[11px] font-medium text-primary">隔离测试库 · 此处录入不会写入正式数据库</div>}
    <TabBar tabs={tabs} activeTabId={activeId} dirtyIds={dirtyIds} onTabClose={id => dirtyIds.has(id) ? setPendingClose(id) : closeTab(id)} />
    <AlertCenter />
    <main className={`relative overflow-hidden ${tabs.length ? (testMode ? 'h-[calc(100dvh-124px)]' : 'h-[calc(100dvh-100px)]') : (testMode ? 'h-[calc(100dvh-80px)]' : 'h-[calc(100dvh-56px)]')}`}>
      {tabs.filter(tab => visited.has(tab.id)).map(tab => <WorkspaceSlot key={`${tab.id}:${instances[tab.id] || 0}`} tab={tab} active={tab.id === activeId} user={user} onDirtyChange={onDirtyChange} />)}
      {!activeRoute && <div className="h-full overflow-y-auto px-4 py-6">{children}</div>}
      {activeRoute && (!hydrated || !visited.has(activeId)) && <Loading />}
    </main>
    <ConfirmDialog isOpen={pendingClose !== null} title="关闭未保存的标签？" message="此标签内有未提交内容，关闭后将放弃这些修改。" cancelText="继续编辑" confirmText="关闭并放弃" danger onCancel={() => setPendingClose(null)} onConfirm={() => { if (pendingClose) closeTab(pendingClose); }} />
  </>;
}

function AuthenticatedLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const isPublic = pathname === '/login' || pathname === '/register';
  const [user, setUser] = useState<SessionUser | null>(null);
  const [testMode, setTestMode] = useState(false);
  const [checking, setChecking] = useState(true);
  const [authError, setAuthError] = useState('');
  const [retryKey, setRetryKey] = useState(0);
  const href = pathname + (searchParams.size ? `?${searchParams.toString()}` : '');
  const returnHref = useRef(href);
  useEffect(() => { returnHref.current = href; }, [href]);
  useEffect(() => {
    if (isPublic) { setUser(null); setChecking(false); return; }
    let disposed = false;
    let controller: AbortController | null = null;
    let inFlight = false;
    async function check() {
      if (inFlight) return;
      inFlight = true;
      controller = new AbortController();
      const timeout = window.setTimeout(() => controller?.abort(), 8000);
      try {
        const response = await fetch('/api/auth/me', { cache: 'no-store', signal: controller.signal });
        if (disposed) return;
        if (response.status === 401 || response.status === 403) {
          for (const key of Object.keys(sessionStorage)) if (key.startsWith('app_tabs:')) sessionStorage.removeItem(key);
          setUser(null); setAuthError('');
          setTestMode(false);
          router.replace('/login?returnTo=' + encodeURIComponent(returnHref.current)); return;
        }
        const payload = await response.json();
        if (!response.ok || !payload.success || !payload.data?.user) throw new Error('登录服务暂时不可用，请稍后重试');
        if (disposed) return;
        setUser(payload.data.user);
        setTestMode(payload.data.testMode === true);
        setAuthError('');
      } catch { if (!disposed) setAuthError('暂时无法连接登录服务，已保留当前操作。请检查网络后重试。'); }
      finally { window.clearTimeout(timeout); inFlight = false; if (!disposed) setChecking(false); }
    }
    void check();
    const focus = () => { void check(); };
    window.addEventListener('focus', focus);
    window.addEventListener('account-updated', focus);
    window.addEventListener('auth-session-invalid', focus);
    const interval = window.setInterval(focus, 60000);
    return () => { disposed = true; controller?.abort(); window.clearInterval(interval); window.removeEventListener('focus', focus); window.removeEventListener('account-updated', focus); window.removeEventListener('auth-session-invalid', focus); };
  }, [isPublic, router, retryKey]);
  useEffect(() => {
    if (isPublic || !user) return;
    if (aliases[pathname]) router.replace(aliases[pathname]);
    else if (!canVisit(user.role, pathname)) router.replace('/inventory');
  }, [isPublic, pathname, router, user]);
  if (isPublic) return <main className="min-h-screen px-4">{children}</main>;
  if (checking) return <div className="flex min-h-screen items-center justify-center text-ink-soft"><LoaderCircle className="mr-2 h-5 w-5 animate-spin" />正在验证登录…</div>;
  if (!user) return <div className="flex min-h-screen flex-col items-center justify-center gap-4 px-6 text-center text-ink-soft"><WifiOff className="h-8 w-8 text-primary" /><p>{authError || '正在连接登录服务…'}</p><button type="button" onClick={() => { setChecking(true); setRetryKey(key => key + 1); }} className="btn-primary inline-flex items-center gap-2"><RefreshCw className="h-4 w-4" />重新验证</button></div>;
  if (!canVisit(user.role, pathname) || aliases[pathname]) return <Loading />;
  const permissionKey = `${testMode ? 'test' : 'production'}:${user.id}:${user.role}:${user.warehouses.map(warehouse => `${warehouse.id}:${warehouse.status}`).sort().join(',')}`;
  return <>{authError && <div role="alert" className="fixed bottom-4 left-1/2 z-[9999] flex w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 items-center gap-3 rounded-xl border border-warn/25 bg-white/95 p-4 text-xs shadow-lg"><WifiOff className="h-4 w-4 shrink-0 text-warn" /><span className="flex-1">{authError}</span><button type="button" onClick={() => setRetryKey(key => key + 1)} className="shrink-0 text-primary">重试</button></div>}<WorkspaceHost key={permissionKey} user={user} pathname={pathname} href={href} testMode={testMode}>{children}</WorkspaceHost></>;
}

export default function ClientLayout({ children }: { children: ReactNode }) {
  return <Suspense fallback={<Loading />}><AuthenticatedLayout>{children}</AuthenticatedLayout></Suspense>;
}

