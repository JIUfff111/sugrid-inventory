'use client';

import { useCallback, useEffect, useMemo, useState, type ChangeEvent, type FormEvent } from 'react';
import {
  ArrowDownToLine,
  Database,
  Download,
  Edit3,
  FileJson,
  FileUp,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import BusinessDialog from '@/components/BusinessDialog';
import ConfirmDialog from '@/components/ConfirmDialog';
import CustomSelect from '@/components/CustomSelect';
import Toast, { type ToastType } from '@/components/Toast';
import { useWorkspace, useWorkspaceDirty } from '@/components/WorkspaceContext';

type Resource = { key: string; label: string; description?: string; count?: number; fields?: string[]; editable?: boolean; creatable?: boolean; deletable?: boolean };
type WarehouseOption = { id: string; name: string; status?: string };
type Row = Record<string, unknown>;
type Field = { key: string; label?: string; editable?: boolean; type?: string };
type ImportPreview = { created?: number; updated?: number; conflicts?: number; errors?: string[]; summary?: string; canApply?: boolean };
type ApiPayload = {
  success?: boolean;
  data?: {
    resources?: Resource[];
    items?: Row[];
    item?: Row;
    fields?: Field[];
    pagination?: { page?: number; pageSize?: number; total?: number; totalPages?: number };
    preview?: { created?: number; updated?: number; conflicts?: number; errors?: string[]; summary?: string };
    created?: number;
    inserted?: number;
    updated?: number;
    conflicts?: number;
    errors?: string[];
    message?: string;
  };
  error?: { message?: string };
};

const fallbackResources: Resource[] = [
  { key: 'users', label: '用户资料', description: '角色、状态和仓库权限' },
  { key: 'user_warehouses', label: '仓库权限', description: '用户与仓库的授权关系' },
  { key: 'warehouses', label: '仓库', description: '仓库名称和启用状态' },
  { key: 'suppliers', label: '供应商', description: '供应商主数据' },
  { key: 'sales_channels', label: '销售渠道', description: '销售渠道配置' },
  { key: 'skus', label: '内置 SKU', description: '系统内置型号目录' },
  { key: 'manual_skus', label: '手工 SKU', description: '独立维护的型号目录' },
  { key: 'purchase_orders', label: '采购单', description: '采购业务记录', creatable: false, deletable: false },
  { key: 'purchase_items', label: '采购明细', description: '采购机器明细', creatable: false },
  { key: 'inventory', label: '库存机器', description: '机器档案和在库状态', creatable: false, deletable: false },
  { key: 'sales_records', label: '销售记录', description: '销售出库历史', creatable: false, deletable: false },
  { key: 'sales_record_items', label: '销售明细', description: '销售机器快照', creatable: false, deletable: false },
  { key: 'rental_records', label: '租赁记录', description: '租赁出库和归还', creatable: false, deletable: false },
  { key: 'after_sale_records', label: '售后记录', description: '售后处理和暂存', creatable: false, deletable: false },
  { key: 'after_sale_stock', label: '售后暂存', description: '售后收到的机器', creatable: false, deletable: false },
  { key: 'return_orders', label: '供应商退货', description: '供应商退货记录', creatable: false, deletable: false },
  { key: 'return_receipts', label: '退货入库', description: '客户退货入库记录', creatable: false, deletable: false },
  { key: 'transfers', label: '调拨单', description: '仓库调拨记录', creatable: false, deletable: false },
  { key: 'transfer_items', label: '调拨明细', description: '调拨机器明细', creatable: false, deletable: false },
  { key: 'inventory_status_definitions', label: '自定义状态', description: '库存状态定义' },
  { key: 'inventory_status_records', label: '库存状态记录', description: '机器状态登记历史', creatable: false, deletable: false },
  { key: 'inventory_movements', label: '机器生命周期', description: '机器全部移动记录，只读' },
  { key: 'label_templates', label: '标签模板', description: '打印模板配置' },
  { key: 'login_events', label: '登录记录', description: '只读安全审计' },
  { key: 'data_management_audit', label: '数据操作记录', description: '数据导入导出和删除审计' },
];

const hiddenKeys = new Set(['password', 'tokenHash', 'sessionToken', 'rawToken', 'secret']);
const readOnlyKeys = new Set(['id', 'createdAt', 'updatedAt', 'deletedAt', 'deletedBy']);

function messageOf(payload: ApiPayload, fallback: string) { return payload.error?.message || fallback; }
function normalizeData(payload: ApiPayload) { return payload.data || {}; }
function stringifyValue(value: unknown) {
  if (value === null || value === undefined || value === '') return '-';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
function safeJson(value: string): Row | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Row : null;
  } catch { return null; }
}

