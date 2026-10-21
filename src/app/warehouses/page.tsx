'use client';

import Link from 'next/link';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { ArrowRightLeft, Pencil, Plus, RefreshCw, Warehouse } from 'lucide-react';
import BusinessDialog from '@/components/BusinessDialog';
import ConfirmDialog from '@/components/ConfirmDialog';
import Toast from '@/components/Toast';

type WarehouseRow = { id: string; code: string; name: string; address: string | null; remark: string | null; status: string; isDefault: number };
export default function WarehousesPage() {
  const [rows, setRows] = useState<WarehouseRow[]>([]);
  const [admin, setAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<WarehouseRow | 'new' | null>(null);
  const [name, setName] = useState(''); const [code, setCode] = useState(''); const [address, setAddress] = useState(''); const [remark, setRemark] = useState('');
  const [saving, setSaving] = useState(false);
  const [toggle, setToggle] = useState<WarehouseRow | null>(null);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/warehouses', { cache: 'no-store' }); const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error?.message || '加载仓库失败'); setRows(result.data || []);
    } catch (error) { setToast({ message: error instanceof Error ? error.message : '加载失败', type: 'error' }); } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); void fetch('/api/auth/me').then(r => r.json()).then(r => setAdmin(r.data?.user?.role === 'admin')); }, [load]);
  function edit(row: WarehouseRow | 'new') { setEditing(row); setName(row === 'new' ? '' : row.name); setCode(row === 'new' ? '' : row.code); setAddress(row === 'new' ? '' : row.address || ''); setRemark(row === 'new' ? '' : row.remark || ''); }
  async function save(event: FormEvent) {
    event.preventDefault(); if (!editing || saving) return; setSaving(true);
    try {
      const response = await fetch('/api/warehouses', { method: editing === 'new' ? 'POST' : 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: editing === 'new' ? undefined : editing.id, name, code, address, remark }) }); const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error?.message || '保存仓库失败'); setEditing(null); setToast({ message: '仓库已保存', type: 'success' }); await load();
    } catch (error) { setToast({ message: error instanceof Error ? error.message : '保存失败', type: 'error' }); } finally { setSaving(false); }
  }
  async function toggleStatus() {
    if (!toggle) return; setSaving(true);
    try { const response = await fetch('/api/warehouses', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: toggle.id, status: toggle.status === 'active' ? 'disabled' : 'active' }) }); const result = await response.json(); if (!response.ok || !result.success) throw new Error(result.error?.message || '操作失败'); setToggle(null); await load(); }
    catch (error) { setToast({ message: error instanceof Error ? error.message : '操作失败', type: 'error' }); } finally { setSaving(false); }
  }
  return <div className="mx-auto max-w-[1400px] space-y-5 pb-8">
    <header className="flex flex-wrap items-end justify-between gap-3"><div><h1 className="text-xl font-bold text-ink-deep">仓库管理</h1><p className="mt-2 text-sm text-ink-soft">{admin ? '维护仓库名称、地址与使用状态，账号授权在用户管理中配置' : '查看你获得授权的仓库'}</p></div><div className="flex flex-wrap gap-2"><Link href="/inventory?view=transfers" className="btn-ghost inline-flex items-center gap-2"><ArrowRightLeft className="h-4 w-4" />库存调拨</Link>{admin && <button type="button" className="btn-primary inline-flex items-center gap-2" onClick={() => edit('new')}><Plus className="h-4 w-4" />新建仓库</button>}</div></header>
    <section className="glass overflow-hidden"><div className="flex items-center justify-between border-b border-line/70 p-4"><p className="text-sm text-ink-soft">共 {rows.length} 个仓库 · 启用 {rows.filter(r => r.status === 'active').length} 个</p><button type="button" className="btn-ghost p-2" aria-label="刷新仓库" onClick={() => void load()} disabled={loading}><RefreshCw className={'h-4 w-4 ' + (loading ? 'animate-spin' : '')} /></button></div><div className="grid gap-4 p-4 md:grid-cols-2 xl:grid-cols-3">{rows.map(row => <article key={row.id} className="rounded-xl border border-line/80 bg-white/50 p-5 transition hover:shadow-md"><div className="flex items-center gap-3"><span className="rounded-xl bg-primary/10 p-2.5 text-primary"><Warehouse className="h-5 w-5" /></span><div className="min-w-0 flex-1"><h2 className="truncate font-semibold text-ink-deep">{row.name}</h2><p className="mt-1 font-mono text-xs text-ink-soft">{row.code}</p></div><span className={'status-pill ' + (row.status === 'active' ? 'ok' : '')}>{row.status === 'active' ? '启用' : '停用'}</span></div><p className="mt-4 text-xs leading-6 text-ink-soft">{row.address || '未填写地址'}<br />{row.remark || '未填写备注'}</p><div className="mt-4 flex min-h-8 items-center justify-between border-t border-line/70 pt-3">{row.isDefault ? <span className="text-xs text-primary">默认总仓</span> : <span />}{admin && <div className="flex gap-2"><button type="button" className="btn-ghost p-2 text-xs" onClick={() => edit(row)}><Pencil className="mr-1 inline h-3.5 w-3.5" />编辑</button>{!row.isDefault && <button type="button" className="btn-ghost p-2 text-xs" onClick={() => setToggle(row)}>{row.status === 'active' ? '停用' : '启用'}</button>}</div>}</div></article>)}{!loading && !rows.length && <p className="p-8 text-center text-sm text-ink-soft md:col-span-2">暂无授权仓库，请联系管理员分配。</p>}</div></section>
    {editing && <BusinessDialog title={editing === 'new' ? '新建仓库' : '编辑仓库'} onClose={() => { if (!saving) setEditing(null); }} footer={<><button type="button" className="btn-ghost" onClick={() => setEditing(null)} disabled={saving}>取消</button><button type="submit" form="warehouse-form" className="btn-primary" disabled={saving}>{saving ? '保存中...' : '保存仓库'}</button></>}><form id="warehouse-form" onSubmit={save} className="grid gap-4 sm:grid-cols-2"><label className="text-xs text-ink-soft">仓库名称 *<input className="field mt-1.5" value={name} onChange={e => setName(e.target.value)} required maxLength={80} disabled={editing !== 'new' && !!editing.isDefault} /></label><label className="text-xs text-ink-soft">仓库编码<input className="field mt-1.5" value={code} onChange={e => setCode(e.target.value)} disabled={editing !== 'new'} placeholder="留空自动生成" /></label><label className="text-xs text-ink-soft sm:col-span-2">地址<input className="field mt-1.5" value={address} onChange={e => setAddress(e.target.value)} /></label><label className="text-xs text-ink-soft sm:col-span-2">备注<textarea className="field mt-1.5" rows={3} value={remark} onChange={e => setRemark(e.target.value)} /></label></form></BusinessDialog>}
    <ConfirmDialog isOpen={!!toggle} title={toggle?.status === 'active' ? '停用仓库' : '启用仓库'} message={toggle?.status === 'active' ? `确认停用“${toggle.name}”？仓库历史记录会保留，有库存时不能停用。` : `确认重新启用“${toggle?.name}”？`} confirmText="确认" cancelText="取消" danger={toggle?.status === 'active'} onConfirm={() => { if (!saving) void toggleStatus(); }} onCancel={() => setToggle(null)} />
    <Toast isOpen={!!toast} type={toast?.type || 'success'} message={toast?.message || ''} onClose={() => setToast(null)} />
  </div>;
}
