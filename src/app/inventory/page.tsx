/**
 * 在库清单
 * 查看已入库机器，支持按状态、SN、型号和供应商筛选，并编辑库存备注。
 */
'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { FormEvent, useEffect, useState } from 'react';
import CustomSelect from '@/components/CustomSelect';
import BusinessDialog from '@/components/BusinessDialog';
import ConfirmDialog from '@/components/ConfirmDialog';
import MachineSearchInput from '@/components/MachineSearchInput';
import InventoryStatusDialog, { type InventoryStatusDefinition, type InventoryStatusRecord } from '@/components/InventoryStatusDialog';
import { WorkspaceSection, useWorkspace, useWorkspaceDirty } from '@/components/WorkspaceContext';
import InventoryMovementTimeline from '@/components/InventoryMovementTimeline';
import InventoryPurgeDialog from '@/components/InventoryPurgeDialog';
import { formatProductName } from '@/lib/product-name';
import { formatCPUDisplay, formatGPUDisplay, formatScreenDisplay } from '@/lib/sku-display';
import { InventoryMovementsWorkspace } from '@/app/inventory/movements/page';
import { TransfersWorkspace } from '@/app/transfers/page';
import {
  ArrowRightLeft,
  BarChart3,
  Check,
  CheckSquare,
  ChevronLeft,
  ChevronRight,
  Eye,
  FileDown,
  Filter,
  History,
  LayoutGrid,
  MemoryStick,
  PackageOpen,
  Pencil,
  Printer,
  RefreshCw,
  Save,
  Search,
  SlidersHorizontal,
  Settings2,
  Wrench,
  Table2,
  Trash2,
  X,
} from 'lucide-react';

type InventoryStatus = 'in_stock' | 'sold' | 'returning';

interface InventoryItem {
  [key: string]: unknown;
  warehouseId: string;
  warehouseName?: string;
  id: string;
  purchaseOrderId: string;
  purchaseItemId: string;
  purchaseNo: string | null;
  sn: string;
  productType: string;
  brand: string;
  model: string;
  year: string | null;
  cpu: string;
  ram: string;
  gpu: string | null;
  storage: string;
  screen: string;
  touchScreen: number | null;
  purchasePrice: number;
  supplierId: string;
  supplierName: string;
  status: InventoryStatus | string;
  inboundDate: string;
  inboundDays: number;
  soldDate: string | null;
  sellingPrice: number | null;
  saleChannel: string | null;
  saleOrderNo: string | null;
  profit: number | null;
  remark: string | null;
  skuRemark: string | null;
  createdAt: string;
  updatedAt: string;
  currentStatusRecordId?: string | null;
  customStatusId?: string | null;
  customStatusName?: string | null;
  customStatusColor?: string | null;
  allowStockOperations?: number | boolean;
  statusRecord?: InventoryStatusRecord | null;
  afterSaleId?: string | null;
  afterSaleNo?: string | null;
  afterSaleStatus?: string | null;
  afterSaleStockStatus?: string | null;
}

interface InventoryStats {
  total: number;
  inStock: number;
  sold: number;
  returning: number;
  inStockCost: number;
  custom?: number;
  customCost?: number;
  available?: number;
}

interface InventoryResponse {
  items: InventoryItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  stats: InventoryStats;
}

interface InventoryFilters {
  warehouseId: string;
  brand: string;
  model: string;
  supplierId: string;
  inboundFrom: string;
  inboundTo: string;
  priceMin: string;
  priceMax: string;
  ageMin: string;
  ageMax: string;
}

interface FilterOptions {
  brands: string[];
  models: string[];
  suppliers: Array<{ id: string; name: string }>;
  statusDefinitions?: InventoryStatusDefinition[];
}

const EMPTY_STATS: InventoryStats = {
  total: 0,
  inStock: 0,
  sold: 0,
  returning: 0,
  inStockCost: 0,
};

const EMPTY_FILTERS: InventoryFilters = {
  warehouseId: '',
  brand: '',
  model: '',
  supplierId: '',
  inboundFrom: '',
  inboundTo: '',
  priceMin: '',
  priceMax: '',
  ageMin: '',
  ageMax: '',
};

const EMPTY_FILTER_OPTIONS: FilterOptions = { brands: [], models: [], suppliers: [] };

const STATUS_LABELS: Record<string, string> = {
  in_stock: '在库',
  sold: '已售',
  returning: '退货中',
  renting: '租赁中',
  reserved: '已预留',
  returned: '已退货',
  after_sale: '售后中',
  on_way: '在途',
};

const STATUS_CLASS: Record<string, string> = {
  in_stock: 'status-pill ok',
  sold: 'status-pill info',
  returning: 'status-pill warn',
  renting: 'status-pill info',
  reserved: 'status-pill warn',
  returned: 'status-pill',
  after_sale: 'status-pill danger',
  on_way: 'status-pill info',
};

