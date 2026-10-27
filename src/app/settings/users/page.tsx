'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Check, ChevronLeft, ChevronRight, KeyRound, LoaderCircle, Pencil, Plus, RefreshCw, Search, ShieldCheck, Trash2, Users } from 'lucide-react';
import BusinessDialog from '@/components/BusinessDialog';
import ConfirmDialog from '@/components/ConfirmDialog';
import CustomSelect from '@/components/CustomSelect';
import Toast, { type ToastType } from '@/components/Toast';
import { accountRequest, PasswordField } from '@/components/AuthControls';
import { useWorkspace, useWorkspaceDirty } from '@/components/WorkspaceContext';

type Warehouse = { id: string; code: string; name: string; status: string };
type User = { id: string; username: string; realName: string | null; role: string; status: string; isSystemAccount?: boolean; warehouses: Warehouse[] };
type Mode = 'create' | 'profile' | 'permissions' | 'review' | 'password';
type Pagination = { page: number; pageSize: number; total: number; totalPages: number };
const statusNames: Record<string, string> = { pending: '待审核', active: '正常', rejected: '已拒绝', disabled: '已停用' };
const roles = [{ value: 'warehouse_manager', label: '分仓管' }, { value: 'admin', label: '管理员' }];
const emptyDraft = { username: '', realName: '', password: '', confirm: '', role: 'warehouse_manager', status: 'active', warehouseIds: [] as string[] };
const emptyFilters = { search: '', status: '', role: '', warehouseId: '' };
const titles: Record<Mode, string> = { create: '创建账号', profile: '编辑资料', permissions: '分配权限', review: '审核注册申请', password: '重置密码' };

