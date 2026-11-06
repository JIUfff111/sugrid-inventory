'use client';

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Check, CirclePlus, Edit3, PackageOpen, Plus, RefreshCw, Search, Trash2, X } from 'lucide-react';
import BusinessDialog from '@/components/BusinessDialog';
import ConfirmDialog from '@/components/ConfirmDialog';
import CustomSelect from '@/components/CustomSelect';
import Toast, { type ToastType } from '@/components/Toast';
import { useWorkspace, useWorkspaceDirty } from '@/components/WorkspaceContext';
import { getSKUProductType, SKU_PRODUCT_TYPES } from '@/lib/sku-display';
import { canonicalSKUBrand } from '@/lib/sku-brand';

type SKUOptionField = 'cpuOptions' | 'ramOptions' | 'gpuOptions' | 'storageOptions' | 'screenOptions';
type ManualSKU = { id: string; productType: string; brand: string; model: string; year: number | null; cpuOptions: string[]; ramOptions: string[]; gpuOptions: string[]; storageOptions: string[]; screenOptions: string[]; isActive: number; createdAt: string; updatedAt: string };
type CatalogSKU = Pick<ManualSKU, 'productType' | 'brand' | 'model'>;
type Draft = { productType: string; brand: string; model: string; year: string } & Record<SKUOptionField, string[]>;
type IdentityMode = 'catalog' | 'custom';
type Payload = { success?: boolean; data?: { items?: ManualSKU[]; item?: ManualSKU }; error?: { message?: string } };
type CatalogPayload = { success?: boolean; data?: { items?: CatalogSKU[]; totalPages?: number }; error?: { message?: string } };
const emptyDraft: Draft = { productType: '笔记本电脑', brand: '', model: '', year: '', cpuOptions: [], ramOptions: [], gpuOptions: [], storageOptions: [], screenOptions: [] };
const typeOptions = SKU_PRODUCT_TYPES.map(value => ({ value, label: value }));
const snapshotDraft = (draft: Draft, mode: IdentityMode, brand: string, model: string, year: string) =>
  JSON.stringify({ draft, mode, brand, model, year });

function OptionListEditor({ label, values, onChange, placeholder, suggestions = [] }: { label: string; values: string[]; onChange: (values: string[]) => void; placeholder: string; suggestions?: string[] }) {
  const [input, setInput] = useState('');
  const add = () => {
    const value = input.trim();
    if (!value || values.some(item => item.toLocaleLowerCase() === value.toLocaleLowerCase())) return;
    onChange([...values, value]);
    setInput('');
  };
  const listId = `manual-sku-${label}-suggestions`;
  return <div>
    <label className="mb-2 block text-sm font-medium text-ink-deep">{label}</label>
    <div className="mb-2 flex min-h-9 flex-wrap gap-1.5">
      {values.map(value => <span key={value} className="inline-flex items-center gap-1 rounded-md border border-line bg-white px-2 py-1 text-xs text-ink-deep">
        {value}<button type="button" aria-label={`移除${label}选项 ${value}`} title="移除选项" className="rounded p-0.5 text-ink-soft transition hover:bg-paper hover:text-danger" onClick={() => onChange(values.filter(item => item !== value))}><X className="h-3 w-3" /></button>
      </span>)}
      {values.length === 0 && <span className="py-1 text-xs text-ink-soft">暂无固定选项</span>}
    </div>
    <div className="flex gap-2">
      <input className="field min-w-0 flex-1" list={suggestions.length ? listId : undefined} value={input} onChange={event => setInput(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); add(); } }} placeholder={placeholder} />
      <button type="button" className="btn-ghost inline-flex shrink-0 items-center gap-1" disabled={!input.trim()} onClick={add}><Plus className="h-4 w-4" />添加</button>
      {suggestions.length > 0 && <datalist id={listId}>{suggestions.map(option => <option key={option} value={option} />)}</datalist>}
    </div>
  </div>;
}