export default function DataManagementPage() {
  const { active, user } = useWorkspace();
  const [resources, setResources] = useState<Resource[]>(fallbackResources);
  const [selected, setSelected] = useState('inventory');
  const [items, setItems] = useState<Row[]>([]);
  const [fields, setFields] = useState<Field[]>([]);
  const [search, setSearch] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [warehouses, setWarehouses] = useState<WarehouseOption[]>([]);
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState('20');
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<Row | null>(null);
  const [draft, setDraft] = useState('');
  const [initialDraft, setInitialDraft] = useState('');
  const [discardConfirm, setDiscardConfirm] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Row | null>(null);
  const [deleteReferences, setDeleteReferences] = useState<Array<{ label: string; count: number }>>([]);
  const [importOpen, setImportOpen] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importContent, setImportContent] = useState('');
  const [importMode, setImportMode] = useState('insert');
  const [importResource, setImportResource] = useState('inventory');
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: ToastType } | null>(null);
  const dirty = editorOpen && draft !== initialDraft;
  useWorkspaceDirty(dirty || importOpen && !!importContent);

  const selectedResource = resources.find(resource => resource.key === selected) || fallbackResources.find(resource => resource.key === selected);

  const loadResources = useCallback(async () => {
    try {
      const response = await fetch('/api/data-management/resources', { cache: 'no-store' });
      const payload = await response.json() as ApiPayload;
      if (!response.ok || !payload.success) throw new Error(messageOf(payload, '数据资源加载失败'));
      const rawData = payload.data;
      const next = Array.isArray(rawData) ? rawData as Resource[] : normalizeData(payload).resources;
      if (next?.length) {
        setResources(next);
        setSelected(current => next.some(item => item.key === current) ? current : next[0].key);
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '数据资源加载失败');
    }
  }, []);

  const loadRows = useCallback(async () => {
    if (!active || !selected) return;
    setLoading(true); setError('');
    try {
      const params = new URLSearchParams({ page: String(page), pageSize, includeDeleted: includeDeleted ? '1' : '0' });
      if (search.trim()) params.set('search', search.trim());
      if (dateFrom) params.set('dateFrom', dateFrom);
      if (dateTo) params.set('dateTo', dateTo);
      if (warehouseId) params.set('warehouseId', warehouseId);
      const response = await fetch(`/api/data-management/${encodeURIComponent(selected)}?${params}`, { cache: 'no-store' });
      const payload = await response.json() as ApiPayload;
      if (!response.ok || !payload.success) throw new Error(messageOf(payload, '数据加载失败'));
      const data = normalizeData(payload);
      setItems(data.items || []);
      setFields(data.fields || []);
      setTotal(Number(data.pagination?.total ?? data.items?.length ?? 0));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '数据加载失败');
      setItems([]); setFields([]); setTotal(0);
    } finally { setLoading(false); setRefreshing(false); }
  }, [active, dateFrom, dateTo, includeDeleted, page, pageSize, search, selected, warehouseId]);

  useEffect(() => { if (active) void loadResources(); }, [active, loadResources]);
  useEffect(() => {
    if (!active) return;
    void fetch('/api/warehouses', { cache: 'no-store' })
      .then(async response => {
        const payload = await response.json() as ApiPayload & { data?: unknown };
        if (!response.ok || !payload.success || !Array.isArray(payload.data)) return;
        setWarehouses((payload.data as WarehouseOption[]).filter(warehouse => warehouse.status !== 'disabled'));
      })
      .catch(() => { /* The resource list remains usable when warehouse options fail. */ });
  }, [active]);
  useEffect(() => { void loadRows(); }, [loadRows]);
  useEffect(() => { setPage(1); }, [selected, search, dateFrom, dateTo, warehouseId, includeDeleted, pageSize]);

  const columns = useMemo(() => {
    const fromFields = fields.map(field => field.key).filter(key => !hiddenKeys.has(key));
    const fromRows = items.flatMap(item => Object.keys(item));
    return [...new Set([...fromFields, ...fromRows])].filter(key => !hiddenKeys.has(key)).slice(0, 10);
  }, [fields, items]);
  const totalPages = Math.max(1, Math.ceil(total / Number(pageSize || 20)));
  const editable = selectedResource?.editable !== false;
  const creatable = selectedResource?.creatable !== false;
  const deletable = selectedResource?.deletable !== false;
  const supportsWarehouseFilter = selectedResource?.fields?.includes('warehouseId') || selectedResource?.key === 'user_warehouses';

  function openEditor(item?: Row) {
    if (!item && !creatable) {
      setToast({ type: 'error', message: '该业务记录必须通过对应业务流程创建' });
      return;
    }
    const value = item || {};
    setEditing(item || null); setDraft(JSON.stringify(value, null, 2)); setInitialDraft(JSON.stringify(value, null, 2)); setEditorOpen(true);
  }
  function closeEditor() {
    if (busy) return;
    if (dirty) { setDiscardConfirm(true); return; }
    setEditorOpen(false); setEditing(null); setDraft('');
  }
  function discardEditor() { setDiscardConfirm(false); setEditorOpen(false); setEditing(null); setDraft(''); }
  async function saveEditor(event: FormEvent) {
    event.preventDefault();
    const body = safeJson(draft);
    if (!body) { setToast({ type: 'error', message: '请输入有效的 JSON 对象' }); return; }
    setBusy(true);
    try {
      const writable = new Set(fields.filter(field => field.editable).map(field => field.key));
      const data = editing ? Object.fromEntries(Object.entries(body).filter(([key]) => writable.has(key))) : body;
      const response = await fetch(`/api/data-management/${encodeURIComponent(selected)}`, {
        method: editing ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editing ? { id: editing.id, data } : data),
      });
      const payload = await response.json() as ApiPayload;
      if (!response.ok || !payload.success) throw new Error(messageOf(payload, '保存失败'));
      setToast({ type: 'success', message: editing ? '记录已更新' : '记录已创建' });
      setEditorOpen(false); setEditing(null); await loadRows();
    } catch (saveError) { setToast({ type: 'error', message: saveError instanceof Error ? saveError.message : '保存失败' }); }
    finally { setBusy(false); }
  }
  async function remove() {
    if (!deleteTarget?.id) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/data-management/${encodeURIComponent(selected)}?id=${encodeURIComponent(String(deleteTarget.id))}`, { method: 'DELETE' });
      const payload = await response.json() as ApiPayload;
      if (!response.ok || !payload.success) throw new Error(messageOf(payload, '删除失败'));
      setToast({ type: 'success', message: payload.data?.message || '记录已删除' }); setDeleteTarget(null); setDeleteReferences([]); await loadRows();
    } catch (removeError) { setToast({ type: 'error', message: removeError instanceof Error ? removeError.message : '删除失败' }); }
    finally { setBusy(false); }
  }
  async function prepareDelete(item: Row) {
    if (!item.id) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/data-management/${encodeURIComponent(selected)}?id=${encodeURIComponent(String(item.id))}`, { cache: 'no-store' });
      const payload = await response.json() as ApiPayload;
      if (!response.ok || !payload.success) throw new Error(messageOf(payload, '获取关联预览失败'));
      const data = normalizeData(payload) as ApiPayload['data'] & { references?: Array<{ label: string; count: number }> };
      setDeleteReferences(data.references || []);
      setDeleteTarget(item);
    } catch (previewError) {
      setToast({ type: 'error', message: previewError instanceof Error ? previewError.message : '获取关联预览失败' });
    } finally { setBusy(false); }
  }
  function exportData(format: 'json' | 'csv') {
    const params = new URLSearchParams({ resource: selected, format });
    if (search.trim()) params.set('search', search.trim());
    if (dateFrom) params.set('dateFrom', dateFrom);
    if (dateTo) params.set('dateTo', dateTo);
    if (warehouseId) params.set('warehouseId', warehouseId);
    if (includeDeleted) params.set('includeDeleted', '1');
    const link = document.createElement('a');
    link.href = `/api/data-management/export?${params}`;
    link.download = `sugrid-${selected}-${format}`;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }
  function exportAllJson() {
    const link = document.createElement('a');
    link.href = '/api/data-management/export?resource=all&format=json';
    link.download = 'sugrid-data.json';
    document.body.appendChild(link);
    link.click();
    link.remove();
  }
  async function readImportFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setImportFile(file); setPreview(null); setImportContent(await file.text());
  }
  async function previewImport() {
    if (!importContent || !importFile) { setToast({ type: 'error', message: '请选择要导入的文件' }); return; }
    setImportBusy(true);
    try {
      const response = await fetch('/api/data-management/import/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileName: importFile.name, content: importContent, mode: importMode, ...(importResource === 'all' ? {} : { resource: importResource }) }) });
      const payload = await response.json() as ApiPayload;
      if (!response.ok || !payload.success) throw new Error(messageOf(payload, '导入预览失败'));
      const data = normalizeData(payload) as ApiPayload['data'] & { reports?: Array<{ valid?: number; conflicts?: number; errors?: Array<{ message?: string } | string> }>; canApply?: boolean };
      if (data.reports?.length) {
        const reports = data.reports;
        setPreview({
          created: reports.reduce((sum, report) => sum + Number(report.valid || 0), 0),
          conflicts: reports.reduce((sum, report) => sum + Number(report.conflicts || 0), 0),
          errors: reports.flatMap(report => (report.errors || []).map(item => typeof item === 'string' ? item : item.message || '导入记录校验失败')),
          canApply: data.canApply !== false,
          summary: `已识别 ${reports.length} 个数据资源`,
        });
      } else setPreview((data.preview as ImportPreview | undefined) || data as ImportPreview);
    } catch (previewError) { setToast({ type: 'error', message: previewError instanceof Error ? previewError.message : '导入预览失败' }); }
    finally { setImportBusy(false); }
  }
  async function applyImport() {
    if (!importContent || !importFile || !preview) return;
    setImportBusy(true);
    try {
      const response = await fetch('/api/data-management/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileName: importFile.name, content: importContent, mode: importMode, ...(importResource === 'all' ? {} : { resource: importResource }) }) });
      const payload = await response.json() as ApiPayload;
      if (!response.ok || !payload.success) throw new Error(messageOf(payload, '导入失败'));
      const data = normalizeData(payload);
      setToast({ type: 'success', message: `导入完成：新增 ${data.created ?? data.inserted ?? 0} 条，更新 ${data.updated || 0} 条` });
      setImportOpen(false); setImportFile(null); setImportContent(''); setPreview(null); await loadRows();
    } catch (importError) { setToast({ type: 'error', message: importError instanceof Error ? importError.message : '导入失败' }); }
    finally { setImportBusy(false); }
  }

  if (!user?.isSystemAccount) return <div className="mx-auto max-w-3xl py-20 text-center"><ShieldCheck className="mx-auto h-10 w-10 text-ink-soft/50" /><h1 className="mt-4 text-lg font-semibold text-ink-deep">无权访问数据管理</h1><p className="mt-2 text-sm text-ink-soft">此页面仅对内置系统管理员开放。</p></div>;

  return <div className="mx-auto max-w-[1500px] space-y-5 animate-fade-in">
    <header className="flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-3"><span className="rounded-2xl bg-primary/10 p-3 text-primary"><Database className="h-5 w-5" /></span><div><h1 className="text-2xl font-semibold text-ink-deep">数据管理</h1><p className="mt-1 text-sm text-ink-soft">管理业务数据、导出迁移包，并保留每次操作的审计记录。</p></div></div><div className="flex flex-wrap gap-2"><button type="button" className="btn-ghost inline-flex items-center gap-1.5" onClick={() => { setRefreshing(true); void loadRows(); }} disabled={loading}><RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />刷新</button><button type="button" className="btn-ghost inline-flex items-center gap-1.5" onClick={() => { setImportResource(selected); setImportOpen(true); }}><Upload className="h-4 w-4" />导入</button><button type="button" className="btn-secondary inline-flex items-center gap-1.5" onClick={() => exportData('csv')}><ArrowDownToLine className="h-4 w-4" />导出 CSV</button><button type="button" className="btn-secondary inline-flex items-center gap-1.5" onClick={exportAllJson}><Download className="h-4 w-4" />全量 JSON</button><button type="button" className="btn-primary inline-flex items-center gap-1.5" onClick={() => exportData('json')}><FileJson className="h-4 w-4" />导出 JSON</button></div></header>
    <div className="grid gap-5 lg:grid-cols-[240px_minmax(0,1fr)]">
      <aside className="glass h-fit overflow-hidden rounded-2xl"><div className="border-b border-line/60 px-4 py-3"><p className="text-sm font-semibold text-ink-deep">数据资源</p><p className="mt-1 text-xs text-ink-soft">只显示当前账号可管理的数据集</p></div><div className="max-h-[560px] overflow-y-auto p-2">{resources.map(resource => <button key={resource.key} type="button" onClick={() => setSelected(resource.key)} className={`w-full rounded-xl px-3 py-2.5 text-left transition-all ${selected === resource.key ? 'bg-primary/10 text-primary shadow-sm' : 'text-ink hover:bg-white/70'}`}><span className="block truncate text-sm font-medium">{resource.label}</span><span className="mt-0.5 block truncate text-[11px] text-ink-soft">{resource.description || resource.key}{typeof resource.count === 'number' ? ` · ${resource.count}` : ''}</span></button>)}</div></aside>
      <section className="glass min-w-0 overflow-hidden rounded-2xl"><div className="grid gap-3 border-b border-line/60 p-4 md:grid-cols-[minmax(220px,1fr)_150px_150px_150px_auto_auto]"><label className="relative"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-soft" /><input className="field pl-10" value={search} onChange={event => setSearch(event.target.value)} placeholder={`搜索${selectedResource?.label || '数据'}...`} aria-label="搜索数据" /></label><label className="text-xs text-ink-soft"><span className="sr-only">开始日期</span><input type="date" className="field" value={dateFrom} onChange={event => setDateFrom(event.target.value)} aria-label="开始日期" /></label><label className="text-xs text-ink-soft"><span className="sr-only">结束日期</span><input type="date" className="field" value={dateTo} onChange={event => setDateTo(event.target.value)} aria-label="结束日期" /></label>{supportsWarehouseFilter ? <CustomSelect value={warehouseId} onChange={setWarehouseId} options={[{ value: '', label: '全部授权仓库' }, ...warehouses.map(warehouse => ({ value: warehouse.id, label: warehouse.name }))]} aria-label="仓库筛选" /> : <span aria-hidden="true" /> }<CustomSelect value={pageSize} onChange={value => setPageSize(value)} options={[{ value: '20', label: '每页 20 条' }, { value: '50', label: '每页 50 条' }, { value: '100', label: '每页 100 条' }]} aria-label="每页数量" /><label className="flex items-center gap-2 rounded-xl border border-line/70 bg-white/45 px-3 text-xs text-ink-soft"><input type="checkbox" checked={includeDeleted} onChange={event => setIncludeDeleted(event.target.checked)} />显示已删除</label><button type="button" className="btn-primary inline-flex items-center justify-center gap-1.5" onClick={() => openEditor()} disabled={!editable || !creatable} title={!creatable ? '该资源必须通过业务流程创建' : undefined}><Plus className="h-4 w-4" />新增</button></div>{error && <div role="alert" className="m-4 flex items-center justify-between rounded-xl border border-danger/20 bg-danger/5 p-3 text-sm text-danger">{error}<button type="button" className="btn-ghost" onClick={() => void loadRows()}>重试</button></div>}{loading ? <div className="flex items-center justify-center gap-2 p-14 text-sm text-ink-soft"><RefreshCw className="h-4 w-4 animate-spin" />加载中</div> : items.length === 0 ? <div className="p-14 text-center text-sm text-ink-soft"><Database className="mx-auto mb-3 h-8 w-8 text-ink-soft/50" />暂无匹配记录</div> : <div className="overflow-x-auto"><table className="data-table w-full min-w-[900px] text-left text-sm"><thead><tr>{columns.map(key => <th key={key}>{fields.find(field => field.key === key)?.label || key}</th>)}<th>操作</th></tr></thead><tbody>{items.map((item, index) => <tr key={String(item.id || index)}>{columns.map(key => <td key={key} className="max-w-[260px] truncate" title={stringifyValue(item[key])}>{stringifyValue(item[key])}</td>)}<td><div className="flex gap-1"><button type="button" className="btn-ghost inline-flex items-center gap-1" onClick={() => openEditor(item)} disabled={!editable}><Edit3 className="h-3.5 w-3.5" />编辑</button>{item.id !== undefined && editable && deletable && <button type="button" className="btn-ghost inline-flex items-center gap-1 text-danger" onClick={() => void prepareDelete(item)} disabled={busy}><Trash2 className="h-3.5 w-3.5" />{busy ? '检查中…' : '删除'}</button>}</div></td></tr>)}</tbody></table></div>}<div className="flex flex-wrap items-center justify-between gap-2 border-t border-line/60 px-4 py-3 text-xs text-ink-soft"><span>共 {total} 条 · 第 {Math.min(page, totalPages)} / {totalPages} 页</span><div className="flex gap-2"><button type="button" className="btn-ghost" disabled={page <= 1} onClick={() => setPage(current => current - 1)}>上一页</button><button type="button" className="btn-ghost" disabled={page >= totalPages} onClick={() => setPage(current => current + 1)}>下一页</button></div></div></section>
    </div>
    {editorOpen && <BusinessDialog title={editing ? `编辑${selectedResource?.label || '记录'}` : `新增${selectedResource?.label || '记录'}`} description="仅允许修改资源白名单中的字段，系统字段和认证敏感字段不会被写入。" onClose={closeEditor} footer={<><button type="button" className="btn-ghost" onClick={closeEditor} disabled={busy}>取消</button><button type="submit" form="data-editor-form" className="btn-primary" disabled={busy}>{busy ? '保存中…' : '保存'}</button></>}><form id="data-editor-form" onSubmit={saveEditor} className="space-y-3"><label className="block text-sm text-ink-deep">记录 JSON<textarea className="field mt-2 min-h-[320px] resize-y font-mono text-xs leading-5" value={draft} onChange={event => setDraft(event.target.value)} spellCheck={false} /></label><p className="text-xs leading-5 text-ink-soft">只读字段：{Array.from(readOnlyKeys).join('、')}。保存前会再次执行关联、唯一性和权限校验。</p></form></BusinessDialog>}
    {importOpen && <BusinessDialog title="导入数据" description="先预览校验，确认后才会创建备份并在事务中写入。" onClose={() => { if (!importBusy) setImportOpen(false); }} footer={<><button type="button" className="btn-ghost" onClick={() => setImportOpen(false)} disabled={importBusy}>取消</button>{preview && <button type="button" className="btn-primary" onClick={() => void applyImport()} disabled={importBusy || preview.canApply === false}>{importBusy ? '导入中…' : '确认导入'}</button>}</>}><div className="space-y-4"><label className="flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-primary/30 bg-primary/5 p-6 text-sm text-primary transition hover:bg-primary/10"><FileUp className="h-5 w-5" />{importFile ? importFile.name : '选择 JSON 或 CSV 文件'}<input type="file" accept=".json,.csv,application/json,text/csv" className="hidden" onChange={event => void readImportFile(event)} /></label><CustomSelect value={importResource} onChange={value => { setImportResource(value); setPreview(null); }} options={[{ value: 'all', label: '全量 JSON 数据包' }, ...resources.map(resource => ({ value: resource.key, label: resource.label }))]} aria-label="导入资源" /><CustomSelect value={importMode} onChange={value => { setImportMode(value); setPreview(null); }} options={[{ value: 'insert', label: '仅新增（推荐）' }, { value: 'upsert', label: '按 ID 更新或新增' }]} aria-label="导入模式" />{importFile && <div className="flex items-center justify-between rounded-xl bg-white/60 px-3 py-2 text-xs text-ink-soft"><span>{importContent.length.toLocaleString()} 字符 · 资源：{importResource === 'all' ? '全量数据' : resources.find(resource => resource.key === importResource)?.label || importResource}</span><button type="button" className="btn-ghost p-1" onClick={() => { setImportFile(null); setImportContent(''); setPreview(null); }} aria-label="移除文件"><X className="h-4 w-4" /></button></div>}<button type="button" className="btn-secondary inline-flex w-full items-center justify-center gap-2" disabled={!importFile || importBusy} onClick={() => void previewImport()}><ShieldCheck className="h-4 w-4" />{importBusy ? '校验中…' : '预览校验'}</button>{preview && <div className="rounded-xl border border-line/70 bg-white/60 p-4 text-sm"><p className="font-medium text-ink-deep">预览结果</p><div className="mt-2 grid grid-cols-2 gap-2 text-xs text-ink-soft"><span>新增：{preview.created ?? 0}</span><span>更新：{preview.updated ?? 0}</span><span>冲突：{preview.conflicts ?? 0}</span><span>错误：{preview.errors?.length ?? 0}</span></div>{preview.summary && <p className="mt-3 text-xs text-ink-soft">{preview.summary}</p>}{preview.errors?.length ? <ul className="mt-3 space-y-1 text-xs text-danger">{preview.errors.slice(0, 8).map((item, index) => <li key={index}>{item}</li>)}</ul> : null}</div>}</div></BusinessDialog>}
    <ConfirmDialog isOpen={discardConfirm} title="放弃未保存的编辑？" message="当前 JSON 尚未保存，关闭后这些修改会丢失。" cancelText="继续编辑" confirmText="关闭并放弃" danger onCancel={() => setDiscardConfirm(false)} onConfirm={discardEditor} />
    <ConfirmDialog isOpen={!!deleteTarget} title={`删除${selectedResource?.label || '记录'}？`} message={deleteReferences.length ? `检测到关联数据：${deleteReferences.map(reference => `${reference.label} ${reference.count} 条`).join('、')}。服务器会阻止删除存在业务关联的记录。` : '未检测到关联数据。确认后服务器仍会在事务中再次校验，业务历史记录不会被强制级联删除。'} confirmText={busy ? '处理中…' : '确认删除'} danger onCancel={() => { if (!busy) { setDeleteTarget(null); setDeleteReferences([]); } }} onConfirm={() => void remove()} />
    {toast && active && <Toast isOpen type={toast.type} message={toast.message} onClose={() => setToast(null)} />}
  </div>;
}