function formatMoney(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '-';
  return `¥${Number(value).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(value: string | null | undefined) {
  if (!value) return '-';
  const date = new Date(value.replace(' ', 'T'));
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

function statusLabel(status: string) {
  return STATUS_LABELS[status] || status || '未知';
}

function statusClass(status: string) {
  return STATUS_CLASS[status] || 'status-pill';
}

function productName(item: Pick<InventoryItem, 'brand' | 'model' | 'year'>) {
  return formatProductName(item);
}

export default function InventoryPage() {
  const router = useRouter();
  const { active, searchParams, user } = useWorkspace();
  const [activeWorkspace, setActiveWorkspace] = useState<'list' | 'movements' | 'transfers'>('list');
  const [movementSearch, setMovementSearch] = useState('');
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [stats, setStats] = useState<InventoryStats>(EMPTY_STATS);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [filters, setFilters] = useState<InventoryFilters>(EMPTY_FILTERS);
  const [filterDraft, setFilterDraft] = useState<InventoryFilters>(EMPTY_FILTERS);
  const [filterOptions, setFilterOptions] = useState<FilterOptions>(EMPTY_FILTER_OPTIONS);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<InventoryItem | null>(null);
  const [remark, setRemark] = useState('');
  const [savingRemark, setSavingRemark] = useState(false);
  const [saved, setSaved] = useState(false);
  const [remarkError, setRemarkError] = useState('');
  const [viewMode, setViewMode] = useState<'table' | 'cards'>('table');
  const [viewHydrated, setViewHydrated] = useState(false);
  const [warehouses, setWarehouses] = useState<Array<{ id: string; name: string }>>([]);
  const [isAdmin, setIsAdmin] = useState(false);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(() => new Set());
  const [statusDialog, setStatusDialog] = useState<{ mode: 'register' | 'restore' | 'manage'; machine?: InventoryItem } | null>(null);
  const [assetChangeMachine, setAssetChangeMachine] = useState<InventoryItem | null>(null);
  const [purgeMachine, setPurgeMachine] = useState<InventoryItem | null>(null);
  const [movementRevision, setMovementRevision] = useState(0);
  useWorkspaceDirty(!!selected && remark !== (selected.remark || ''));

  useEffect(() => {
    const view = searchParams.get('view');
    setActiveWorkspace(view === 'movements' || view === 'transfers' ? view : 'list');
    setMovementSearch(searchParams.get('sn') || '');
  }, [searchParams]);

  const selectWorkspace = (workspace: 'list' | 'movements' | 'transfers', sn = '') => {
    setActiveWorkspace(workspace);
    setMovementSearch(sn);
    if (workspace !== 'list') setSelected(null);
    const params = new URLSearchParams();
    if (workspace !== 'list') params.set('view', workspace);
    if (workspace === 'movements' && sn) params.set('sn', sn);
    router.push('/inventory' + (params.size ? `?${params.toString()}` : ''), { scroll: false });
  };

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem('inventory-view-mode');
      if (stored === 'cards' || stored === 'table') setViewMode(stored);
    } catch {}
    setViewHydrated(true);
  }, []);

  useEffect(() => {
    if (!viewHydrated) return;
    try { window.localStorage.setItem('inventory-view-mode', viewMode); } catch {}
  }, [viewHydrated, viewMode]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void fetch('/api/warehouses').then(r => r.json()).then(r => { if (!cancelled && r.success) setWarehouses(r.data || []); });
    setIsAdmin(user?.role === 'admin');
    fetch('/api/inventory?meta=filters', { cache: 'no-store' })
      .then((response) => response.json())
      .then((result) => {
        if (!cancelled && result.success) setFilterOptions(result.data as FilterOptions);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [active, reloadKey, user?.role]);

  useEffect(() => {
    if (!active || activeWorkspace !== 'list') return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setError('');
      try {
        const params = new URLSearchParams({ page: String(page), pageSize: '20' });
        if (search) params.set('search', search);
        if (status.startsWith('custom:')) { params.set('status', 'custom'); params.set('customStatusId', status.slice(7)); }
        else if (status) params.set('status', status);
        Object.entries(filters).forEach(([key, value]) => {
          if (value) params.set(key, value);
        });

        const response = await fetch(`/api/inventory?${params.toString()}`, { cache: 'no-store' });
        const result = await response.json();
        if (!response.ok || !result.success) {
          throw new Error(result.error?.message || '加载库存列表失败');
        }

        if (cancelled) return;
        const data = result.data as InventoryResponse;
        setItems(Array.isArray(data.items) ? data.items : []);
        setStats(data.stats || EMPTY_STATS);
        setTotal(Number(data.total || 0));
        setTotalPages(Math.max(1, Number(data.totalPages || 1)));
      } catch (fetchError) {
        if (!cancelled) {
          setError(fetchError instanceof Error ? fetchError.message : '加载库存列表失败');
          setItems([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, search ? 220 : 0);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [active, activeWorkspace, page, search, status, filters, reloadKey]);

  const itemStatusLabel = (item: InventoryItem) => item.customStatusName && (item.status === 'custom' || item.status === 'returning') ? `${item.status === 'returning' ? '退货中 · ' : ''}${item.customStatusName}` : statusLabel(item.status);
  const itemStatusStyle = (item: InventoryItem) => item.status === 'custom' && item.customStatusColor ? { color: item.customStatusColor, backgroundColor: `${item.customStatusColor}12`, borderColor: `${item.customStatusColor}40` } : undefined;
  const isSystemAccount = user?.isSystemAccount === true;
  const statusChanged = () => { setReloadKey(n => n + 1); setSelected(null); };

  const submitSearch = (event?: FormEvent) => {
    event?.preventDefault();
    setPage(1);
    setSearch(searchInput.trim());
  };

  const clearSearch = () => {
    setSearchInput('');
    setSearch('');
    setPage(1);
  };

  const selectStatus = (nextStatus: string) => {
    setStatus(nextStatus);
    setPage(1);
  };

  const applyFilters = () => {
    if (filterDraft.inboundFrom && filterDraft.inboundTo && filterDraft.inboundFrom > filterDraft.inboundTo) {
      setError('入库日期范围无效，请检查开始和结束日期');
      return;
    }
    if (filterDraft.priceMin && filterDraft.priceMax && Number(filterDraft.priceMin) > Number(filterDraft.priceMax)) {
      setError('采购价格范围无效，请检查最低和最高价格');
      return;
    }
    if (filterDraft.ageMin && filterDraft.ageMax && Number(filterDraft.ageMin) > Number(filterDraft.ageMax)) {
      setError('库龄范围无效，请检查最小和最大天数');
      return;
    }
    setError('');
    setFilters({ ...filterDraft });
    setPage(1);
  };

  const resetFilters = () => {
    setFilterDraft(EMPTY_FILTERS);
    setFilters(EMPTY_FILTERS);
    setPage(1);
  };

  const activeFilterCount = Object.values(filters).filter(Boolean).length;
  const checkedItems = items.filter((item) => checkedIds.has(item.id));
  const allPageChecked = items.length > 0 && items.every((item) => checkedIds.has(item.id));

  const toggleChecked = (id: string) => {
    setCheckedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const togglePageChecked = () => {
    setCheckedIds((current) => {
      const next = new Set(current);
      if (allPageChecked) items.forEach((item) => next.delete(item.id));
      else items.forEach((item) => next.add(item.id));
      return next;
    });
  };

  const openPrintSelected = () => {
    if (checkedItems.length === 0) return;
    router.push(`/settings/print/preview?ids=${encodeURIComponent(checkedItems.map((item) => item.id).join(','))}`);
  };

  const exportSelected = () => {
    if (checkedItems.length === 0) return;
    const headers = ['SN / IMEI', '品牌', '型号', '年份', '状态', '采购价', '供应商', '采购单号', '入库日期', '库龄（天）'];
    const rows = checkedItems.map((item) => [item.sn, item.brand, item.model, item.year || '', itemStatusLabel(item), item.purchasePrice, item.supplierName, item.purchaseNo || '', formatDate(item.inboundDate), item.inboundDays]);
    const csvCell = (value: unknown) => { const text = String(value ?? ''); return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text; };
    const csv = [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `库存选中记录-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const openDetails = (item: InventoryItem) => {
    setSelected(item);
    setRemark(item.remark || '');
    setSaved(false);
    setRemarkError('');
  };

  const closeDetails = () => {
    if (!savingRemark) setSelected(null);
  };

  const saveRemark = async () => {
    if (!selected) return;
    setSavingRemark(true);
    setSaved(false);
    setRemarkError('');
    try {
      const response = await fetch('/api/inventory', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: selected.id, remark }),
      });
      const result = await response.json();
      if (!response.ok || !result.success) {
        throw new Error(result.error?.message || '保存备注失败');
      }

      const updated = result.data as InventoryItem;
      setSelected(updated);
      setRemark(updated.remark || '');
      setItems((current) => current.map((item) => item.id === updated.id ? updated : item));
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1800);
    } catch (saveError) {
      setRemarkError(saveError instanceof Error ? saveError.message : '保存备注失败');
    } finally {
      setSavingRemark(false);
    }
  };

  const assetChanged = (machine: InventoryItem, ram: string, storage: string) => {
    const update = (item: InventoryItem) => item.id === machine.id ? { ...item, ram, storage } : item;
    setItems(current => current.map(update));
    setSelected(current => current ? update(current) : null);
    setMovementRevision(current => current + 1);
    setReloadKey(current => current + 1);
    setAssetChangeMachine(null);
  };

  const workspaceNavigation = <div role="tablist" aria-label="库存工作区" className="mb-5 flex w-fit max-w-full gap-1 overflow-x-auto rounded-xl border border-line/70 bg-white/55 p-1">
    <button type="button" role="tab" aria-selected={activeWorkspace === 'list'} onClick={() => selectWorkspace('list')} className={'inline-flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm transition ' + (activeWorkspace === 'list' ? 'bg-white text-primary shadow-sm' : 'text-ink-soft hover:bg-white/70')}><PackageOpen className="h-4 w-4" />库存清单</button>
    <button type="button" role="tab" aria-selected={activeWorkspace === 'movements'} onClick={() => selectWorkspace('movements')} className={'inline-flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm transition ' + (activeWorkspace === 'movements' ? 'bg-white text-primary shadow-sm' : 'text-ink-soft hover:bg-white/70')}><History className="h-4 w-4" />移动记录</button>
    <button type="button" role="tab" aria-selected={activeWorkspace === 'transfers'} onClick={() => selectWorkspace('transfers')} className={'inline-flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm transition ' + (activeWorkspace === 'transfers' ? 'bg-white text-primary shadow-sm' : 'text-ink-soft hover:bg-white/70')}><ArrowRightLeft className="h-4 w-4" />库存调拨</button>
  </div>;

  return (
    <div className="max-w-[1400px] mx-auto page-transition-enter">
      <header className="flex flex-wrap items-end justify-between gap-4 mb-6">
        <div>
          <h1 className="text-xl font-bold tracking-wide text-ink-deep mb-2">在库清单</h1>
          <p className="text-[13px] text-ink-soft">全部机器档案与完整去向，贯通入库、销售和售后历史</p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-3 text-[13px] text-ink-soft">
          <span>机器档案总数 <b className="font-mono text-[15px] text-ink-deep">{stats.total}</b></span>
          <span title="含普通在库和自定义状态；不含租赁、售后暂存和已出库机器">当前在库 <b className="font-mono text-[15px] text-success">{stats.inStock}</b></span>
          <span>已售 <b className="font-mono text-[15px] text-primary">{stats.sold}</b></span>
          <span>自定义状态 <b className="font-mono text-[15px] text-ink-deep">{stats.custom || 0}</b></span>
          <span>可参与业务 <b className="font-mono text-[15px] text-success">{stats.available ?? stats.inStock}</b></span>
          <span>在库成本 <b className="font-mono text-[15px] text-ink-deep">{formatMoney(stats.inStockCost)}</b></span>
          <Link href="/inventory/analysis" className="btn-ghost inline-flex items-center gap-1.5"><BarChart3 className="h-4 w-4" />库存分析</Link>
        </div>
      </header>

      {workspaceNavigation}

      <WorkspaceSection active={activeWorkspace === 'list'}>
      <section className="glass p-4 mb-4">
        <div className="flex flex-wrap items-center gap-3">
          <form onSubmit={submitSearch} className="relative min-w-0 basis-full xl:max-w-xl xl:flex-1">
            <MachineSearchInput<InventoryItem> value={searchInput} onChange={setSearchInput} endpoint={`/api/inventory/lookup?context=inventory${filters.warehouseId ? `&warehouseId=${encodeURIComponent(filters.warehouseId)}` : ''}`} onSelect={item => { setSearchInput(item.sn); setSearch(item.sn); setPage(1); }} onSearch={query => { setSearchInput(query); setSearch(query.trim()); setPage(1); }} placeholder="SN 后四位、品牌型号、供应商或采购单号" ariaLabel="搜索库存" />
            {searchInput && (
              <button type="button" onClick={clearSearch} title="清除搜索" aria-label="清除搜索" className="absolute right-12 top-1/2 -translate-y-1/2 p-1 text-ink-soft hover:text-ink-deep"><X className="w-4 h-4" /></button>
            )}
            <button type="submit" title="搜索" aria-label="搜索" className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-primary hover:bg-primary/10 rounded-md"><Search className="w-4 h-4" /></button>
          </form>

          <div className="order-last flex w-full items-center gap-1.5 overflow-x-auto pb-0.5" role="tablist" aria-label="库存状态筛选">
            {[
              ['', '全部'],
              ['in_stock', '在库'],
              ['sold', '已售'],
              ['renting', '租赁中'],
              ['returned', '已退货'],
              ...(filterOptions.statusDefinitions || []).map(item => [`custom:${item.id}`, item.name]),
            ].map(([value, label]) => (
              <button key={value || 'all'} type="button" role="tab" aria-selected={status === value} onClick={() => selectStatus(value)} className={`shrink-0 px-3 py-1.5 rounded-full text-[12px] transition-colors ${status === value ? 'bg-primary text-white shadow-sm' : 'text-ink-soft hover:bg-white/70'}`}>{label}</button>
            ))}
          </div>

          {isAdmin && <><button type="button" onClick={() => setStatusDialog({ mode: 'register' })} className="btn-ghost inline-flex items-center gap-1.5"><Wrench className="h-4 w-4" />状态登记</button><button type="button" onClick={() => setStatusDialog({ mode: 'manage' })} className="btn-ghost inline-flex items-center gap-1.5"><Settings2 className="h-4 w-4" />状态管理</button></>}

          <div className="flex items-center gap-1 rounded-lg border border-line/70 bg-white/50 p-1" role="group" aria-label="库存视图">
            <button type="button" onClick={() => setViewMode('table')} aria-pressed={viewMode === 'table'} title="表格视图" className={`rounded-md p-1.5 transition-colors ${viewMode === 'table' ? 'bg-primary text-white' : 'text-ink-soft hover:bg-white'}`}><Table2 className="h-4 w-4" /></button>
            <button type="button" onClick={() => setViewMode('cards')} aria-pressed={viewMode === 'cards'} title="卡片视图" className={`rounded-md p-1.5 transition-colors ${viewMode === 'cards' ? 'bg-primary text-white' : 'text-ink-soft hover:bg-white'}`}><LayoutGrid className="h-4 w-4" /></button>
          </div>
          <button type="button" onClick={() => setFiltersOpen((open) => !open)} aria-expanded={filtersOpen} className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-[12px] transition-colors ${filtersOpen || activeFilterCount > 0 ? 'border-primary/30 bg-primary/10 text-primary' : 'border-line/70 text-ink-soft hover:bg-white/70'}`}><SlidersHorizontal className="h-4 w-4" />组合筛选{activeFilterCount > 0 && <span className="rounded-full bg-primary px-1.5 py-0.5 text-[10px] text-white">{activeFilterCount}</span>}</button>
          <button type="button" onClick={() => { setSearchInput(search); setReloadKey((key) => key + 1); }} disabled={loading} title="刷新库存" aria-label="刷新库存" className="self-end lg:self-auto p-2 text-ink-soft hover:text-primary hover:bg-white/70 rounded-lg transition-colors"><RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /></button>
        </div>
      </section>

      {filtersOpen && (
        <section className="glass mb-4 border border-primary/10 p-4">
          <div className="mb-3 flex items-center justify-between gap-3"><div className="flex items-center gap-2 text-[13px] font-medium text-ink-deep"><Filter className="h-4 w-4 text-primary" />组合筛选</div><span className="text-[11px] text-ink-soft">应用后会回到第 1 页</span></div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="block"><span className="mb-1.5 block text-[11px] text-ink-soft">仓库</span><CustomSelect value={filterDraft.warehouseId} onChange={value => setFilterDraft(current => ({ ...current, warehouseId: value }))} options={[{ value: '', label: '全部授权仓库' }, ...warehouses.map(w => ({ value: w.id, label: w.name }))]} placeholder="全部授权仓库" /></label><FilterSelect label="品牌" value={filterDraft.brand} options={filterOptions.brands} onChange={(value) => setFilterDraft((current) => ({ ...current, brand: value }))} />
            <FilterSelect label="型号" value={filterDraft.model} options={filterOptions.models} onChange={(value) => setFilterDraft((current) => ({ ...current, model: value }))} />
            <label className="block"><span className="mb-1.5 block text-[11px] text-ink-soft">供应商</span><CustomSelect value={filterDraft.supplierId} onChange={(value) => setFilterDraft((current) => ({ ...current, supplierId: value }))} options={[{ value: '', label: '全部供应商' }, ...filterOptions.suppliers.map((supplier) => ({ value: supplier.id, label: supplier.name }))]} placeholder="全部供应商" searchable /></label>
            <label className="block"><span className="mb-1.5 block text-[11px] text-ink-soft">入库日期起</span><input type="date" value={filterDraft.inboundFrom} onChange={(event) => setFilterDraft((current) => ({ ...current, inboundFrom: event.target.value }))} className="field" /></label>
            <label className="block"><span className="mb-1.5 block text-[11px] text-ink-soft">入库日期止</span><input type="date" value={filterDraft.inboundTo} onChange={(event) => setFilterDraft((current) => ({ ...current, inboundTo: event.target.value }))} className="field" /></label>
            <NumberFilter label="采购价最低" value={filterDraft.priceMin} placeholder="例如 1000" onChange={(value) => setFilterDraft((current) => ({ ...current, priceMin: value }))} />
            <NumberFilter label="采购价最高" value={filterDraft.priceMax} placeholder="例如 10000" onChange={(value) => setFilterDraft((current) => ({ ...current, priceMax: value }))} />
            <div className="grid grid-cols-2 gap-2"><NumberFilter label="库龄至少（天）" value={filterDraft.ageMin} placeholder="0" onChange={(value) => setFilterDraft((current) => ({ ...current, ageMin: value }))} /><NumberFilter label="库龄最多（天）" value={filterDraft.ageMax} placeholder="365" onChange={(value) => setFilterDraft((current) => ({ ...current, ageMax: value }))} /></div>
          </div>
          <div className="mt-4 flex flex-wrap items-center justify-end gap-2"><button type="button" onClick={resetFilters} className="btn-ghost">清空条件</button><button type="button" onClick={applyFilters} className="btn-primary inline-flex items-center gap-1.5"><Check className="h-4 w-4" />应用筛选</button></div>
        </section>
      )}

      {error && (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-danger/20 bg-danger/5 px-4 py-3 text-[13px] text-danger">
          <span>{error}</span>
          <button type="button" onClick={() => setError('')} title="关闭提示" aria-label="关闭提示" className="p-1 hover:bg-danger/10 rounded-md"><X className="w-4 h-4" /></button>
        </div>
      )}

      {checkedItems.length > 0 && (
        <section className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-primary/15 bg-primary/5 px-4 py-3">
          <div className="flex items-center gap-2 text-[12px] text-ink-deep"><CheckSquare className="h-4 w-4 text-primary" />已选 <b>{checkedItems.length}</b> 台机器</div>
          <div className="flex flex-wrap items-center gap-2">{isAdmin && checkedItems.length === 1 && checkedItems[0].status === 'in_stock' && <button type="button" onClick={() => setAssetChangeMachine(checkedItems[0])} className="btn-ghost inline-flex items-center gap-1.5"><MemoryStick className="h-4 w-4" />资产变更</button>}<button type="button" onClick={openPrintSelected} className="btn-ghost inline-flex items-center gap-1.5"><Printer className="h-4 w-4" />打印所选标签</button><button type="button" onClick={exportSelected} className="btn-ghost inline-flex items-center gap-1.5"><FileDown className="h-4 w-4" />导出所选</button><button type="button" onClick={() => setCheckedIds(new Set())} className="text-[12px] text-ink-soft hover:text-ink-deep">清除选择</button></div>
        </section>
      )}

      <section className="glass overflow-hidden">
        {loading && items.length === 0 ? (
          <div className="p-12 text-center text-[13px] text-ink-soft">加载中...</div>
        ) : items.length === 0 ? (
          <div className="p-12 text-center">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-primary-alpha-12 mb-4"><PackageOpen className="w-8 h-8 text-primary" /></div>
            <p className="text-ink-soft text-[13px]">{search || status || activeFilterCount > 0 ? '没有匹配的库存记录' : '暂无库存记录'}</p>
          </div>
        ) : viewMode === 'table' ? (
          <div className="overflow-x-auto">
            <table className="w-full data-table min-w-[1100px]">
              <thead><tr><th className="w-10"><input type="checkbox" checked={allPageChecked} onChange={togglePageChecked} aria-label="选择当前页全部机器" /></th><th>机器信息</th><th>配置</th><th>SN / IMEI</th><th>供应商 / 采购单</th><th>采购价</th><th>状态 / 当前去向</th><th>入库日期</th><th className="text-right">操作</th></tr></thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id} onClick={() => openDetails(item)} className="cursor-pointer">
                    <td onClick={(event) => event.stopPropagation()}><input type="checkbox" checked={checkedIds.has(item.id)} onChange={() => toggleChecked(item.id)} aria-label={`选择 ${item.sn}`} /></td>
                    <td><div className="font-medium text-ink-deep">{productName(item)}</div><div className="text-[11px] text-ink-soft mt-1">{item.productType || '未分类'}</div></td>
                    <td><div className="text-[12px] text-ink">{[formatCPUDisplay(item.cpu), item.ram, item.storage].filter(Boolean).join(' · ') || '-'}</div><div className="text-[11px] text-ink-soft mt-1">{[formatGPUDisplay(item.gpu), formatScreenDisplay(item.screen), item.touchScreen ? '触屏' : ''].filter(Boolean).join(' · ') || '配置未补充'}</div></td>
                    <td><span className="font-mono text-[12px] text-ink-deep break-all">{item.sn}</span></td>
                    <td><div className="text-[12px] text-ink">{item.supplierName || '-'}</div><div className="font-mono text-[11px] text-ink-soft mt-1">{item.purchaseNo || '-'}</div><div className="mt-1 text-[11px] text-primary">{item.warehouseName || warehouses.find(w => w.id === item.warehouseId)?.name || '未分仓'}</div></td>
                    <td className="font-mono text-[13px] text-ink-deep">{formatMoney(item.purchasePrice)}</td>
                    <td><span className={statusClass(item.status)} style={itemStatusStyle(item)}><span className="status-dot" />{itemStatusLabel(item)}</span><div className="mt-1.5 max-w-52 text-[11px] text-ink-soft">{machineDestination(item)}</div></td>
                    <td><div className="text-[12px] text-ink">{formatDate(item.inboundDate)}</div><div className={`text-[11px] mt-1 ${item.inboundDays > 30 ? 'text-danger' : item.inboundDays > 7 ? 'text-warning' : 'text-ink-soft'}`}>{['in_stock', 'custom'].includes(item.status) ? '在库' : '入库距今'} {Math.max(0, Number(item.inboundDays || 0))} 天</div></td>
                    <td className="text-right"><button type="button" onClick={(event) => { event.stopPropagation(); openDetails(item); }} title="查看详情并编辑备注" aria-label={`查看 ${item.sn} 详情`} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[12px] text-primary hover:bg-primary/10 rounded-lg transition-colors"><Eye className="w-3.5 h-3.5" />详情</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 p-4 md:grid-cols-2 xl:grid-cols-3">
            {items.map((item) => (
              <article key={item.id} className="rounded-xl border border-line/70 bg-white/60 p-4 transition-shadow hover:shadow-md">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="truncate text-[15px] font-semibold text-ink-deep">{productName(item)}</h3>
                    <p className="mt-1 text-[11px] text-ink-soft">{item.productType || '未分类'}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2"><input type="checkbox" checked={checkedIds.has(item.id)} onChange={() => toggleChecked(item.id)} aria-label={`选择 ${item.sn}`} /><span className={statusClass(item.status)} style={itemStatusStyle(item)}><span className="status-dot" />{itemStatusLabel(item)}</span></div>
                </div>
                <p className="mt-3 text-xs text-ink-soft">{machineDestination(item)}</p><div className="mt-4 space-y-2 text-[12px]">
                  <div className="flex items-center justify-between gap-3"><span className="text-ink-soft">配置</span><span className="truncate text-right text-ink-deep">{[formatCPUDisplay(item.cpu), item.ram, item.storage].filter(Boolean).join(' · ') || '-'}</span></div>
                  <div className="flex items-center justify-between gap-3"><span className="text-ink-soft">SN / IMEI</span><span className="truncate font-mono text-right text-ink-deep">{item.sn}</span></div>
                  <div className="flex items-center justify-between gap-3"><span className="text-ink-soft">供应商</span><span className="truncate text-right text-ink-deep">{item.supplierName || '-'}</span></div>
                  <div className="flex items-center justify-between gap-3"><span className="text-ink-soft">采购价</span><span className="font-mono font-semibold text-ink-deep">{formatMoney(item.purchasePrice)}</span></div>
                  <div className="flex items-center justify-between gap-3"><span className="text-ink-soft">入库日期</span><span className="text-ink-deep">{formatDate(item.inboundDate)}</span></div>
                </div>
                <div className="mt-4 flex items-center justify-end border-t border-line/60 pt-3"><button type="button" onClick={() => openDetails(item)} className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] text-primary transition-colors hover:bg-primary/10"><Eye className="h-3.5 w-3.5" />详情</button></div>
              </article>
            ))}
          </div>
        )}

        {items.length > 0 && (
          <footer className="flex items-center justify-between gap-3 border-t border-line/60 px-4 py-3 text-[12px] text-ink-soft">
            <span>共 {total} 条记录</span>
            <div className="flex items-center gap-2"><button type="button" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={page <= 1 || loading} title="上一页" aria-label="上一页" className="p-1.5 hover:bg-white/70 rounded-md"><ChevronLeft className="w-4 h-4" /></button><span className="min-w-[76px] text-center">第 {page} / {totalPages} 页</span><button type="button" onClick={() => setPage((current) => Math.min(totalPages, current + 1))} disabled={page >= totalPages || loading} title="下一页" aria-label="下一页" className="p-1.5 hover:bg-white/70 rounded-md"><ChevronRight className="w-4 h-4" /></button></div>
          </footer>
        )}
      </section>

      {selected && active && (
        <div className="fixed inset-x-0 bottom-0 top-[100px] z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="库存详情">
          <button type="button" onClick={closeDetails} className="absolute inset-0 bg-ink-deep/20 backdrop-blur-[2px]" aria-label="关闭详情" />
          <aside className="drawer-panel relative z-10 flex h-full w-full max-w-[480px] flex-col bg-paper/95 backdrop-blur-xl shadow-2xl">
            <header className="flex items-start justify-between border-b border-line px-5 py-4"><div><div className="flex items-center gap-2"><h2 className="text-base font-semibold text-ink-deep">库存详情</h2><span className={statusClass(selected.status)} style={itemStatusStyle(selected)}>{itemStatusLabel(selected)}</span></div><p className="mt-1 font-mono text-[12px] text-ink-soft">{selected.sn}</p></div><button type="button" onClick={closeDetails} title="关闭" aria-label="关闭" className="p-2 text-ink-soft hover:bg-white/70 rounded-lg"><X className="w-4 h-4" /></button></header>

            <div className="flex-1 overflow-y-auto p-5">
              <div className="mb-5 rounded-xl border border-line/70 bg-white/45 p-4"><div className="mb-3 flex items-center gap-2 text-[13px] font-medium text-ink-deep"><Pencil className="w-4 h-4 text-primary" />{productName(selected)}</div><dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-[12px]"><DetailField label="所在仓库" value={selected.warehouseName || warehouses.find(w => w.id === selected.warehouseId)?.name} /><DetailField label="产品类型" value={selected.productType} /><DetailField label="品牌型号" value={productName(selected)} /><DetailField label="采购价格" value={formatMoney(selected.purchasePrice)} /><DetailField label="CPU" value={formatCPUDisplay(selected.cpu)} /><DetailField label="内存" value={selected.ram} /><DetailField label="显卡" value={formatGPUDisplay(selected.gpu)} /><DetailField label="硬盘" value={selected.storage} /><DetailField label="屏幕" value={formatScreenDisplay(selected.screen)} /><DetailField label="触屏" value={selected.touchScreen === null ? '未填写' : selected.touchScreen ? '是' : '否'} /><DetailField label="供应商" value={selected.supplierName} /><DetailField label="采购单号" value={selected.purchaseNo} /><DetailField label="入库日期" value={formatDate(selected.inboundDate)} /><DetailField label={selected.status === 'in_stock' || selected.status === 'custom' ? '在库天数' : '入库距今'} value={`${Math.max(0, Number(selected.inboundDays || 0))} 天`} />{selected.soldDate && <DetailField label="售出日期" value={formatDate(selected.soldDate)} />}{selected.sellingPrice !== null && <DetailField label="销售价格" value={formatMoney(selected.sellingPrice)} />}</dl></div>
              <section className="mb-5 rounded-xl border border-primary/15 bg-primary/5 p-4"><p className="text-xs text-ink-soft">当前去向</p><p className="mt-2 text-sm text-ink-deep">{machineDestination(selected)}</p>{selected.afterSaleId && isAdmin && <Link href={`/after-sales?recordId=${encodeURIComponent(selected.afterSaleId)}`} className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium text-primary">查看关联售后单 {selected.afterSaleNo}</Link>}{isAdmin && <Link href={`/sales/records?search=${encodeURIComponent(selected.sn)}`} className="mt-3 flex text-xs font-medium text-primary">查询本机销售历史</Link>}</section>{selected.statusRecord && <section className="mb-5 rounded-xl border border-line/70 bg-white/60 p-4"><h3 className="mb-3 text-sm font-medium">当前状态登记</h3><dl className="grid grid-cols-2 gap-3 text-xs"><DetailField label="原因" value={selected.statusRecord.reason} /><DetailField label="当前地点" value={selected.statusRecord.location} /><DetailField label="负责人" value={selected.statusRecord.responsiblePerson} /><DetailField label="预计归还" value={formatDate(selected.statusRecord.expectedReturnDate)} /><DetailField label="登记时间" value={formatDate(selected.statusRecord.createdAt || selected.statusRecord.startedAt)} /><DetailField label="业务权限" value={selected.allowStockOperations ? '允许参与在库业务' : '暂停参与在库业务'} /></dl>{selected.statusRecord.remark && <p className="mt-3 whitespace-pre-wrap text-xs text-ink-soft">{selected.statusRecord.remark}</p>}</section>}
              {isAdmin && (selected.status === 'in_stock' || selected.status === 'custom') && <div className="mb-4 flex flex-wrap gap-2">{selected.status === 'in_stock' && <button type="button" className="btn-ghost inline-flex items-center gap-1.5" onClick={() => setAssetChangeMachine(selected)}><MemoryStick className="h-4 w-4" />资产变更</button>}<button type="button" className="btn-ghost inline-flex items-center gap-1.5" onClick={() => setStatusDialog({ mode: selected.status === 'custom' ? 'restore' : 'register', machine: selected })}><Wrench className="h-4 w-4" />{selected.status === 'custom' ? '恢复在库' : '登记机器状态'}</button>{isSystemAccount && selected.status === 'in_stock' && <button type="button" className="inline-flex items-center gap-1.5 rounded-lg border border-danger/20 px-3 py-2 text-xs text-danger transition hover:bg-danger/5" onClick={() => setPurgeMachine(selected)}><Trash2 className="h-4 w-4" />永久删除</button>}</div>}
              <label htmlFor="inventory-remark" className="mb-2 block text-[13px] font-medium text-ink-deep">备注</label><textarea id="inventory-remark" value={remark} onChange={(event) => setRemark(event.target.value)} rows={5} placeholder="添加库存备注" disabled={!isAdmin} className="field resize-y" />
              {remarkError && <p role="alert" className="mt-2 text-[12px] text-danger">{remarkError}</p>}
              <InventoryMovementTimeline key={`${selected.id}:${movementRevision}`} inventoryId={selected.id} onViewAll={() => selectWorkspace('movements', selected.sn)} />{selected.skuRemark && <div className="mt-4 rounded-lg bg-primary/5 px-3 py-2 text-[12px] text-ink-soft">SKU 补充信息：{selected.skuRemark}</div>}
            </div>

            <footer className="flex items-center justify-end gap-3 border-t border-line px-5 py-4">{saved && <span className="mr-auto inline-flex items-center gap-1 text-[12px] text-success"><Check className="w-3.5 h-3.5" />已保存</span>}<button type="button" onClick={closeDetails} disabled={savingRemark} className="btn-ghost">关闭</button><button type="button" onClick={saveRemark} disabled={savingRemark || !isAdmin} className="btn-primary inline-flex items-center gap-1.5"><Save className="w-4 h-4" />{savingRemark ? '保存中...' : '保存备注'}</button></footer>
          </aside>
        </div>
      )}
      {assetChangeMachine && <InventoryAssetChangeDialog key={assetChangeMachine.id} machine={assetChangeMachine} onClose={() => setAssetChangeMachine(null)} onSaved={assetChanged} />}
      {statusDialog && <InventoryStatusDialog key={`${statusDialog.mode}:${statusDialog.machine?.id || 'new'}`} mode={statusDialog.mode} machine={statusDialog.machine} onClose={() => setStatusDialog(null)} onChanged={statusChanged} />}
      {purgeMachine && <InventoryPurgeDialog key={purgeMachine.id} machine={purgeMachine} onClose={() => setPurgeMachine(null)} onDeleted={() => { setPurgeMachine(null); setSelected(null); setCheckedIds(current => { const next = new Set(current); next.delete(purgeMachine.id); return next; }); setReloadKey(current => current + 1); }} />}
      </WorkspaceSection>
      <WorkspaceSection active={activeWorkspace === 'movements'}><InventoryMovementsWorkspace initialSearch={movementSearch} /></WorkspaceSection>
      <WorkspaceSection active={activeWorkspace === 'transfers'}><TransfersWorkspace /></WorkspaceSection>
    </div>
  );
}

function DetailField({ label, value }: { label: string; value: string | null | undefined }) {
  return <div className="min-w-0"><dt className="text-ink-soft">{label}</dt><dd className="mt-0.5 truncate text-ink-deep">{value || '-'}</dd></div>;
}

function InventoryAssetChangeDialog({ machine, onClose, onSaved }: {
  machine: InventoryItem;
  onClose: () => void;
  onSaved: (machine: InventoryItem, ram: string, storage: string) => void;
}) {
  const [ram, setRam] = useState(machine.ram);
  const [storage, setStorage] = useState(machine.storage);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const changed = ram.trim() !== machine.ram || storage.trim() !== machine.storage;
  useWorkspaceDirty(changed);

  const requestClose = () => {
    if (busy) return;
    if (changed) setConfirmDiscard(true);
    else onClose();
  };

  const submit = async () => {
    const nextRam = ram.trim();
    const nextStorage = storage.trim();
    if (!nextRam || !nextStorage) { setError('内存和硬盘容量不能为空'); return; }
    if (nextRam.length > 64 || nextStorage.length > 64 || /[\u0000-\u001f\u007f]/.test(nextRam + nextStorage)) {
      setError('容量最多 64 个字符，且不能包含换行或控制字符');
      return;
    }
    if (!changed) { setError('请先修改内存或硬盘容量'); return; }
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/inventory/asset-change', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inventoryId: machine.id,
          expectedRam: machine.ram,
          expectedStorage: machine.storage,
          ...(nextRam !== machine.ram ? { ram: nextRam } : {}),
          ...(nextStorage !== machine.storage ? { storage: nextStorage } : {}),
        }),
      });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error?.message || '资产变更失败，请重试');
      onSaved(machine, result.data?.ram ?? nextRam, result.data?.storage ?? nextStorage);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '资产变更失败，请重试');
    } finally {
      setBusy(false);
    }
  };

  return <>
    <BusinessDialog title="资产变更" description={`仅变更 SN ${machine.sn} 的单台机器配置`} onClose={requestClose} footer={<>
      <button type="button" onClick={requestClose} disabled={busy} className="btn-ghost">取消</button>
      <button type="button" onClick={() => void submit()} disabled={busy || !changed} className="btn-primary inline-flex items-center gap-1.5"><Save className="h-4 w-4" />{busy ? '保存中...' : '确认变更'}</button>
    </>}>
      <div className="mb-4 rounded-xl border border-primary/15 bg-primary/5 p-3 text-sm text-ink-deep">
        <p className="font-medium">{productName(machine)}</p>
        <p className="mt-1 font-mono text-xs text-ink-soft">SN {machine.sn}</p>
        <p className="mt-2 text-xs text-ink-soft">仅更新当前机器的内存与硬盘。采购成本和公共 SKU 选项保持不变，变更将写入机器生命周期。</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block text-xs font-medium text-ink-deep">内存大小
          <span className="mt-1 block font-normal text-ink-soft">原配置：{machine.ram || '-'}</span>
          <input type="text" value={ram} onChange={event => { setRam(event.target.value); setError(''); }} maxLength={64} autoComplete="off" placeholder="例如 16GB" className="field mt-2" />
        </label>
        <label className="block text-xs font-medium text-ink-deep">硬盘大小
          <span className="mt-1 block font-normal text-ink-soft">原配置：{machine.storage || '-'}</span>
          <input type="text" value={storage} onChange={event => { setStorage(event.target.value); setError(''); }} maxLength={64} autoComplete="off" placeholder="例如 512GB SSD" className="field mt-2" />
        </label>
      </div>
      {error && <p role="alert" className="mt-4 rounded-lg border border-danger/20 bg-danger/5 p-3 text-xs text-danger">{error}</p>}
    </BusinessDialog>
    <ConfirmDialog isOpen={confirmDiscard} title="放弃资产变更？" message="关闭后，本次未保存的内存和硬盘修改将被清除。" confirmText="关闭并放弃" cancelText="继续编辑" onCancel={() => setConfirmDiscard(false)} onConfirm={onClose} />
  </>;
}

function machineDestination(item: InventoryItem) {
  if (item.status === 'after_sale') return item.afterSaleStockStatus === 'stored' ? '售后暂存 · 不计入正式库存' : '售后处理中 · 待收机或处理';
  if (item.status === 'sold') return item.saleChannel ? `已交付 · ${item.saleChannel}` : '已销售出库';
  if (item.status === 'renting') return '租赁出库 · 待归还';
  if (item.status === 'returning') return `供应商退货办理中 · ${item.supplierName || '原供应商'}`;
  if (item.status === 'returned') return `已退回 · ${item.supplierName || '原供应商'}`;
  if (item.status === 'custom') return item.statusRecord?.location || '已登记自定义状态';
  return item.warehouseName || '原归属仓库';
}

function FilterSelect({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (value: string) => void }) {
  return <label className="block"><span className="mb-1.5 block text-[11px] text-ink-soft">{label}</span><CustomSelect value={value} onChange={onChange} options={[{ value: '', label: `全部${label}` }, ...options.map((option) => ({ value: option, label: option }))]} placeholder={`全部${label}`} searchable /></label>;
}

function NumberFilter({ label, value, placeholder, onChange }: { label: string; value: string; placeholder: string; onChange: (value: string) => void }) {
  return <label className="block"><span className="mb-1.5 block text-[11px] text-ink-soft">{label}</span><input type="number" min="0" value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} className="field" /></label>;
}