export default function ManualSKUsPage() {
  const { active, user } = useWorkspace();
  const [items, setItems] = useState<ManualSKU[]>([]);
  const [catalogSkus, setCatalogSkus] = useState<CatalogSKU[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState('');
  const [search, setSearch] = useState('');
  const [productType, setProductType] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ManualSKU | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [identityMode, setIdentityMode] = useState<IdentityMode>('catalog');
  const [customBrand, setCustomBrand] = useState('');
  const [customModel, setCustomModel] = useState('');
  const [customYear, setCustomYear] = useState('');
  const [initialDraft, setInitialDraft] = useState(snapshotDraft(emptyDraft, 'catalog', '', '', ''));
  const [discardConfirm, setDiscardConfirm] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ManualSKU | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: ToastType } | null>(null);
  const dirty = dialogOpen && snapshotDraft(draft, identityMode, customBrand, customModel, customYear) !== initialDraft;
  useWorkspaceDirty(dirty);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const loadCatalog = async () => {
      setCatalogLoading(true);
      setCatalogError('');
      try {
        const choices: CatalogSKU[] = [];
        let page = 1;
        let totalPages = 1;
        do {
          const response = await fetch(`/api/skus?page=${page}&pageSize=100`, { signal: controller.signal, cache: 'no-store' });
          const payload = await response.json() as CatalogPayload;
          if (!response.ok || !payload.success || !Array.isArray(payload.data?.items)) {
            throw new Error(payload.error?.message || '型号目录加载失败');
          }
          if (!Number.isInteger(payload.data.totalPages) || (payload.data.totalPages ?? -1) < 0) {
            throw new Error('型号目录分页信息无效');
          }
          choices.push(...payload.data.items);
          totalPages = payload.data.totalPages ?? 0;
          page += 1;
        } while (page <= totalPages);
        if (!controller.signal.aborted) setCatalogSkus(choices);
      } catch (loadError) {
        if (!controller.signal.aborted) setCatalogError(loadError instanceof Error ? loadError.message : '型号目录加载失败');
      } finally {
        if (!controller.signal.aborted) setCatalogLoading(false);
      }
    };
    void loadCatalog();
    return () => controller.abort();
  }, [active]);

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
  const catalogForType = useMemo(() => [
    ...catalogSkus,
    ...items.map(({ productType, brand, model }) => ({ productType, brand, model })),
  ].filter(item => getSKUProductType(item.productType) === draft.productType), [catalogSkus, items, draft.productType]);
  const brandOptions = useMemo(() => Array.from(new Set(catalogForType.map(item => canonicalSKUBrand(item.brand))))
    .sort((left, right) => left.localeCompare(right, 'zh-CN'))
    .map(value => ({ value, label: value })), [catalogForType]);
  const modelOptions = useMemo(() => Array.from(new Set(catalogForType
    .filter(item => canonicalSKUBrand(item.brand) === draft.brand)
    .map(item => item.model)))
    .sort((left, right) => left.localeCompare(right, 'zh-CN'))
    .map(value => ({ value, label: value })), [catalogForType, draft.brand]);

  const currentBrand = identityMode === 'custom' ? customBrand : draft.brand;
  const currentModel = identityMode === 'custom' ? customModel : draft.model;
  const currentYear = identityMode === 'custom' ? customYear : draft.year;

  function openNew() {
    const value = { ...emptyDraft };
    setEditing(null); setDraft(value); setIdentityMode('catalog');
    setCustomBrand(''); setCustomModel(''); setCustomYear('');
    setInitialDraft(snapshotDraft(value, 'catalog', '', '', ''));
    setDialogOpen(true);
  }
  function openEdit(item: ManualSKU) {
    const value = { productType: item.productType, brand: item.brand, model: item.model, year: item.year ? String(item.year) : '', cpuOptions: item.cpuOptions || [], ramOptions: item.ramOptions || [], gpuOptions: item.gpuOptions || [], storageOptions: item.storageOptions || [], screenOptions: item.screenOptions || [] };
    const mode = catalogSkus.some(sku => getSKUProductType(sku.productType) === item.productType &&
      canonicalSKUBrand(sku.brand) === canonicalSKUBrand(item.brand) && sku.model === item.model) ? 'catalog' : 'custom';
    setEditing(item); setDraft(value); setIdentityMode(mode);
    setCustomBrand(item.brand); setCustomModel(item.model); setCustomYear(value.year);
    setInitialDraft(snapshotDraft(value, mode, item.brand, item.model, value.year));
    setDialogOpen(true);
  }
  function closeDialog() {
    if (busy) return;
    if (dirty) { setDiscardConfirm(true); return; }
    setDialogOpen(false); setEditing(null);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!currentBrand.trim() || !currentModel.trim()) { setToast({ type: 'error', message: '请填写品牌和型号' }); return; }
    setBusy(true);
    try {
      const response = await fetch('/api/manual-skus', {
        method: editing ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...(editing ? { id: editing.id } : {}), ...draft, brand: currentBrand.trim(), model: currentModel.trim(), year: currentYear || null }),
      });
      const payload = await response.json() as Payload;
      if (!response.ok || !payload.success) throw new Error(payload.error?.message || '手工 SKU 保存失败');
      setDialogOpen(false); setEditing(null); setInitialDraft(snapshotDraft(emptyDraft, 'catalog', '', '', ''));
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
    <section className="glass overflow-hidden rounded-2xl"><div className="flex flex-wrap items-center justify-between gap-2 border-b border-line/60 px-4 py-3"><p className="text-sm text-ink-soft">手工目录与内置 SKU 库彼此独立</p><p className="text-xs text-ink-soft">采购录入使用统一的型号与配置选择流程</p></div><div className="overflow-x-auto">{loading ? <div className="flex items-center justify-center gap-2 p-12 text-sm text-ink-soft"><RefreshCw className="h-4 w-4 animate-spin" />加载中</div> : items.length === 0 ? <div className="p-12 text-center text-sm text-ink-soft"><PackageOpen className="mx-auto mb-3 h-8 w-8 text-ink-soft/60" />暂无手工 SKU</div> : <table className="data-table w-full text-left text-sm"><thead><tr>{['产品类型', '品牌', '型号与选项', '年份', '状态', '操作'].map(label => <th key={label}>{label}</th>)}</tr></thead><tbody>{items.map(item => <tr key={item.id}><td>{item.productType}</td><td className="font-medium text-ink-deep">{item.brand}</td><td><span className="font-medium text-ink-deep">{item.model}</span><span className="mt-1 block text-[11px] text-ink-soft">CPU {item.cpuOptions?.length || 0} · 内存 {item.ramOptions?.length || 0} · 显卡 {item.gpuOptions?.length || 0} · 硬盘 {item.storageOptions?.length || 0} · 屏幕 {item.screenOptions?.length || 0}</span></td><td>{item.year || '未指定'}</td><td><span className={`rounded-lg px-2 py-1 text-xs ${item.isActive ? 'bg-primary/8 text-primary' : 'bg-ink-soft/10 text-ink-soft'}`}>{item.isActive ? '启用' : '停用'}</span></td><td><div className="flex flex-wrap gap-1"><button type="button" className="btn-ghost inline-flex items-center gap-1" onClick={() => openEdit(item)}><Edit3 className="h-3.5 w-3.5" />编辑</button><button type="button" className="btn-ghost inline-flex items-center gap-1" disabled={busy} onClick={() => void setActive(item, !item.isActive)}>{item.isActive ? <X className="h-3.5 w-3.5" /> : <Check className="h-3.5 w-3.5" />}{item.isActive ? '停用' : '启用'}</button><button type="button" className="btn-ghost inline-flex items-center gap-1 text-danger" disabled={busy} onClick={() => setDeleteTarget(item)}><Trash2 className="h-3.5 w-3.5" />移除</button></div></td></tr>)}</tbody></table>}</div></section>
    {dialogOpen && (
      <BusinessDialog
        title={editing ? '编辑手工 SKU' : '新增手工 SKU'}
        description="可沿用目录中的品牌型号，也可自行填写；配置选项保存在独立手工 SKU 库。"
        onClose={closeDialog}
        footer={<>
          <button type="button" className="btn-ghost" onClick={closeDialog} disabled={busy}>取消</button>
          <button type="submit" form="manual-sku-form" className="btn-primary" disabled={busy || (identityMode === 'catalog' && (catalogLoading || Boolean(catalogError))) || !currentBrand.trim() || !currentModel.trim()}>{busy ? '保存中…' : '保存'}</button>
        </>}
      >
        <form id="manual-sku-form" onSubmit={save} className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-wrap gap-2 sm:col-span-2" aria-label="品牌型号录入方式">
            <button type="button" aria-pressed={identityMode === 'catalog'} onClick={() => setIdentityMode('catalog')} className={'rounded-lg border px-3 py-2 text-xs font-medium transition active:scale-[0.98] ' + (identityMode === 'catalog' ? 'border-primary bg-primary/10 text-primary' : 'border-line bg-white text-ink-soft hover:border-primary/30')}>从目录选择</button>
            <button type="button" aria-pressed={identityMode === 'custom'} onClick={() => setIdentityMode('custom')} className={'rounded-lg border px-3 py-2 text-xs font-medium transition active:scale-[0.98] ' + (identityMode === 'custom' ? 'border-primary bg-primary/10 text-primary' : 'border-line bg-white text-ink-soft hover:border-primary/30')}>自定义品牌和型号</button>
          </div>
          {identityMode === 'catalog' && catalogError && <p role="alert" className="text-sm text-danger sm:col-span-2">{catalogError}，请刷新后重试。</p>}
          <div className="text-sm text-ink-deep">
            <span>产品类型<span className="ml-1 text-danger">*</span></span>
            <div className="mt-2"><CustomSelect aria-label="手工 SKU 产品类型" value={draft.productType} onChange={value => setDraft({ ...draft, productType: value, brand: '', model: '', year: '' })} options={typeOptions} /></div>
          </div>
          {identityMode === 'catalog' ? <>
            <div className="text-sm text-ink-deep">
              <span>品牌<span className="ml-1 text-danger">*</span></span>
              <div className="mt-2"><CustomSelect aria-label="手工 SKU 品牌" value={draft.brand} onChange={value => setDraft({ ...draft, brand: value, model: '', year: '' })} options={brandOptions} placeholder={catalogLoading ? '加载品牌中…' : '请选择品牌'} searchable disabled={catalogLoading || Boolean(catalogError)} /></div>
            </div>
            <div className="text-sm text-ink-deep">
              <span>型号<span className="ml-1 text-danger">*</span></span>
              <div className="mt-2"><CustomSelect aria-label="手工 SKU 型号" value={draft.model} onChange={value => setDraft({ ...draft, model: value })} options={modelOptions} placeholder={!draft.brand ? '请先选择品牌' : catalogLoading ? '加载型号中…' : '请选择型号'} searchable disabled={!draft.brand || catalogLoading || Boolean(catalogError)} /></div>
            </div>
            <label className="text-sm text-ink-deep">型号年份<input className="field mt-2" type="number" min="1900" max="2100" value={draft.year} onChange={event => setDraft({ ...draft, year: event.target.value })} placeholder="可选" /></label>
          </> : <>
            <label className="text-sm text-ink-deep">品牌<span className="ml-1 text-danger">*</span><input className="field mt-2" type="text" maxLength={80} value={customBrand} onChange={event => setCustomBrand(event.target.value)} placeholder="输入品牌名称" aria-label="自定义品牌名称" /></label>
            <label className="text-sm text-ink-deep">型号<span className="ml-1 text-danger">*</span><input className="field mt-2" type="text" maxLength={160} value={customModel} onChange={event => setCustomModel(event.target.value)} placeholder="输入型号" aria-label="自定义型号名称" /></label>
            <label className="text-sm text-ink-deep">型号年份<input className="field mt-2" type="number" min="1900" max="2100" value={customYear} onChange={event => setCustomYear(event.target.value)} placeholder="可选" /></label>
          </>}
          <div className="my-1 border-t border-line/70 sm:col-span-2" />
          <div className="sm:col-span-2">
            <p className="mb-3 text-xs text-ink-soft">登记已确认的配置选项；采购录入时仍可按 SKU 自定义 CPU、内存、硬盘、显卡和屏幕信息。</p>
            <div className="grid gap-4 sm:grid-cols-2">
              <OptionListEditor label="CPU" values={draft.cpuOptions} onChange={values => setDraft({ ...draft, cpuOptions: values })} placeholder="输入并添加 CPU 选项" />
              <OptionListEditor label="内存" values={draft.ramOptions} onChange={values => setDraft({ ...draft, ramOptions: values })} placeholder="输入并添加内存" suggestions={['8GB', '16GB', '24GB', '32GB']} />
              <OptionListEditor label="显卡" values={draft.gpuOptions} onChange={values => setDraft({ ...draft, gpuOptions: values })} placeholder="输入并添加显卡，如 RTX 4060" />
              <OptionListEditor label="硬盘" values={draft.storageOptions} onChange={values => setDraft({ ...draft, storageOptions: values })} placeholder="输入并添加容量，如 512GB SSD" suggestions={['256GB', '512GB', '1TB', '1.5TB', '2TB']} />
              <div className="sm:col-span-2"><OptionListEditor label="屏幕规格" values={draft.screenOptions} onChange={values => setDraft({ ...draft, screenOptions: values })} placeholder="输入并添加规格，如 2.5K" suggestions={['FHD', 'FHD+', '2K', '2.5K', '2.8K', '3.2K', '4K']} /></div>
            </div>
          </div>
        </form>
      </BusinessDialog>
    )}
    <ConfirmDialog isOpen={discardConfirm} title="放弃手工 SKU 编辑？" message="当前内容尚未保存。关闭后将丢弃本次修改。" cancelText="继续编辑" confirmText="关闭并放弃" danger onCancel={() => setDiscardConfirm(false)} onConfirm={() => { setDiscardConfirm(false); setDialogOpen(false); setEditing(null); }} />
    <ConfirmDialog isOpen={!!deleteTarget} title="移除手工 SKU？" message={`“${deleteTarget?.brand || ''} ${deleteTarget?.model || ''}”将从手工录入选择器中移除，历史采购记录会保留。`} confirmText={busy ? '处理中…' : '确认移除'} danger onCancel={() => { if (!busy) setDeleteTarget(null); }} onConfirm={() => void remove()} />
    {toast && active && <Toast isOpen type={toast.type} message={toast.message} onClose={() => setToast(null)} />}
  </div>;
}
