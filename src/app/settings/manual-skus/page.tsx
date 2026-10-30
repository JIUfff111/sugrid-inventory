'use client';

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Check, CirclePlus, Edit3, PackageOpen, RefreshCw, Search, Trash2, X } from 'lucide-react';
import BusinessDialog from '@/components/BusinessDialog';
import ConfirmDialog from '@/components/ConfirmDialog';
import CustomSelect from '@/components/CustomSelect';
import Toast, { type ToastType } from '@/components/Toast';
import { useWorkspace, useWorkspaceDirty } from '@/components/WorkspaceContext';

type ManualSKU = { id: string; productType: string; brand: string; model: string; year: number | null; isActive: number; createdAt: string; updatedAt: string };
type Draft = { productType: string; brand: string; model: string; year: string };
type Payload = { success?: boolean; data?: { items?: ManualSKU[]; item?: ManualSKU }; error?: { message?: string } };
const emptyDraft: Draft = { productType: '笔记本电脑', brand: '', model: '', year: '' };
const typeOptions = [{ value: '笔记本电脑', label: '笔记本电脑' }, { value: '平板电脑', label: '平板电脑' }];

export default function ManualSKUsPage() {
  const { active, user } = useWorkspace();
  const [items, setItems] = useState<ManualSKU[]>([]);
  const [search, setSearch] = useState('');
  const [productType, setProductType] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ManualSKU | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [initialDraft, setInitialDraft] = useState(JSON.stringify(emptyDraft));
  const [discardConfirm, setDiscardConfirm] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ManualSKU | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: ToastType } | null>(null);
  const dirty = dialogOpen && JSON.stringify(draft) !== initialDraft;
  useWorkspaceDirty(dirty);

  const load = useCallback(async () => {
    if (!active) return;
    setLoading(true); setError('');
    try {
      const params = new URLSearchParams({ includeInactive: includeInactive ? '1' : '0' });
      if (search.trim()) params.set('search', search.trim());
      if (productType) params.set('productType', productType);
      const response = await fetch(`/api/manual-skus?${params}`, { cache: 'no-store' });
      const payload = await response.json() as Payload;
      if (!response.ok || !payload.success) throw new Error(payload.error?.message || '手工 SKU 加载失败');
      setItems(payload.data?.items || []);
    } catch (loadError) { setError(loadError instanceof Error ? loadError.message : '手工 SKU 加载失败'); }
    finally { setLoading(false); }
  }, [active, includeInactive, productType, search]);

  useEffect(() => { void load(); }, [load]);

  const brandCount = useMemo(() => new Set(items.map(item => item.brand)).size, [items]);
  const activeCount = items.filter(item => item.isActive).length;

  function openNew() { const value = { ...emptyDraft }; setEditing(null); setDraft(value); setInitialDraft(JSON.stringify(value)); setDialogOpen(true); }
  function openEdit(item: ManualSKU) {
    const value = { productType: item.productType, brand: item.brand, model: item.model, year: item.year ? String(item.year) : '' };
    setEditing(item); setDraft(value); setInitialDraft(JSON.stringify(value)); setDialogOpen(true);
  }
  function closeDialog() {
    if (busy) return;
    if (dirty) { setDiscardConfirm(true); return; }
    setDialogOpen(false); setEditing(null);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft.brand.trim() || !draft.model.trim()) { setToast({ type: 'error', message: '请填写品牌和型号' }); return; }
    setBusy(true);
    try {
      const response = await fetch('/api/manual-skus', {
        method: editing ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...(editing ? { id: editing.id } : {}), ...draft, year: draft.year || null }),
      });
      const payload = await response.json() as Payload;
      if (!response.ok || !payload.success) throw new Error(payload.error?.message || '手工 SKU 保存失败');
      setDialogOpen(false); setEditing(null); setInitialDraft(JSON.stringify(emptyDraft));
      setToast({ type: 'success', message: editing ? '手工 SKU 已更新' : '手工 SKU 已添加' });
      await load();
    } catch (saveError) { setToast({ type: 'error', message: saveError instanceof Error ? saveError.message : '手工 SKU 保存失败' }); }
    finally { setBusy(false); }
  }

  async function setActive(item: ManualSKU, next: boolean) {
    setBusy(true);
    try {
      const response = await fetch('/api/manual-skus', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: item.id, isActive: next }) });
      const payload = await response.json() as Payload;
      if (!response.ok || !payload.success) throw new Error(payload.error?.message || '状态更新失败');
      setToast({ type: 'success', message: next ? '手工 SKU 已启用' : '手工 SKU 已停用' }); await load();
    } catch (toggleError) { setToast({ type: 'error', message: toggleError instanceof Error ? toggleError.message : '状态更新失败' }); }
    finally { setBusy(false); }
  }

  async function remove() {
    if (!deleteTarget) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/manual-skus?id=${encodeURIComponent(deleteTarget.id)}`, { method: 'DELETE' });
      const payload = await response.json() as Payload;
      if (!response.ok || !payload.success) throw new Error(payload.error?.message || '移除失败');
      setToast({ type: 'success', message: '手工 SKU 已移出可用库' }); setDeleteTarget(null); await load();
    } catch (removeError) { setToast({ type: 'error', message: removeError instanceof Error ? removeError.message : '移除失败' }); }
    finally { setBusy(false); }
  }

  if (user && user.role !== 'admin') return <div className="mx-auto max-w-4xl py-16 text-center text-sm text-ink-soft">只有管理员可以管理手工 SKU 库。</div>;

  return <div className="mx-auto max-w-7xl space-y-5 animate-fade-in">
    <header className="flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-3"><span className="rounded-2xl bg-primary/10 p-3 text-primary"><PackageOpen className="h-5 w-5" /></span><div><h1 className="text-2xl font-semibold text-ink-deep">手工 SKU 库</h1><p className="mt-1 text-sm text-ink-soft">独立于内置 SKU 目录，仅供采购手工录入使用。</p></div></div><button type="button" className="btn-primary inline-flex items-center gap-2" onClick={openNew}><CirclePlus className="h-4 w-4" />新增手工 SKU</button></header>
    <section className="grid gap-3 sm:grid-cols-3"><div className="glass rounded-2xl p-4"><p className="text-xs text-ink-soft">当前显示</p><p className="mt-1 text-xl font-semibold text-ink-deep">{items.length}<span className="ml-1 text-sm font-normal text-ink-soft">条</span></p></div><div className="glass rounded-2xl p-4"><p className="text-xs text-ink-soft">启用中</p><p className="mt-1 text-xl font-semibold text-primary">{activeCount}<span className="ml-1 text-sm font-normal text-ink-soft">条</span></p></div><div className="glass rounded-2xl p-4"><p className="text-xs text-ink-soft">品牌数</p><p className="mt-1 text-xl font-semibold text-ink-deep">{brandCount}<span className="ml-1 text-sm font-normal text-ink-soft">个</span></p></div></section>
    <section className="glass rounded-2xl p-4"><div className="grid gap-3 md:grid-cols-[minmax(220px,1.5fr)_180px_auto_auto]"><label className="relative"><Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-soft" /><input className="field pl-10" value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索品牌、型号或年份" aria-label="搜索手工 SKU" /></label><CustomSelect aria-label="产品类型筛选" value={productType} onChange={setProductType} options={[{ value: '', label: '全部产品类型' }, ...typeOptions]} /><label className="flex items-center gap-2 rounded-xl border border-line/70 bg-white/45 px-3 text-xs text-ink-soft"><input type="checkbox" checked={includeInactive} onChange={event => setIncludeInactive(event.target.checked)} />显示停用</label><button type="button" className="btn-ghost inline-flex items-center justify-center gap-1.5" disabled={loading} onClick={() => void load()}><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />刷新</button></div></section>
    {error && <div role="alert" className="flex items-center justify-between rounded-xl border border-danger/20 bg-danger/5 p-3 text-sm text-danger">{error}<button type="button" className="btn-ghost" onClick={() => void load()}>重试</button></div>}
    <section className="glass overflow-hidden rounded-2xl"><div className="flex flex-wrap items-center justify-between gap-2 border-b border-line/60 px-4 py-3"><p className="text-sm text-ink-soft">手工目录与内置 SKU 库彼此独立</p><p className="text-xs text-ink-soft">品牌、型号和年份作为受控选项</p></div><div className="overflow-x-auto">{loading ? <div className="flex items-center justify-center gap-2 p-12 text-sm text-ink-soft"><RefreshCw className="h-4 w-4 animate-spin" />加载中</div> : items.length === 0 ? <div className="p-12 text-center text-sm text-ink-soft"><PackageOpen className="mx-auto mb-3 h-8 w-8 text-ink-soft/60" />暂无手工 SKU</div> : <table className="data-table w-full text-left text-sm"><thead><tr>{['产品类型', '品牌', '型号', '年份', '状态', '操作'].map(label => <th key={label}>{label}</th>)}</tr></thead><tbody>{items.map(item => <tr key={item.id}><td>{item.productType}</td><td className="font-medium text-ink-deep">{item.brand}</td><td className="font-medium text-ink-deep">{item.model}</td><td>{item.year || '未指定'}</td><td><span className={`rounded-lg px-2 py-1 text-xs ${item.isActive ? 'bg-primary/8 text-primary' : 'bg-ink-soft/10 text-ink-soft'}`}>{item.isActive ? '启用' : '停用'}</span></td><td><div className="flex flex-wrap gap-1"><button type="button" className="btn-ghost inline-flex items-center gap-1" onClick={() => openEdit(item)}><Edit3 className="h-3.5 w-3.5" />编辑</button><button type="button" className="btn-ghost inline-flex items-center gap-1" disabled={busy} onClick={() => void setActive(item, !item.isActive)}>{item.isActive ? <X className="h-3.5 w-3.5" /> : <Check className="h-3.5 w-3.5" />}{item.isActive ? '停用' : '启用'}</button><button type="button" className="btn-ghost inline-flex items-center gap-1 text-danger" disabled={busy} onClick={() => setDeleteTarget(item)}><Trash2 className="h-3.5 w-3.5" />移除</button></div></td></tr>)}</tbody></table>}</div></section>
    {dialogOpen && <BusinessDialog title={editing ? '编辑手工 SKU' : '新增手工 SKU'} description="此目录独立于内置 SKU，采购手工录入时只会读取启用项目。" onClose={closeDialog} footer={<><button type="button" className="btn-ghost" onClick={closeDialog} disabled={busy}>取消</button><button type="submit" form="manual-sku-form" className="btn-primary" disabled={busy}>{busy ? '保存中…' : '保存'}</button></>}><form id="manual-sku-form" onSubmit={save} className="grid gap-4 sm:grid-cols-2"><label className="text-sm text-ink-deep">产品类型<span className="ml-1 text-danger">*</span><span className="mt-2 block"><CustomSelect aria-label="手工 SKU 产品类型" value={draft.productType} onChange={value => setDraft({ ...draft, productType: value })} options={typeOptions} /></span></label><label className="text-sm text-ink-deep">品牌<span className="ml-1 text-danger">*</span><input className="field mt-2" value={draft.brand} onChange={event => setDraft({ ...draft, brand: event.target.value })} placeholder="如：ThinkPad" required /></label><label className="text-sm text-ink-deep">型号<span className="ml-1 text-danger">*</span><input className="field mt-2" value={draft.model} onChange={event => setDraft({ ...draft, model: event.target.value })} placeholder="如：X13" required /></label><label className="text-sm text-ink-deep">型号年份<input className="field mt-2" type="number" min="1900" max="2100" value={draft.year} onChange={event => setDraft({ ...draft, year: event.target.value })} placeholder="可选" /></label></form></BusinessDialog>}
    <ConfirmDialog isOpen={discardConfirm} title="放弃手工 SKU 编辑？" message="当前内容尚未保存。关闭后将丢弃本次修改。" cancelText="继续编辑" confirmText="关闭并放弃" danger onCancel={() => setDiscardConfirm(false)} onConfirm={() => { setDiscardConfirm(false); setDialogOpen(false); setEditing(null); }} />
    <ConfirmDialog isOpen={!!deleteTarget} title="移除手工 SKU？" message={`“${deleteTarget?.brand || ''} ${deleteTarget?.model || ''}”将从手工录入选择器中移除，历史采购记录会保留。`} confirmText={busy ? '处理中…' : '确认移除'} danger onCancel={() => { if (!busy) setDeleteTarget(null); }} onConfirm={() => void remove()} />
    {toast && active && <Toast isOpen type={toast.type} message={toast.message} onClose={() => setToast(null)} />}
  </div>;
}