export default function UsersPage() {
  const { active, activeRef, user: actor } = useWorkspace();
  const [users, setUsers] = useState<User[]>([]); const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [filters, setFilters] = useState(emptyFilters); const [query, setQuery] = useState(emptyFilters); const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState<Pagination>({ page: 1, pageSize: 20, total: 0, totalPages: 1 });
  const [selected, setSelected] = useState<User | null>(null); const [mode, setMode] = useState<Mode | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<User | null>(null);
  const [draft, setDraft] = useState(emptyDraft); const [initial, setInitial] = useState(JSON.stringify(emptyDraft)); const [formError, setFormError] = useState('');
  const [confirm, setConfirm] = useState<'discard' | 'save' | null>(null); const [toast, setToast] = useState<{message:string;type:ToastType}|null>(null);
  const dirty = !!mode && JSON.stringify(draft) !== initial; useWorkspaceDirty(dirty);
  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const params = new URLSearchParams({ ...query, page: String(page), pageSize: '20' });
      const data = await accountRequest<{users:User[];warehouses:Warehouse[];pagination:Pagination}>(`/api/users?${params}`);
      if (!activeRef.current) return;
      if (page > Math.max(1, data.pagination.totalPages)) { setPage(Math.max(1, data.pagination.totalPages)); return; }
      setUsers(data.users); setWarehouses(data.warehouses); setPagination(data.pagination);
    } catch (err) { if (activeRef.current) setError(err instanceof Error ? err.message : '账号加载失败'); }
    finally { if (activeRef.current) setLoading(false); }
  }, [activeRef, page, query]);
  useEffect(() => { if (active) void load(); }, [active, load]);
  function open(next: Mode, user: User | null = null) {
    const value = user ? { ...emptyDraft, username: user.username, realName: user.realName || '', role: user.role, status: next === 'review' ? 'active' : user.status, warehouseIds: user.warehouses.map(w => w.id) } : { ...emptyDraft, warehouseIds: [] };
    setSelected(user); setDraft(value); setInitial(JSON.stringify(value)); setFormError(''); setMode(next);
  }
  function close() { if (busy) return; if (dirty) setConfirm('discard'); else { setMode(null); setSelected(null); } }
  function body() {
    if (mode === 'create') return { username: draft.username, realName: draft.realName, password: draft.password, role: draft.role, status: 'active', warehouseIds: draft.role === 'admin' ? [] : draft.warehouseIds };
    if (mode === 'profile') return { id: selected?.id, realName: draft.realName };
    if (mode === 'password') return { id: selected?.id, newPassword: draft.password };
    const targetIds = draft.role === 'admin' && selected?.role !== 'admin' ? [] : draft.warehouseIds;
    const sameAssignments = [...targetIds].sort().join('\0') === [...(selected?.warehouses.map(w => w.id) || [])].sort().join('\0');
    return { id: selected?.id, role: draft.role, status: draft.status, ...(!sameAssignments ? { warehouseIds: targetIds } : {}) };
  }
  function submit(event: FormEvent) {
    event.preventDefault(); setFormError('');
    if ((mode === 'create' || mode === 'password') && draft.password !== draft.confirm) { setFormError('两次密码不一致'); return; }
    if (['create', 'permissions', 'review'].includes(mode || '') && draft.role === 'warehouse_manager' && draft.status === 'active' && !draft.warehouseIds.some(id => warehouses.some(w => w.id === id && w.status === 'active'))) { setFormError('请为分仓管分配至少一个启用仓库'); return; }
    if (mode === 'password' || mode === 'review' || (mode === 'permissions' && dirty)) setConfirm('save');
    else void save();
  }
  async function save() {
    setConfirm(null); setBusy(true); setFormError('');
    try {
      const data = await accountRequest<{message?:string;sessionsRevoked?:boolean}>('/api/users', { method: mode === 'create' ? 'POST' : 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body()) });
      setToast({ type: 'success', message: data.message || '账号已保存' }); setMode(null); setSelected(null); await load();
      if (selected?.id === actor?.id) window.dispatchEvent(new Event('account-updated'));
    } catch (err) { setFormError(err instanceof Error ? err.message : '保存失败'); } finally { setBusy(false); }
  }
  async function deleteUser() {
    if (!deleteTarget || busy) return;
    setBusy(true);
    try {
      const data = await accountRequest<{message:string}>(`/api/users?id=${encodeURIComponent(deleteTarget.id)}`, { method: 'DELETE' });
      setDeleteTarget(null);
      setToast({ type: 'success', message: data.message || '账号已删除' });
      await load();
    } catch (err) {
      setToast({ type: 'error', message: err instanceof Error ? err.message : '删除账号失败' });
    } finally { setBusy(false); }
  }
  const activeWarehouses = warehouses.filter(w => w.status === 'active');
  return <div className="mx-auto max-w-7xl space-y-5 animate-fade-in">
    <header className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="flex items-center gap-2 text-2xl font-semibold text-ink-deep"><ShieldCheck className="h-6 w-6 text-primary" />账号与权限</h1><p className="mt-2 text-sm text-ink-soft">审核注册、管理账号资料与仓库权限。</p></div><button onClick={() => open('create')} className="btn-primary inline-flex items-center gap-2"><Plus className="h-4 w-4" />创建账号</button></header>
    <section className="glass rounded-2xl p-4"><form onSubmit={e => { e.preventDefault(); setPage(1); setQuery({ ...filters }); }} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(220px,1.5fr)_1fr_1fr_1fr_auto]"><label className="relative"><Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-soft" /><input aria-label="搜索账号或姓名" className="field pl-10" placeholder="搜索账号、姓名" value={filters.search} onChange={e => setFilters({ ...filters, search: e.target.value })} /></label><CustomSelect aria-label="账号状态筛选" value={filters.status} onChange={status => setFilters({ ...filters, status })} options={[{ value: '', label: '全部状态' }, ...Object.entries(statusNames).map(([value,label]) => ({value,label}))]} /><CustomSelect aria-label="账号角色筛选" value={filters.role} onChange={role => setFilters({ ...filters, role })} options={[{value:'',label:'全部角色'}, ...roles]} /><CustomSelect searchable aria-label="账号仓库筛选" value={filters.warehouseId} onChange={warehouseId => setFilters({ ...filters, warehouseId })} options={[{value:'',label:'全部仓库'}, ...warehouses.map(w => ({value:w.id,label:w.name}))]} /><div className="flex gap-2"><button type="submit" className="btn-primary">筛选</button><button type="button" className="btn-ghost" onClick={() => { setFilters(emptyFilters); setQuery(emptyFilters); setPage(1); }}>清空</button></div></form></section>
    {error && <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-danger/15 bg-danger/6 p-3 text-sm text-danger">{error}<button className="btn-ghost" onClick={() => void load()}>重试</button></div>}
    <section className="glass overflow-hidden rounded-2xl"><div className="flex items-center justify-between border-b border-line/50 px-4 py-3"><p className="text-sm text-ink-soft">共 <strong className="font-medium text-ink">{pagination.total}</strong> 个账号</p><button className="btn-ghost inline-flex items-center gap-1.5" disabled={loading} onClick={() => void load()}><RefreshCw className={`h-4 w-4 ${loading?'animate-spin':''}`} />刷新</button></div><div className="overflow-x-auto"><table className="data-table w-full text-left text-sm"><thead><tr>{['账号', '角色', '可管理仓库', '状态', '操作'].map(h => <th key={h}>{h}</th>)}</tr></thead><tbody>{users.map(user => <tr key={user.id}><td><p className="font-medium text-ink-deep">{user.realName || user.username}{user.id === actor?.id && <span className="ml-2 text-xs font-normal text-primary">本人</span>}{user.isSystemAccount && <span className="ml-2 text-xs font-normal text-ink-soft">内置账号</span>}</p><p className="mt-1 text-xs text-ink-soft">{user.username}</p></td><td className="whitespace-nowrap">{user.role === 'admin' ? '管理员' : '分仓管'}</td><td className="min-w-36 max-w-72 text-ink-soft">{user.role === 'admin' ? '全部仓库' : user.warehouses.map(w => w.name).join('、') || '尚未分配'}</td><td className="whitespace-nowrap"><span className={`rounded-lg px-2 py-1 text-xs ${user.status === 'pending' ? 'bg-amber-50 text-amber-700' : user.status === 'active' ? 'bg-primary/8 text-primary' : 'bg-ink-soft/8 text-ink-soft'}`}>{statusNames[user.status] || user.status}</span></td><td><div className="flex flex-wrap gap-1 whitespace-nowrap">{user.status === 'pending' && <button onClick={() => open('review', user)} className="btn-ghost inline-flex items-center gap-1 text-primary"><Check className="h-3.5 w-3.5" />审核</button>}<button onClick={() => open('profile', user)} className="btn-ghost inline-flex items-center gap-1"><Pencil className="h-3.5 w-3.5" />资料</button><button onClick={() => open('permissions', user)} className="btn-ghost inline-flex items-center gap-1"><ShieldCheck className="h-3.5 w-3.5" />权限</button><button onClick={() => open('password', user)} className="btn-ghost inline-flex items-center gap-1"><KeyRound className="h-3.5 w-3.5" />重置密码</button>{actor?.isSystemAccount && user.id !== actor.id && !user.isSystemAccount && <button type="button" aria-label={`删除账号 ${user.username}`} onClick={() => setDeleteTarget(user)} className="btn-ghost inline-flex items-center gap-1 text-danger transition hover:bg-danger/10 active:scale-95"><Trash2 className="h-3.5 w-3.5" />删除</button>}</div></td></tr>)}</tbody></table>{loading && <div role="status" className="flex items-center justify-center gap-2 p-8 text-sm text-ink-soft"><LoaderCircle className="h-4 w-4 animate-spin" />加载账号中…</div>}{!loading && !users.length && <div className="p-12 text-center text-sm text-ink-soft"><Users className="mx-auto mb-3 h-7 w-7 opacity-50" />没有符合条件的账号</div>}</div><footer className="flex items-center justify-between border-t border-line/50 p-4 text-xs text-ink-soft"><span>第 {page} / {Math.max(1,pagination.totalPages)} 页</span><div className="flex gap-2"><button className="btn-ghost inline-flex items-center gap-1" disabled={page<=1||loading} onClick={() => setPage(page-1)}><ChevronLeft className="h-4 w-4" />上一页</button><button className="btn-ghost inline-flex items-center gap-1" disabled={page>=pagination.totalPages||loading} onClick={() => setPage(page+1)}>下一页<ChevronRight className="h-4 w-4" /></button></div></footer></section>
    {mode && <BusinessDialog title={titles[mode]} description={selected ? `账号：${selected.username}` : '创建后账号可直接登录，请核对角色与仓库。'} onClose={close} footer={<><button className="btn-ghost" disabled={busy} onClick={close}>取消</button><button form="user-editor" type="submit" className="btn-primary" disabled={busy}>{busy?'保存中…':mode==='review'?'确认审核':'保存'}</button></>}><form id="user-editor" onSubmit={submit} className="space-y-4">
      {mode === 'create' && <label className="block text-sm">用户名<input className="field mt-1.5" autoComplete="off" required minLength={3} maxLength={64} value={draft.username} onChange={e => setDraft({ ...draft, username:e.target.value })} /></label>}
      {(mode === 'create' || mode === 'profile') && <label className="block text-sm">姓名<input className="field mt-1.5" autoComplete="off" maxLength={80} value={draft.realName} onChange={e => setDraft({ ...draft, realName:e.target.value })} /></label>}
      {['create','permissions','review'].includes(mode) && <><label className="block text-sm">角色<div className="mt-1.5"><CustomSelect value={draft.role} onChange={role => setDraft({ ...draft, role })} options={roles} aria-label="账号角色" /></div></label>{mode !== 'create' && <label className="block text-sm">{mode === 'review' ? '审核结果' : '账号状态'}<div className="mt-1.5"><CustomSelect value={draft.status} onChange={status => setDraft({ ...draft, status })} options={(mode==='review'?['active','rejected']:['active','disabled','pending','rejected']).map(value => ({value,label:statusNames[value]}))} aria-label="账号状态" /></div></label>}{draft.role === 'warehouse_manager' && <fieldset><legend className="text-sm">可管理仓库 {draft.status === 'active' && <span className="text-danger">*</span>}</legend><div className="mt-2 max-h-48 space-y-2 overflow-y-auto rounded-xl border border-line bg-white/40 p-3">{activeWarehouses.map(w => <label key={w.id} className="flex cursor-pointer items-center gap-2 rounded-lg p-2 text-sm transition hover:bg-primary/5"><input type="checkbox" checked={draft.warehouseIds.includes(w.id)} onChange={e => setDraft({ ...draft, warehouseIds:e.target.checked?[...draft.warehouseIds,w.id]:draft.warehouseIds.filter(id => id!==w.id) })} className="h-4 w-4 accent-primary" />{w.name}<span className="text-xs text-ink-soft">{w.code}</span></label>)}{!activeWarehouses.length && <p className="text-sm text-ink-soft">暂无启用仓库，请先到仓库管理创建。</p>}</div><p className="mt-2 text-xs leading-6 text-ink-soft">分仓管仅可查看授权仓库存、分析及移动记录，并申请调拨。</p></fieldset>}</>}
      {(mode === 'create' || mode === 'password') && <><PasswordField label={mode === 'create'?'初始密码':'新密码'} autoComplete="new-password" required minLength={8} maxLength={200} value={draft.password} onChange={e => setDraft({ ...draft,password:e.target.value })} /><PasswordField label="确认密码" autoComplete="new-password" required minLength={8} maxLength={200} value={draft.confirm} onChange={e => setDraft({ ...draft,confirm:e.target.value })} /></>}
      {mode === 'profile' ? <p className="rounded-xl bg-primary/5 p-3 text-xs leading-6 text-ink-soft">仅修改姓名不会退出该账号已有会话。</p> : mode !== 'create' && <p className="rounded-xl bg-amber-50/70 p-3 text-xs leading-6 text-amber-800">角色、仓库、账号状态或密码发生变化时，该账号已有会话将退出。系统保留至少一位有效管理员。</p>}
      {formError && <p role="alert" className="rounded-xl bg-danger/6 p-3 text-sm text-danger">{formError}</p>}
    </form></BusinessDialog>}
    <ConfirmDialog isOpen={!!confirm} title={confirm==='discard'?'放弃未保存的修改？':mode==='password'?'确认重置密码？':'确认变更账号权限？'} message={confirm==='discard'?'关闭后，本次未保存内容将丢失。':mode==='password'?'新密码将立即生效，该账号已有登录会话会退出。':'审核或权限变更生效后，账号已有会话可能退出，请确认角色、状态和仓库分配。'} cancelText={confirm==='discard'?'继续编辑':'返回核对'} confirmText={confirm==='discard'?'关闭并放弃':'确认提交'} danger={confirm==='discard'||mode==='password'} onCancel={() => setConfirm(null)} onConfirm={() => { if(confirm==='discard'){setMode(null);setSelected(null);setConfirm(null);}else void save(); }} />
    <ConfirmDialog isOpen={!!deleteTarget} title="删除账号？" message={`账号“${deleteTarget?.realName || deleteTarget?.username || ''}”（${deleteTarget?.username || ''}）删除后将立即退出所有设备，不能再登录。历史业务记录会保留。`} cancelText="取消" confirmText={busy ? '删除中…' : '确认删除'} danger onCancel={() => { if (!busy) setDeleteTarget(null); }} onConfirm={() => void deleteUser()} />
    {toast && active && <Toast isOpen type={toast.type} message={toast.message} onClose={() => setToast(null)} />}
  </div>;
}
