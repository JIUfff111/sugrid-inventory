/**
 * 在库清单
 * 查看已入库机器，支持按状态、SN、型号和供应商筛选，并编辑库存备注。
 */
'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type CSSProperties, FormEvent, type KeyboardEvent, type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from 'react';
import CustomSelect from '@/components/CustomSelect';
import BusinessDialog from '@/components/BusinessDialog';
import ConfirmDialog from '@/components/ConfirmDialog';
import MachineSearchInput from '@/components/MachineSearchInput';
import InventoryStatusDialog, { type InventoryStatusDefinition, type InventoryStatusRecord } from '@/components/InventoryStatusDialog';
import { WorkspaceSection, useWorkspace, useWorkspaceDirty } from '@/components/WorkspaceContext';
import InventoryMovementTimeline from '@/components/InventoryMovementTimeline';
import InventoryPurgeDialog from '@/components/InventoryPurgeDialog';
import { useInventoryLabelPrinter } from '@/components/InventoryLabelPrint';
import CopyTextButton from '@/components/CopyTextButton';
import InventoryColumnSettingsDialog from '@/components/InventoryColumnSettingsDialog';
import { formatProductName } from '@/lib/product-name';
import { formatCPUDisplay, formatGPUDisplay, formatScreenDisplay, SKU_PRODUCT_TYPES } from '@/lib/sku-display';
import { uniqueMachineScanTokens } from '@/lib/machine-scan';
import {
  defaultPinnedInventoryStatusIds,
  inventoryStatusPreferenceStorageKey,
  normalizePinnedInventoryStatusIds,
  readPinnedInventoryStatusIds,
} from '@/lib/inventory-status-preferences';
import {
  createDefaultInventoryTablePreferences,
  clampInventoryTableColumnWidth,
  getInventoryTableFrozenOffsets,
  legacyInventoryTablePreferenceStorageKey,
  olderLegacyInventoryTablePreferenceStorageKey,
  INVENTORY_TABLE_COLUMN_DEFINITIONS,
  INVENTORY_TABLE_COLUMN_MAX_WIDTH,
  INVENTORY_TABLE_COLUMN_MIN_WIDTH,
  inventoryTablePreferenceStorageKey,
  migrateCurrentInventoryTablePreferences,
  migrateLegacyInventoryTablePreferences,
  migrateStoredInventoryTablePreferences,
  normalizeInventoryTablePreferences,
  setInventoryTableColumnWidth,
  type InventoryTableColumnKey,
  type InventoryTablePreferences,
} from '@/lib/inventory-table-preferences';
import { TransfersWorkspace } from '@/app/transfers/page';
import {
  ArrowRightLeft,
  BarChart3,
  Check,
  CheckSquare,
  Columns3,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Eye,
  FileDown,
  Filter,
  History,
  LayoutGrid,
  MemoryStick,
  PackageOpen,
  Pencil,
  Pin,
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
  itemNumber: string | null;
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

type InventoryEditDraft = {
  sn: string;
  itemNumber: string;
  productType: string;
  brand: string;
  model: string;
  year: string;
  cpu: string;
  ram: string;
  gpu: string;
  storage: string;
  screen: string;
  touchScreen: string;
  purchasePrice: string;
};

type InventoryEditHistoryEntry = {
  id: string;
  createdAt: string;
  actorName?: string | null;
  beforeData: Record<string, unknown>;
  afterData: Record<string, unknown>;
};

const inventoryEditFields: Array<[keyof InventoryEditDraft, string, string]> = [
  ['sn', 'SN / IMEI', '请输入机器序列号'],
  ['itemNumber', '编号', '选填；填写后全库唯一'],
  ['productType', '产品类型', '如：笔记本电脑'],
  ['brand', '品牌', '请输入品牌'],
  ['model', '型号', '请输入型号'],
  ['year', '型号年份', '可选'],
  ['cpu', 'CPU', '自定义输入'],
  ['ram', '内存', '自定义输入'],
  ['gpu', '显卡', '自定义输入'],
  ['storage', '硬盘', '自定义输入'],
  ['screen', '屏幕信息', '自定义输入，例如 1k、2.5K'],
  ['purchasePrice', '采购价格', '请输入单台机器采购价'],
];

function inventoryEditDraftFrom(item: InventoryItem): InventoryEditDraft {
  return {
    sn: item.sn || '',
    itemNumber: item.itemNumber || '',
    productType: item.productType || '',
    brand: item.brand || '',
    model: item.model || '',
    year: item.year == null ? '' : String(item.year),
    cpu: item.cpu || '',
    ram: item.ram || '',
    gpu: item.gpu || '',
    storage: item.storage || '',
    screen: item.screen || '',
    touchScreen: item.touchScreen == null ? '' : String(item.touchScreen),
    purchasePrice: String(item.purchasePrice ?? ''),
  };
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
  inboundFrom: string;
  inboundTo: string;
  productType: string;
  cpu: string;
  ram: string;
  storage: string;
  gpu: string;
  screen: string;
  snContains: string;
  itemNumberContains: string;
  remarks: string;
  touchScreen: string;
}

type ExtraInventoryFilterKey = Exclude<keyof InventoryFilters, 'warehouseId' | 'brand' | 'model' | 'inboundFrom' | 'inboundTo'>;

const EXTRA_INVENTORY_FILTERS: ReadonlyArray<{ key: ExtraInventoryFilterKey; label: string; placeholder: string }> = [
  { key: 'productType', label: '产品类型', placeholder: '输入产品类型' },
  { key: 'cpu', label: 'CPU', placeholder: '输入 CPU 配置' },
  { key: 'ram', label: '内存', placeholder: '输入内存配置' },
  { key: 'storage', label: '硬盘', placeholder: '输入硬盘配置' },
  { key: 'gpu', label: '显卡', placeholder: '输入显卡配置' },
  { key: 'screen', label: '屏幕', placeholder: '输入屏幕规格' },
  { key: 'snContains', label: 'SN / IMEI', placeholder: '输入完整或部分序列号' },
  { key: 'itemNumberContains', label: '编号', placeholder: '输入完整或部分编号' },
  { key: 'remarks', label: '备注', placeholder: '搜索机器备注或 SKU 备注' },
  { key: 'touchScreen', label: '触屏', placeholder: '' },
];

interface FilterOptions {
  brands: string[];
  editBrands?: string[];
  models: string[];
  statusDefinitions?: InventoryStatusDefinition[];
}

interface InventoryStatusPinPreference {
  userId: string;
  stored: string | null;
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
  inboundFrom: '',
  inboundTo: '',
  productType: '',
  cpu: '',
  ram: '',
  storage: '',
  gpu: '',
  screen: '',
  snContains: '',
  itemNumberContains: '',
  remarks: '',
  touchScreen: '',
};

const EMPTY_FILTER_OPTIONS: FilterOptions = { brands: [], models: [] };

function buildInventoryQueryParams(input: {
  page: number;
  pageSize: number;
  search: string;
  configSearch: string;
  status: string;
  filters: InventoryFilters;
  serials: string[];
  paginate?: boolean;
}) {
  const params = new URLSearchParams();
  if (input.paginate !== false) {
    params.set('page', String(input.page));
    params.set('pageSize', String(input.pageSize));
  }
  if (input.serials.length) input.serials.forEach(serial => params.append('sn', serial));
  else if (input.search) {
    params.set('search', input.search);
    params.set('searchMode', 'machine');
  }
  if (input.configSearch) params.set('configSearch', input.configSearch);
  if (input.status.startsWith('custom:')) {
    params.set('status', 'custom');
    params.set('customStatusId', input.status.slice(7));
  } else if (input.status) params.set('status', input.status);
  Object.entries(input.filters).forEach(([key, value]) => {
    if (value) params.set(key, value);
  });
  return params;
}

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
  const isViewer = user?.role === 'viewer';
  const { printLabels, printing, printPortal } = useInventoryLabelPrinter();
  const [activeWorkspace, setActiveWorkspace] = useState<'list' | 'transfers'>('list');
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [stats, setStats] = useState<InventoryStats>(EMPTY_STATS);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [pageJump, setPageJump] = useState('1');
  const [totalPages, setTotalPages] = useState(1);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [configSearchInput, setConfigSearchInput] = useState('');
  const [configSearch, setConfigSearch] = useState('');
  const serialSearchTokens = useRef<string[]>([]);
  const [serialSearchList, setSerialSearchList] = useState<string[]>([]);
  const [status, setStatus] = useState('current_stock');
  const [filters, setFilters] = useState<InventoryFilters>(EMPTY_FILTERS);
  const [filterDraft, setFilterDraft] = useState<InventoryFilters>(EMPTY_FILTERS);
  const [filterOptions, setFilterOptions] = useState<FilterOptions>(EMPTY_FILTER_OPTIONS);
  const [statusPinPreference, setStatusPinPreference] = useState<InventoryStatusPinPreference>({ userId: '', stored: null });
  const [statusOptionsLoaded, setStatusOptionsLoaded] = useState(false);
  const [statusMenuOpen, setStatusMenuOpen] = useState(false);
  const [statusMenuSearch, setStatusMenuSearch] = useState('');
  const statusMenuRef = useRef<HTMLDivElement>(null);
  const [filterModelsLoading, setFilterModelsLoading] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<InventoryItem | null>(null);
  const [remark, setRemark] = useState('');
  const [machineEditDraft, setMachineEditDraft] = useState<InventoryEditDraft | null>(null);
  const [machineEditOpen, setMachineEditOpen] = useState(false);
  const [savingMachineEdit, setSavingMachineEdit] = useState(false);
  const [machineEditError, setMachineEditError] = useState('');
  const [machineEditDiscardConfirm, setMachineEditDiscardConfirm] = useState(false);
  const [machineEditHistory, setMachineEditHistory] = useState<InventoryEditHistoryEntry[]>([]);
  const [machineEditHistoryError, setMachineEditHistoryError] = useState('');
  const [machineEditHistoryLoading, setMachineEditHistoryLoading] = useState(false);
  const [savingRemark, setSavingRemark] = useState(false);
  const [saved, setSaved] = useState(false);
  const [remarkError, setRemarkError] = useState('');
  const [viewMode, setViewMode] = useState<'table' | 'cards'>('table');
  const [viewHydrated, setViewHydrated] = useState(false);
  const [tableColumnFreezingEnabled, setTableColumnFreezingEnabled] = useState(false);
  const [tablePreferences, setTablePreferences] = useState<InventoryTablePreferences>(createDefaultInventoryTablePreferences);
  const [tablePreferencesHydrated, setTablePreferencesHydrated] = useState(false);
  const [tableSettingsOpen, setTableSettingsOpen] = useState(false);
  const [columnResizePreview, setColumnResizePreview] = useState<{ key: InventoryTableColumnKey; width: number } | null>(null);
  const columnResizeSession = useRef<{ key: InventoryTableColumnKey; pointerId: number; startX: number; startWidth: number; currentWidth: number } | null>(null);
  const [warehouses, setWarehouses] = useState<Array<{ id: string; name: string }>>([]);
  const [isAdmin, setIsAdmin] = useState(false);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(() => new Set());
  const [checkedMachines, setCheckedMachines] = useState<Map<string, InventoryItem>>(() => new Map());
  const [extraFilterKeys, setExtraFilterKeys] = useState<ExtraInventoryFilterKey[]>([]);
  const [newFilterKey, setNewFilterKey] = useState<ExtraInventoryFilterKey | ''>('');
  const [exportOpen, setExportOpen] = useState(false);
  const [exportMode, setExportMode] = useState<'filtered' | 'selected'>('filtered');
  const [exportColumns, setExportColumns] = useState<InventoryTableColumnKey[]>([]);
  const [exportPreviewCount, setExportPreviewCount] = useState<number | null>(null);
  const [exportPreviewLoading, setExportPreviewLoading] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportError, setExportError] = useState('');
  const [statusDialog, setStatusDialog] = useState<{ mode: 'register' | 'restore' | 'manage'; machine?: InventoryItem; machines?: InventoryItem[] } | null>(null);
  const [assetChangeMachine, setAssetChangeMachine] = useState<InventoryItem | null>(null);
  const [pendingAssetPrintId, setPendingAssetPrintId] = useState<string | null>(null);
  const [assetPrintBusy, setAssetPrintBusy] = useState(false);
  const [assetPrintError, setAssetPrintError] = useState('');
  const [purgeMachine, setPurgeMachine] = useState<InventoryItem | null>(null);
  const [movementRevision, setMovementRevision] = useState(0);
  const machineEditDirty = Boolean(selected && machineEditDraft && JSON.stringify(machineEditDraft) !== JSON.stringify(inventoryEditDraftFrom(selected)));
  const machineEditBrandOptions = [...new Set([...(filterOptions.editBrands || filterOptions.brands), machineEditDraft?.brand || ''].filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const machineEditProductTypeOptions = [...new Set([...SKU_PRODUCT_TYPES, machineEditDraft?.productType || ''].filter(Boolean))];
  const currentExportQuery = buildInventoryQueryParams({ page, pageSize, search, configSearch, status, filters, serials: serialSearchList, paginate: false }).toString();
  const currentExportIds = JSON.stringify([...checkedMachines.keys()]);
  const exportColumnsKey = exportColumns.join(',');
  const statusDefinitions = filterOptions.statusDefinitions || [];
  const statusPinRaw = statusPinPreference.userId === user?.id ? statusPinPreference.stored : null;
  const pinnedStatusIds = statusPinPreference.userId === user?.id
    ? readPinnedInventoryStatusIds(statusPinRaw, statusDefinitions)
    : defaultPinnedInventoryStatusIds(statusDefinitions);
  const activeStatusDefinitions = statusDefinitions.filter(item => item.isActive === true || item.isActive === 1);
  const pinnedStatusDefinitions = activeStatusDefinitions.filter(item => pinnedStatusIds.includes(item.id));
  const otherStatusDefinitions = statusDefinitions.filter(item => !pinnedStatusIds.includes(item.id)
    && ((item.isActive === true || item.isActive === 1) || Number(item.machineCount || 0) > 0));
  const selectedCustomStatus = statusDefinitions.find(item => status === `custom:${item.id}`);
  const filteredOtherStatusDefinitions = otherStatusDefinitions.filter(item => item.name.toLocaleLowerCase().includes(statusMenuSearch.trim().toLocaleLowerCase()));
  useEffect(() => { setPageJump(String(page)); }, [page]);
  const applyPageJump = () => {
    const requested = Number.parseInt(pageJump, 10);
    if (!Number.isFinite(requested)) { setPageJump(String(page)); return; }
    setPage(Math.min(totalPages, Math.max(1, requested)));
  };
  useWorkspaceDirty(Boolean((selected && remark !== (selected.remark || '')) || (machineEditOpen && machineEditDirty)));

  useEffect(() => {
    const view = searchParams.get('view');
    if (isViewer && view === 'transfers') {
      setActiveWorkspace('list');
      router.replace('/inventory', { scroll: false });
      return;
    }
    setActiveWorkspace(view === 'transfers' ? 'transfers' : 'list');
    if (view === 'movements') router.replace('/inventory', { scroll: false });
  }, [isViewer, router, searchParams]);

  const selectWorkspace = (workspace: 'list' | 'transfers') => {
    if (isViewer && workspace === 'transfers') return;
    setActiveWorkspace(workspace);
    if (workspace !== 'list') setSelected(null);
    const params = new URLSearchParams();
    if (workspace !== 'list') params.set('view', workspace);
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
    if (!user?.id) {
      setTablePreferencesHydrated(false);
      setStatusPinPreference({ userId: '', stored: null });
      return;
    }
    const key = inventoryTablePreferenceStorageKey(user.id);
    setTablePreferencesHydrated(false);
    let preferences = createDefaultInventoryTablePreferences();
    try {
      const stored = window.localStorage.getItem(key);
      if (stored) {
        preferences = migrateCurrentInventoryTablePreferences(JSON.parse(stored));
        window.localStorage.setItem(key, JSON.stringify(preferences));
      } else {
        const legacy = window.localStorage.getItem(legacyInventoryTablePreferenceStorageKey(user.id));
        const olderLegacy = window.localStorage.getItem(olderLegacyInventoryTablePreferenceStorageKey(user.id));
        if (legacy) preferences = migrateCurrentInventoryTablePreferences(migrateStoredInventoryTablePreferences(JSON.parse(legacy)));
        else if (olderLegacy) preferences = migrateLegacyInventoryTablePreferences(JSON.parse(olderLegacy));
        try { window.localStorage.setItem(key, JSON.stringify(preferences)); } catch {}
      }
    } catch {
      preferences = createDefaultInventoryTablePreferences();
    }
    setTablePreferences(preferences);
    setTablePreferencesHydrated(true);
  }, [user?.id]);

  useEffect(() => {
    if (!user?.id || statusPinPreference.userId === user.id) return;
    let stored: string | null = null;
    try { stored = window.localStorage.getItem(inventoryStatusPreferenceStorageKey(user.id)); } catch {}
    setStatusPinPreference({ userId: user.id, stored });
  }, [user?.id, statusPinPreference.userId]);

  useEffect(() => {
    if (!user?.id || !statusOptionsLoaded || statusPinPreference.userId !== user.id || statusPinPreference.stored === null) return;
    const normalized = normalizePinnedInventoryStatusIds(readPinnedInventoryStatusIds(statusPinPreference.stored, statusDefinitions), statusDefinitions);
    if (JSON.stringify(normalized) === statusPinPreference.stored) return;
    const stored = JSON.stringify(normalized);
    try { window.localStorage.setItem(inventoryStatusPreferenceStorageKey(user.id), stored); } catch {}
    setStatusPinPreference({ userId: user.id, stored });
  }, [user?.id, statusOptionsLoaded, statusDefinitions, statusPinPreference]);

  useEffect(() => {
    if (!statusMenuOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (!statusMenuRef.current?.contains(event.target as Node)) setStatusMenuOpen(false);
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setStatusMenuOpen(false);
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [statusMenuOpen]);

  useEffect(() => {
    const update = () => setTableColumnFreezingEnabled(window.innerWidth >= 768);
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setStatusOptionsLoaded(false);
    void fetch('/api/warehouses').then(r => r.json()).then(r => { if (!cancelled && r.success) setWarehouses(r.data || []); });
    setIsAdmin(user?.role === 'admin');
    fetch('/api/inventory?meta=filters', { cache: 'no-store' })
      .then((response) => response.json())
      .then((result) => {
        if (!cancelled && result.success) {
          setFilterOptions(current => ({ ...result.data as FilterOptions, models: current.models }));
          setStatusOptionsLoaded(true);
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [active, reloadKey, user?.role]);

  useEffect(() => {
    if (!active || !filterDraft.brand) {
      setFilterModelsLoading(false);
      setFilterOptions(current => current.models.length ? { ...current, models: [] } : current);
      return;
    }
    let cancelled = false;
    setFilterModelsLoading(true);
    setFilterOptions(current => current.models.length ? { ...current, models: [] } : current);
    const params = new URLSearchParams({ meta: 'filters', brand: filterDraft.brand });
    if (filterDraft.warehouseId) params.set('warehouseId', filterDraft.warehouseId);
    fetch(`/api/inventory?${params}`, { cache: 'no-store' })
      .then(response => response.json())
      .then(result => {
        if (cancelled || !result.success) return;
        const models = (result.data as FilterOptions).models || [];
        setFilterOptions(current => ({ ...current, models }));
        setFilterDraft(current => current.model && !models.includes(current.model) ? { ...current, model: '' } : current);
      })
      .catch(() => {
        if (!cancelled) setFilterOptions(current => ({ ...current, models: [] }));
      })
      .finally(() => { if (!cancelled) setFilterModelsLoading(false); });
    return () => { cancelled = true; };
  }, [active, filterDraft.brand, filterDraft.warehouseId, reloadKey]);

  useEffect(() => {
    if (!active || activeWorkspace !== 'list') return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setError('');
      try {
        const params = buildInventoryQueryParams({
          page,
          pageSize,
          search,
          configSearch,
          status,
          filters,
          serials: serialSearchList,
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
    }, search || configSearch ? 220 : 0);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [active, activeWorkspace, page, pageSize, search, configSearch, status, filters, serialSearchList, reloadKey]);

  useEffect(() => {
    if (!exportOpen) return;
    const controller = new AbortController();
    setExportPreviewLoading(true);
    setExportPreviewCount(null);
    setExportError('');
    void fetch('/api/inventory/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'preview',
        mode: exportMode,
        query: currentExportQuery,
        ...(exportMode === 'selected' ? { ids: JSON.parse(currentExportIds) as string[] } : {}),
        columns: exportColumns,
      }),
      signal: controller.signal,
    }).then(async response => {
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error?.message || '无法预览导出数量');
      setExportPreviewCount(Number(result.data?.total || 0));
    }).catch(error => {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setExportError(error instanceof Error ? error.message : '无法预览导出数量');
    }).finally(() => {
      if (!controller.signal.aborted) setExportPreviewLoading(false);
    });
    return () => controller.abort();
  }, [exportOpen, exportMode, currentExportQuery, currentExportIds, exportColumnsKey]);

  useEffect(() => {
    if (!items.length) return;
    setCheckedMachines(current => {
      let changed = false;
      const next = new Map(current);
      for (const item of items) {
        if (next.has(item.id) && next.get(item.id) !== item) {
          next.set(item.id, item);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [items]);

  const itemStatusLabel = (item: InventoryItem) => item.customStatusName && (item.status === 'custom' || item.status === 'returning') ? `${item.status === 'returning' ? '退货中 · ' : ''}${item.customStatusName}` : statusLabel(item.status);
  const itemStatusStyle = (item: InventoryItem) => item.status === 'custom' && item.customStatusColor ? { color: item.customStatusColor, backgroundColor: `${item.customStatusColor}12`, borderColor: `${item.customStatusColor}40` } : undefined;
  const isSystemAccount = user?.isSystemAccount === true;
  const canEditInventory = !isViewer && (isSystemAccount || user?.canEditInventory === true);
  const statusChanged = (changedIds?: string[]) => {
    setReloadKey(n => n + 1);
    setSelected(null);
    if (!changedIds?.length) return;
    const changed = new Set(changedIds);
    setCheckedIds(current => new Set([...current].filter(id => !changed.has(id))));
    setCheckedMachines(current => new Map([...current].filter(([id]) => !changed.has(id))));
  };

  useEffect(() => {
    if (!active || !selected) {
      setMachineEditHistory([]);
      return;
    }
    const controller = new AbortController();
    setMachineEditHistoryLoading(true);
    setMachineEditHistoryError('');
    fetch(`/api/inventory/edit?inventoryId=${encodeURIComponent(selected.id)}`, { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok || !result.success) throw new Error(result.error?.message || '加载资料修改记录失败');
        if (!controller.signal.aborted) setMachineEditHistory(Array.isArray(result.data?.history) ? result.data.history : []);
      })
      .catch((historyError: unknown) => {
        if (!controller.signal.aborted) setMachineEditHistoryError(historyError instanceof Error ? historyError.message : '加载资料修改记录失败');
      })
      .finally(() => { if (!controller.signal.aborted) setMachineEditHistoryLoading(false); });
    return () => controller.abort();
  }, [active, selected?.id]);

  const submitMachineSearch = (event?: FormEvent) => {
    event?.preventDefault();
    serialSearchTokens.current = [];
    setSerialSearchList([]);
    setSearch(searchInput.trim());
    setPage(1);
  };

  const submitConfigSearch = (event?: FormEvent) => {
    event?.preventDefault();
    setConfigSearch(configSearchInput.trim());
    setPage(1);
  };

  const clearMachineSearch = () => {
    serialSearchTokens.current = [];
    setSerialSearchList([]);
    setSearchInput('');
    setSearch('');
    setPage(1);
  };

  const clearConfigSearch = () => {
    setConfigSearchInput('');
    setConfigSearch('');
    setPage(1);
  };

  const selectStatus = (nextStatus: string) => {
    setStatus(nextStatus);
    setStatusMenuOpen(false);
    setStatusMenuSearch('');
    setPage(1);
  };

  const togglePinnedStatus = (id: string) => {
    const next = pinnedStatusIds.includes(id)
      ? pinnedStatusIds.filter(statusId => statusId !== id)
      : pinnedStatusIds.length < 4 ? [...pinnedStatusIds, id] : pinnedStatusIds;
    const normalized = normalizePinnedInventoryStatusIds(next, statusDefinitions);
    const stored = JSON.stringify(normalized);
    if (user?.id) {
      try { window.localStorage.setItem(inventoryStatusPreferenceStorageKey(user.id), stored); }
      catch { setError('状态栏设置未能保存到当前浏览器'); }
      setStatusPinPreference({ userId: user.id, stored });
    }
  };

  const applyFilters = () => {
    if (filterDraft.inboundFrom && filterDraft.inboundTo && filterDraft.inboundFrom > filterDraft.inboundTo) {
      setError('入库日期范围无效，请检查开始和结束日期');
      return;
    }
    setError('');
    setFilters({ ...filterDraft });
    setPage(1);
  };

  const resetFilters = () => {
    setFilterDraft(EMPTY_FILTERS);
    setFilters(EMPTY_FILTERS);
    setExtraFilterKeys([]);
    setNewFilterKey('');
    setPage(1);
  };

  const activeFilterEntries = Object.entries(filters).filter(([, value]) => Boolean(value)) as Array<[keyof InventoryFilters, string]>;
  const activeFilterCount = activeFilterEntries.length;
  const filterFieldLabel = (key: keyof InventoryFilters) => {
    if (key === 'warehouseId') return '仓库';
    if (key === 'brand') return '品牌';
    if (key === 'model') return '型号';
    if (key === 'inboundFrom') return '入库日期起';
    if (key === 'inboundTo') return '入库日期止';
    return EXTRA_INVENTORY_FILTERS.find(field => field.key === key)?.label || key;
  };
  const filterFieldValue = (key: keyof InventoryFilters, value: string) => {
    if (key === 'warehouseId') return warehouses.find(warehouse => warehouse.id === value)?.name || value;
    if (key === 'brand' || key === 'model') return value;
    if (key === 'touchScreen') return value === '1' ? '是' : '否';
    return value;
  };
  const removeActiveFilter = (key: keyof InventoryFilters) => {
    const clearedKeys: Array<keyof InventoryFilters> = key === 'brand' ? ['brand', 'model'] : [key];
    setFilters(current => clearedKeys.reduce((next, filterKey) => ({ ...next, [filterKey]: '' }), { ...current }));
    setFilterDraft(current => clearedKeys.reduce((next, filterKey) => ({ ...next, [filterKey]: '' }), { ...current }));
    setPage(1);
  };
  const addFilterField = () => {
    if (!newFilterKey || extraFilterKeys.includes(newFilterKey)) return;
    setExtraFilterKeys(current => [...current, newFilterKey]);
    setFilterDraft(current => ({ ...current, [newFilterKey]: '' }));
    setNewFilterKey('');
  };
  const openInventoryExport = (mode: 'filtered' | 'selected') => {
    const visibleColumns = tablePreferences.columns.filter(column => column.visible).map(column => column.key);
    setExportColumns(visibleColumns.length ? visibleColumns : ['machine', 'serial']);
    setExportMode(mode);
    setExportError('');
    setExportOpen(true);
  };
  const toggleExportColumn = (key: InventoryTableColumnKey) => {
    setExportColumns(current => current.includes(key)
      ? current.filter(column => column !== key)
      : [...current, key]);
  };
  const downloadInventoryExport = async () => {
    if (!exportColumns.length || exportPreviewLoading || exportBusy) return;
    setExportBusy(true);
    setExportError('');
    try {
      const response = await fetch('/api/inventory/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'download',
          mode: exportMode,
          query: currentExportQuery,
          ...(exportMode === 'selected' ? { ids: JSON.parse(currentExportIds) as string[] } : {}),
          columns: exportColumns,
        }),
      });
      if (!response.ok) {
        const result = await response.json();
        throw new Error(result.error?.message || '导出库存失败');
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `库存导出-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setExportOpen(false);
    } catch (error) {
      setExportError(error instanceof Error ? error.message : '导出库存失败');
    } finally {
      setExportBusy(false);
    }
  };
  const checkedItems = [...checkedMachines.values()];
  const allPageChecked = items.length > 0 && items.every((item) => checkedIds.has(item.id));

  const toggleChecked = (id: string) => {
    const machine = items.find(item => item.id === id);
    setCheckedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setCheckedMachines(current => {
      const next = new Map(current);
      if (next.has(id)) next.delete(id);
      else if (machine) next.set(id, machine);
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
    setCheckedMachines(current => {
      const next = new Map(current);
      if (allPageChecked) items.forEach(item => next.delete(item.id));
      else items.forEach(item => next.set(item.id, item));
      return next;
    });
  };

  const openPrintSelected = () => {
    if (checkedItems.length === 0) return;
    router.push(`/settings/print/preview?ids=${encodeURIComponent(checkedItems.map((item) => item.id).join(','))}`);
  };

  const openDetails = (item: InventoryItem) => {
    setSelected(item);
    setRemark(item.remark || '');
    setSaved(false);
    setRemarkError('');
    setMachineEditOpen(false);
    setMachineEditDraft(null);
    setMachineEditError('');
  };

  const closeDetails = () => {
    if (!savingRemark && !savingMachineEdit) setSelected(null);
  };

  const openMachineEditor = () => {
    if (!selected || !canEditInventory) return;
    setMachineEditDraft(inventoryEditDraftFrom(selected));
    setMachineEditError('');
    setMachineEditOpen(true);
  };

  const closeMachineEditor = () => {
    if (savingMachineEdit) return;
    if (machineEditDirty) {
      setMachineEditDiscardConfirm(true);
      return;
    }
    setMachineEditOpen(false);
    setMachineEditDraft(null);
    setMachineEditError('');
  };

  const saveMachineEdit = async (event: FormEvent) => {
    event.preventDefault();
    if (!selected || !machineEditDraft || !canEditInventory) return;
    const fields = {
      sn: machineEditDraft.sn.trim(),
      itemNumber: machineEditDraft.itemNumber.trim(),
      productType: machineEditDraft.productType.trim(),
      brand: machineEditDraft.brand.trim(),
      model: machineEditDraft.model.trim(),
      year: String(machineEditDraft.year ?? '').trim() ? Number(String(machineEditDraft.year ?? '').trim()) : null,
      cpu: machineEditDraft.cpu.trim(),
      ram: machineEditDraft.ram.trim(),
      gpu: machineEditDraft.gpu.trim(),
      storage: machineEditDraft.storage.trim(),
      screen: machineEditDraft.screen.trim(),
      touchScreen: machineEditDraft.touchScreen === '' ? null : Number(machineEditDraft.touchScreen),
      purchasePrice: machineEditDraft.purchasePrice.trim() === '' ? Number.NaN : Number(machineEditDraft.purchasePrice),
    };
    if (!fields.sn || !fields.productType || !fields.brand || !fields.model) {
      setMachineEditError('SN、产品类型、品牌和型号不能为空');
      return;
    }
    if (!Number.isFinite(fields.purchasePrice) || fields.purchasePrice < 0 || fields.purchasePrice > 1_000_000_000) {
      setMachineEditError('采购价格必须是 0 至 10 亿元之间的有效金额');
      return;
    }
    if ((fields.year !== null && (!Number.isInteger(fields.year) || fields.year < 1900 || fields.year > 2100)) ||
        (fields.touchScreen !== null && ![0, 1].includes(fields.touchScreen))) {
      setMachineEditError('年份或触屏选项格式不正确');
      return;
    }

    setSavingMachineEdit(true);
    setMachineEditError('');
    try {
      const response = await fetch('/api/inventory/edit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inventoryId: selected.id, expectedSn: selected.sn, fields }),
      });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error?.message || '保存机器资料失败');
      const updated = (result.data?.item || result.data) as InventoryItem;
      setSelected(updated);
      setRemark(updated.remark || '');
      setItems(current => current.map(item => item.id === updated.id ? updated : item));
      setMachineEditHistory(Array.isArray(result.data?.history) ? result.data.history : machineEditHistory);
      setMachineEditOpen(false);
      setMachineEditDraft(null);
      setReloadKey(current => current + 1);
    } catch (saveError) {
      setMachineEditError(saveError instanceof Error ? saveError.message : '保存机器资料失败');
    } finally {
      setSavingMachineEdit(false);
    }
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
    setAssetPrintError('');
    setPendingAssetPrintId(machine.id);
  };

  const printUpdatedAssetLabel = async () => {
    if (!pendingAssetPrintId || printing || assetPrintBusy) return;
    const inventoryId = pendingAssetPrintId;
    setAssetPrintBusy(true);
    setAssetPrintError('');
    try {
      await printLabels([inventoryId]);
      setPendingAssetPrintId(null);
    } catch (printError) {
      setAssetPrintError(printError instanceof Error ? printError.message : '打印标签失败，请重试');
    } finally {
      setAssetPrintBusy(false);
    }
  };

  const saveTablePreferences = (preferences: InventoryTablePreferences) => {
    if (!user?.id) return false;
    const normalized = normalizeInventoryTablePreferences(preferences);
    try {
      window.localStorage.setItem(inventoryTablePreferenceStorageKey(user.id), JSON.stringify(normalized));
    } catch {
      return false;
    }
    setTablePreferences(normalized);
    setTableSettingsOpen(false);
    return true;
  };

  const saveTableColumnWidth = (key: InventoryTableColumnKey, width: number) => {
    if (!user?.id || !tablePreferencesHydrated) return;
    const next = setInventoryTableColumnWidth(tablePreferences, key, width);
    if (next === tablePreferences) return;
    setTablePreferences(next);
    try {
      window.localStorage.setItem(inventoryTablePreferenceStorageKey(user.id), JSON.stringify(next));
    } catch {
      setError('列宽已调整，但浏览器未能保存设置；刷新后可能恢复原宽度');
    }
  };

  const beginColumnResize = (event: ReactPointerEvent<HTMLSpanElement>, key: InventoryTableColumnKey, width: number) => {
    if (event.button !== 0 || !tablePreferencesHydrated) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    columnResizeSession.current = { key, pointerId: event.pointerId, startX: event.clientX, startWidth: width, currentWidth: width };
    setColumnResizePreview({ key, width });
  };

  const moveColumnResize = (event: ReactPointerEvent<HTMLSpanElement>) => {
    const session = columnResizeSession.current;
    if (!session || session.pointerId !== event.pointerId) return;
    const width = clampInventoryTableColumnWidth(session.startWidth + event.clientX - session.startX, session.startWidth);
    if (width === session.currentWidth) return;
    session.currentWidth = width;
    setColumnResizePreview({ key: session.key, width });
  };

  const finishColumnResize = (event: ReactPointerEvent<HTMLSpanElement>, useLastWidth = false) => {
    const session = columnResizeSession.current;
    if (!session || session.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const width = useLastWidth
      ? session.currentWidth
      : clampInventoryTableColumnWidth(session.startWidth + event.clientX - session.startX, session.startWidth);
    columnResizeSession.current = null;
    setColumnResizePreview(null);
    saveTableColumnWidth(session.key, width);
  };

  const adjustColumnWidthWithKeyboard = (event: KeyboardEvent<HTMLSpanElement>, key: InventoryTableColumnKey, width: number) => {
    let nextWidth = width;
    if (event.key === 'ArrowLeft') nextWidth -= event.shiftKey ? 25 : 10;
    else if (event.key === 'ArrowRight') nextWidth += event.shiftKey ? 25 : 10;
    else if (event.key === 'Home') nextWidth = INVENTORY_TABLE_COLUMN_MIN_WIDTH;
    else if (event.key === 'End') nextWidth = INVENTORY_TABLE_COLUMN_MAX_WIDTH;
    else return;
    event.preventDefault();
    event.stopPropagation();
    saveTableColumnWidth(key, nextWidth);
  };

  const displayedTablePreferences = columnResizePreview
    ? setInventoryTableColumnWidth(tablePreferences, columnResizePreview.key, columnResizePreview.width)
    : tablePreferences;
  const visibleTableColumns = displayedTablePreferences.columns.filter((column) => column.visible);
  const selectionColumnWidth = isViewer ? 0 : 44;
  const actionColumnWidth = 100;
  const frozenOffsets = getInventoryTableFrozenOffsets(displayedTablePreferences.columns, {
    selectionWidth: selectionColumnWidth,
    actionsWidth: actionColumnWidth,
  });
  const tableMinWidth = visibleTableColumns.reduce((width, column) => width + column.width, selectionColumnWidth + actionColumnWidth);
  const cellPadding = displayedTablePreferences.density === 'compact' ? '6px 8px' : displayedTablePreferences.density === 'comfortable' ? '16px 16px' : '13px 14px';
  const headerPadding = displayedTablePreferences.density === 'compact' ? '8px 8px' : displayedTablePreferences.density === 'comfortable' ? '13px 16px' : '11px 14px';
  const stickyColumnStyle = (key: InventoryTableColumnKey, header = false): CSSProperties => {
    if (!tableColumnFreezingEnabled) return {};
    const offsets = frozenOffsets[key];
    if (!offsets) return {};
    return {
      position: 'sticky',
      ...(offsets.left !== undefined ? { left: offsets.left } : {}),
      ...(offsets.right !== undefined ? { right: offsets.right } : {}),
      zIndex: header ? 30 : 10,
      backgroundColor: 'white',
    };
  };
  const fixedColumnStyle = (side: 'left' | 'right', header = false): CSSProperties => {
    if (!tableColumnFreezingEnabled) return {};
    return {
      position: 'sticky',
      [side]: 0,
      zIndex: header ? 40 : 20,
      backgroundColor: 'white',
    };
  };
  const renderTableCell = (item: InventoryItem, key: InventoryTableColumnKey) => {
    switch (key) {
      case 'machine':
        return <><div className="truncate font-medium text-ink-deep" title={productName(item)}>{productName(item)}</div><div className="mt-1 truncate text-[11px] text-ink-soft" title={item.productType || '未分类'}>{item.productType || '未分类'}</div></>;
      case 'productType':
        return <span className="block truncate" title={item.productType || '-'}>{item.productType || '-'}</span>;
      case 'brand':
        return <span className="block truncate" title={item.brand || '-'}>{item.brand || '-'}</span>;
      case 'model':
        return <span className="block truncate" title={item.model || '-'}>{item.model || '-'}</span>;
      case 'year':
        return item.year || '-';
      case 'configuration':
        return <><div className="truncate text-[12px] text-ink" title={[formatCPUDisplay(item.cpu), item.ram, item.storage].filter(Boolean).join(' · ')}>{[formatCPUDisplay(item.cpu), item.ram, item.storage].filter(Boolean).join(' · ') || '-'}</div><div className="mt-1 truncate text-[11px] text-ink-soft" title={[formatGPUDisplay(item.gpu), formatScreenDisplay(item.screen), item.touchScreen ? '触屏' : ''].filter(Boolean).join(' · ')}>{[formatGPUDisplay(item.gpu), formatScreenDisplay(item.screen), item.touchScreen ? '触屏' : ''].filter(Boolean).join(' · ') || '配置未补充'}</div></>;
      case 'cpu':
        return <span className="block truncate" title={formatCPUDisplay(item.cpu) || '-'}>{formatCPUDisplay(item.cpu) || '-'}</span>;
      case 'ram':
        return item.ram || '-';
      case 'storage':
        return item.storage || '-';
      case 'gpu':
        return <span className="block truncate" title={formatGPUDisplay(item.gpu) || '-'}>{formatGPUDisplay(item.gpu) || '-'}</span>;
      case 'screen':
        return formatScreenDisplay(item.screen) || '-';
      case 'touchScreen':
        return item.touchScreen == null ? '未记录' : item.touchScreen ? '是' : '否';
      case 'remarks':
        return <InventoryRemarks remark={item.remark} skuRemark={item.skuRemark} />;
      case 'machineRemark':
        return <span className="block truncate text-ink-soft" title={item.remark || '-'}>{item.remark?.trim() || '-'}</span>;
      case 'skuRemark':
        return <span className="block truncate text-ink-soft" title={item.skuRemark || '-'}>{item.skuRemark?.trim() || '-'}</span>;
      case 'serial':
        return <><div className="flex min-w-0 items-center gap-1"><span className="truncate font-mono text-[12px] text-ink-deep" title={item.sn}>{item.sn}</span><CopyTextButton value={item.sn} label="SN" /></div>{item.itemNumber && <div className="mt-1 flex min-w-0 items-center gap-1 text-[11px] text-ink-soft"><span className="truncate font-mono" title={item.itemNumber}>编号 {item.itemNumber}</span><CopyTextButton value={item.itemNumber} label="编号" /></div>}</>;
      case 'sn':
        return <div className="flex min-w-0 items-center gap-1"><span className="truncate font-mono text-[12px] text-ink-deep" title={item.sn}>{item.sn}</span><CopyTextButton value={item.sn} label="SN" /></div>;
      case 'itemNumber':
        return item.itemNumber ? <div className="flex min-w-0 items-center gap-1"><span className="truncate font-mono" title={item.itemNumber}>{item.itemNumber}</span><CopyTextButton value={item.itemNumber} label="编号" /></div> : '-';
      case 'source':
        return <><div className="truncate text-[12px] text-ink" title={item.supplierName || '-'}>{item.supplierName || '-'}</div><div className="mt-1 truncate font-mono text-[11px] text-ink-soft" title={item.purchaseNo || '-'}>{item.purchaseNo || '-'}</div></>;
      case 'supplier':
        return <span className="block truncate" title={item.supplierName || '-'}>{item.supplierName || '-'}</span>;
      case 'purchaseNo':
        return <span className="block truncate font-mono" title={item.purchaseNo || '-'}>{item.purchaseNo || '-'}</span>;
      case 'warehouse':
        return <span className="block truncate" title={item.warehouseName || warehouses.find((warehouse) => warehouse.id === item.warehouseId)?.name || '未分仓'}>{item.warehouseName || warehouses.find((warehouse) => warehouse.id === item.warehouseId)?.name || '未分仓'}</span>;
      case 'purchasePrice':
        return <span className="font-mono text-[13px] text-ink-deep">{formatMoney(item.purchasePrice)}</span>;
      case 'status':
        return <><span className={statusClass(item.status)} style={itemStatusStyle(item)}><span className="status-dot" />{itemStatusLabel(item)}</span><div className="mt-1.5 truncate text-[11px] text-ink-soft" title={machineDestination(item)}>{machineDestination(item)}</div></>;
      case 'statusOnly':
        return <span className={statusClass(item.status)} style={itemStatusStyle(item)}><span className="status-dot" />{itemStatusLabel(item)}</span>;
      case 'destination':
        return <span className="block truncate text-ink-soft" title={machineDestination(item)}>{machineDestination(item)}</span>;
      case 'inbound':
        return <><div className="text-[12px] text-ink">{formatDate(item.inboundDate)}</div><div className={`mt-1 truncate text-[11px] ${item.inboundDays > 30 ? 'text-danger' : item.inboundDays > 7 ? 'text-warning' : 'text-ink-soft'}`}>{['in_stock', 'custom'].includes(item.status) ? '在库' : '入库距今'} {Math.max(0, Number(item.inboundDays || 0))} 天</div></>;
      case 'inboundDate':
        return formatDate(item.inboundDate);
      case 'inboundDays':
        return <span className={item.inboundDays > 30 ? 'text-danger' : item.inboundDays > 7 ? 'text-warning' : 'text-ink-soft'}>{Math.max(0, Number(item.inboundDays || 0))} 天</span>;
    }
  };

  const workspaceNavigation = <div role="tablist" aria-label="库存工作区" className="mb-5 flex w-fit max-w-full gap-1 overflow-x-auto rounded-xl border border-line/70 bg-white/55 p-1">
    <button type="button" role="tab" aria-selected={activeWorkspace === 'list'} onClick={() => selectWorkspace('list')} className={'inline-flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm transition ' + (activeWorkspace === 'list' ? 'bg-white text-primary shadow-sm' : 'text-ink-soft hover:bg-white/70')}><PackageOpen className="h-4 w-4" />库存清单</button>
    <button type="button" role="tab" aria-selected={activeWorkspace === 'transfers'} onClick={() => selectWorkspace('transfers')} className={'inline-flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm transition ' + (activeWorkspace === 'transfers' ? 'bg-white text-primary shadow-sm' : 'text-ink-soft hover:bg-white/70')}><ArrowRightLeft className="h-4 w-4" />库存调拨</button>
  </div>;

  return (
    <div className="max-w-[1400px] mx-auto page-transition-enter">
      {printPortal}
      <header className="flex flex-wrap items-end justify-between gap-4 mb-6">
        <div>
          <h1 className="text-xl font-bold tracking-wide text-ink-deep mb-2">在库清单</h1>
          <p className="text-[13px] text-ink-soft">全部机器档案与完整去向，贯通入库、销售和售后历史</p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-3 text-[13px] text-ink-soft">
          <span title="当前用户可查看仓库内全部未删除的机器档案，包含在库、已售、租赁、售后暂存及其他历史状态">机器档案总数 <b className="font-mono text-[15px] text-ink-deep">{stats.total}</b></span>
          <span title="只统计普通在库和自定义状态机器；不含已销售出库、租赁出库、售后暂存等状态">当前在库 <b className="font-mono text-[15px] text-success">{stats.inStock}</b></span>
          <span>已售 <b className="font-mono text-[15px] text-primary">{stats.sold}</b></span>
          <span>自定义状态 <b className="font-mono text-[15px] text-ink-deep">{stats.custom || 0}</b></span>
          <span>可参与业务 <b className="font-mono text-[15px] text-success">{stats.available ?? stats.inStock}</b></span>
          <span>在库成本 <b className="font-mono text-[15px] text-ink-deep">{formatMoney(stats.inStockCost)}</b></span>
          {!isViewer && <Link href="/inventory/analysis" className="btn-ghost inline-flex items-center gap-1.5"><BarChart3 className="h-4 w-4" />库存分析</Link>}
        </div>
      </header>

      {!isViewer && workspaceNavigation}

      <WorkspaceSection active={activeWorkspace === 'list'}>
      <section className="glass p-4 mb-4">
        <div className="flex flex-wrap items-end gap-3">
          <div role="group" aria-label="库存搜索" className="grid min-w-0 basis-full grid-cols-1 gap-2.5 sm:grid-cols-2 xl:max-w-xl xl:flex-1">
            <form onSubmit={submitMachineSearch} className="min-w-0">
              <label htmlFor="inventory-machine-search" className="mb-1.5 block text-[11px] font-medium text-ink-soft">机器信息</label>
              <MachineSearchInput<InventoryItem> inputId="inventory-machine-search" value={searchInput} onChange={setSearchInput} onClear={clearMachineSearch} endpoint={`/api/inventory/lookup?context=inventory${filters.warehouseId ? `&warehouseId=${encodeURIComponent(filters.warehouseId)}` : ''}`} onSelect={item => { serialSearchTokens.current = [item.sn]; setSerialSearchList([item.sn]); setSearchInput(item.sn); setSearch(item.sn); setPage(1); }} onSelectMany={(_items, serials) => { const tokens = uniqueMachineScanTokens([...serialSearchTokens.current, ...serials]); serialSearchTokens.current = tokens; setSerialSearchList(tokens); const query = tokens.join(', '); setSearchInput(query); setSearch(query); setPage(1); return query; }} onSearch={query => { serialSearchTokens.current = []; setSerialSearchList([]); setSearchInput(query); setSearch(query.trim()); setPage(1); }} scanEnabled batchEnabled batchButtonPlacement="inline" searchOnEnter placeholder="搜索 SN、编号、品牌或型号" ariaLabel="搜索库存机器的 SN、编号、品牌或型号" />
            </form>
            <form onSubmit={submitConfigSearch} className="min-w-0">
              <label htmlFor="inventory-config-search" className="mb-1.5 block text-[11px] font-medium text-ink-soft">配置 / 备注</label>
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-soft" aria-hidden="true" />
                <input id="inventory-config-search" type="text" value={configSearchInput} onChange={event => setConfigSearchInput(event.target.value)} placeholder="CPU、内存、硬盘、显卡、屏幕或备注" aria-label="搜索机器配置、机器备注或 SKU 备注" className="field w-full pl-10 pr-10" />
                {configSearchInput && <button type="button" onClick={clearConfigSearch} className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-ink-soft transition hover:bg-primary/5 hover:text-ink-deep active:scale-95" aria-label="清除配置搜索"><X className="h-4 w-4" /></button>}
              </div>
            </form>
          </div>

          <div className="order-last flex min-w-0 w-full items-center gap-1.5 pb-0.5">
            <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto" role="tablist" aria-label="库存状态筛选">
              {[
                ['', '全部'],
                ['current_stock', '在库'],
                ['sold', '已售'],
                ['renting', '租赁中'],
                ...pinnedStatusDefinitions.map(item => [`custom:${item.id}`, item.name]),
              ].map(([value, label]) => (
                <button key={value || 'all'} type="button" role="tab" aria-selected={status === value} onClick={() => selectStatus(value)} className={`shrink-0 px-3 py-1.5 rounded-full text-[12px] transition-colors ${status === value ? 'bg-primary text-white shadow-sm' : 'text-ink-soft hover:bg-white/70'}`}>{label}</button>
              ))}
            </div>
            {otherStatusDefinitions.length > 0 && <div ref={statusMenuRef} className="relative shrink-0">
              <button type="button" aria-haspopup="dialog" aria-expanded={statusMenuOpen} aria-controls="inventory-other-statuses" onClick={() => setStatusMenuOpen(open => !open)} className={`inline-flex max-w-[180px] items-center gap-1 rounded-full border px-3 py-1.5 text-[12px] transition-colors ${selectedCustomStatus && !pinnedStatusIds.includes(selectedCustomStatus.id) ? 'border-primary/25 bg-primary/10 text-primary' : 'border-line/70 text-ink-soft hover:bg-white/70'}`}>
                <span className="truncate">{selectedCustomStatus && !pinnedStatusIds.includes(selectedCustomStatus.id) ? selectedCustomStatus.name : `其他状态${otherStatusDefinitions.length > 1 ? ` ${otherStatusDefinitions.length}` : ''}`}</span><ChevronDown className="h-3.5 w-3.5 shrink-0" />
              </button>
              {statusMenuOpen && <div id="inventory-other-statuses" role="dialog" aria-label="选择库存状态" className="absolute left-0 top-full z-40 mt-2 w-[min(300px,calc(100vw-2rem))] overflow-hidden rounded-xl border border-line bg-white shadow-xl">
                <div className="border-b border-line/70 p-2.5"><div className="relative"><Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-soft" aria-hidden="true" /><input autoFocus value={statusMenuSearch} onChange={event => setStatusMenuSearch(event.target.value)} placeholder="查找状态" aria-label="搜索库存状态" className="field h-9 pl-8 text-xs" /></div></div>
                <div role="listbox" aria-label="其他库存状态" className="max-h-64 overflow-y-auto p-1.5">
                  {filteredOtherStatusDefinitions.map(item => <button key={item.id} type="button" role="option" aria-selected={status === `custom:${item.id}`} onClick={() => selectStatus(`custom:${item.id}`)} className={`flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-2 text-left text-xs transition-colors ${status === `custom:${item.id}` ? 'bg-primary/10 text-primary' : 'text-ink-deep hover:bg-primary/5'}`}><span className="flex min-w-0 items-center gap-2"><span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: item.color }} /><span className="truncate">{item.name}</span>{!(item.isActive === true || item.isActive === 1) && <span className="shrink-0 text-[10px] text-ink-soft">已停用</span>}</span><span className="shrink-0 tabular-nums text-ink-soft">{Number(item.machineCount || 0)}</span></button>)}
                  {filteredOtherStatusDefinitions.length === 0 && <p className="px-2.5 py-5 text-center text-xs text-ink-soft">没有匹配的库存状态</p>}
                </div>
                {isAdmin && <button type="button" onClick={() => { setStatusMenuOpen(false); setStatusDialog({ mode: 'manage' }); }} className="flex w-full items-center gap-2 border-t border-line/70 px-3 py-2.5 text-left text-xs text-primary transition hover:bg-primary/5"><Pin className="h-3.5 w-3.5" />管理状态栏显示</button>}
              </div>}
            </div>}
          </div>

          {isAdmin && <><button type="button" onClick={() => setStatusDialog({ mode: 'register' })} className="btn-ghost inline-flex items-center gap-1.5"><Wrench className="h-4 w-4" />状态登记</button><button type="button" onClick={() => setStatusDialog({ mode: 'manage' })} className="btn-ghost inline-flex items-center gap-1.5"><Settings2 className="h-4 w-4" />状态管理</button></>}

          <div className="flex items-center gap-1 rounded-lg border border-line/70 bg-white/50 p-1" role="group" aria-label="库存视图">
            <button type="button" onClick={() => setViewMode('table')} aria-pressed={viewMode === 'table'} title="表格视图" className={`rounded-md p-1.5 transition-colors ${viewMode === 'table' ? 'bg-primary text-white' : 'text-ink-soft hover:bg-white'}`}><Table2 className="h-4 w-4" /></button>
            <button type="button" onClick={() => setViewMode('cards')} aria-pressed={viewMode === 'cards'} title="卡片视图" className={`rounded-md p-1.5 transition-colors ${viewMode === 'cards' ? 'bg-primary text-white' : 'text-ink-soft hover:bg-white'}`}><LayoutGrid className="h-4 w-4" /></button>
          </div>
          <button type="button" onClick={() => setTableSettingsOpen(true)} disabled={!tablePreferencesHydrated} title="自定义库存表格列" className="btn-ghost inline-flex items-center gap-1.5 disabled:cursor-not-allowed disabled:opacity-50"><Columns3 className="h-4 w-4" />列设置</button>
          {!isViewer && <button type="button" onClick={() => openInventoryExport('filtered')} className="btn-ghost inline-flex items-center gap-1.5"><FileDown className="h-4 w-4" />导出结果</button>}
          <button type="button" onClick={() => setFiltersOpen((open) => !open)} aria-expanded={filtersOpen} className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-[12px] transition-colors ${filtersOpen || activeFilterCount > 0 ? 'border-primary/30 bg-primary/10 text-primary' : 'border-line/70 text-ink-soft hover:bg-white/70'}`}><SlidersHorizontal className="h-4 w-4" />组合筛选{activeFilterCount > 0 && <span className="rounded-full bg-primary px-1.5 py-0.5 text-[10px] text-white">{activeFilterCount}</span>}</button>
          <button type="button" onClick={() => setReloadKey((key) => key + 1)} disabled={loading} title="刷新库存" aria-label="刷新库存" className="self-end lg:self-auto p-2 text-ink-soft hover:text-primary hover:bg-white/70 rounded-lg transition-colors"><RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /></button>
        </div>
      </section>

      {filtersOpen && (
        <section className="glass mb-4 border border-primary/10 p-4">
          <div className="mb-3 flex items-center justify-between gap-3"><div className="flex items-center gap-2 text-[13px] font-medium text-ink-deep"><Filter className="h-4 w-4 text-primary" />组合筛选</div><span className="text-[11px] text-ink-soft">应用后会回到第 1 页</span></div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <label className="block"><span className="mb-1.5 block text-[11px] text-ink-soft">仓库</span><CustomSelect value={filterDraft.warehouseId} onChange={value => { setFilterModelsLoading(Boolean(filterDraft.brand)); setFilterDraft(current => ({ ...current, warehouseId: value, model: '' })); }} options={[{ value: '', label: '全部授权仓库' }, ...warehouses.map(w => ({ value: w.id, label: w.name }))]} placeholder="全部授权仓库" /></label><FilterSelect label="品牌" value={filterDraft.brand} options={filterOptions.brands} onChange={(value) => { setFilterModelsLoading(Boolean(value)); setFilterOptions(current => ({ ...current, models: [] })); setFilterDraft((current) => ({ ...current, brand: value, model: '' })); }} />
            <FilterSelect label="型号" value={filterDraft.model} options={filterOptions.models} onChange={(value) => setFilterDraft((current) => ({ ...current, model: value }))} disabled={!filterDraft.brand || filterModelsLoading || !filterOptions.models.length} emptyLabel={!filterDraft.brand ? '请先选择品牌' : filterModelsLoading ? '正在加载型号…' : filterOptions.models.length ? '全部型号' : '该品牌暂无库存型号'} />
            <label className="block"><span className="mb-1.5 block text-[11px] text-ink-soft">入库日期起</span><input type="date" value={filterDraft.inboundFrom} onChange={(event) => setFilterDraft((current) => ({ ...current, inboundFrom: event.target.value }))} className="field" /></label>
            <label className="block"><span className="mb-1.5 block text-[11px] text-ink-soft">入库日期止</span><input type="date" value={filterDraft.inboundTo} onChange={(event) => setFilterDraft((current) => ({ ...current, inboundTo: event.target.value }))} className="field" /></label>
            {extraFilterKeys.map(key => {
              const definition = EXTRA_INVENTORY_FILTERS.find(item => item.key === key)!;
              return <label key={key} className="block min-w-0"><span className="mb-1.5 block text-[11px] text-ink-soft">{definition.label}</span>{key === 'touchScreen'
                ? <CustomSelect aria-label="按触屏筛选" value={filterDraft.touchScreen} onChange={value => setFilterDraft(current => ({ ...current, touchScreen: value }))} options={[{ value: '', label: '不限' }, { value: '1', label: '触屏' }, { value: '0', label: '非触屏' }]} />
                : <input type="text" value={filterDraft[key]} onChange={event => setFilterDraft(current => ({ ...current, [key]: event.target.value }))} maxLength={200} placeholder={definition.placeholder} className="field" />}</label>;
            })}
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line/60 pt-4">
            <span className="text-[11px] text-ink-soft">添加筛选条件</span>
            <div className="min-w-[200px] flex-1 sm:max-w-xs"><CustomSelect aria-label="选择要添加的库存筛选条件" value={newFilterKey} onChange={value => setNewFilterKey(value as ExtraInventoryFilterKey)} options={EXTRA_INVENTORY_FILTERS.filter(field => !extraFilterKeys.includes(field.key)).map(field => ({ value: field.key, label: field.label }))} placeholder="选择条件" /></div>
            <button type="button" onClick={addFilterField} disabled={!newFilterKey} className="btn-ghost inline-flex items-center gap-1.5 disabled:cursor-not-allowed disabled:opacity-50"><Check className="h-4 w-4" />添加</button>
          </div>
          <div className="mt-4 flex flex-wrap items-center justify-end gap-2"><button type="button" onClick={resetFilters} className="btn-ghost">清空条件</button><button type="button" onClick={applyFilters} className="btn-primary inline-flex items-center gap-1.5"><Check className="h-4 w-4" />应用筛选</button></div>
        </section>
      )}

      {activeFilterEntries.length > 0 && <div className="mb-4 flex flex-wrap items-center gap-2" aria-label="已应用的库存筛选条件"><span className="text-[11px] text-ink-soft">已应用</span>{activeFilterEntries.map(([key, value]) => <button key={key} type="button" onClick={() => removeActiveFilter(key)} title={`清除${filterFieldLabel(key)}筛选`} className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-primary/15 bg-white/75 px-2.5 py-1 text-[11px] text-ink-deep transition hover:border-primary/30 hover:bg-primary/5"><span className="text-ink-soft">{filterFieldLabel(key)}</span><span className="max-w-[180px] truncate">{filterFieldValue(key, value)}</span><X className="h-3 w-3 shrink-0 text-ink-soft" /></button>)}</div>}

      {error && (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-danger/20 bg-danger/5 px-4 py-3 text-[13px] text-danger">
          <span>{error}</span>
          <button type="button" onClick={() => setError('')} title="关闭提示" aria-label="关闭提示" className="p-1 hover:bg-danger/10 rounded-md"><X className="w-4 h-4" /></button>
        </div>
      )}

      {!isViewer && checkedItems.length > 0 && (
        <section className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-primary/15 bg-primary/5 px-4 py-3">
          <div className="flex items-center gap-2 text-[12px] text-ink-deep"><CheckSquare className="h-4 w-4 text-primary" />已选 <b>{checkedItems.length}</b> 台机器</div>
          <div className="flex flex-wrap items-center gap-2">{isAdmin && checkedItems.length === 1 && checkedItems[0].status === 'in_stock' && <button type="button" onClick={() => setAssetChangeMachine(checkedItems[0])} className="btn-ghost inline-flex items-center gap-1.5"><MemoryStick className="h-4 w-4" />资产变更</button>}{isAdmin && <button type="button" onClick={() => setStatusDialog({ mode: 'register', machines: checkedItems })} title="在机器状态登记窗口中统一登记" className="btn-ghost inline-flex items-center gap-1.5"><Wrench className="h-4 w-4" />登记所选机器状态</button>}<button type="button" onClick={openPrintSelected} className="btn-ghost inline-flex items-center gap-1.5"><Printer className="h-4 w-4" />打印所选标签</button><button type="button" onClick={() => openInventoryExport('selected')} className="btn-ghost inline-flex items-center gap-1.5"><FileDown className="h-4 w-4" />导出所选</button><button type="button" onClick={() => { setCheckedIds(new Set()); setCheckedMachines(new Map()); }} className="text-[12px] text-ink-soft hover:text-ink-deep">清除选择</button></div>
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
          <div className="overflow-x-auto" role="region" aria-label="库存表格，可左右滚动" tabIndex={0}>
            <table className="data-table" style={{ width: `${tableMinWidth}px`, tableLayout: 'fixed' }}>
              <colgroup>
                {!isViewer && <col style={{ width: `${selectionColumnWidth}px` }} />}
                {visibleTableColumns.map((column) => <col key={column.key} style={{ width: `${column.width}px` }} />)}
                <col style={{ width: `${actionColumnWidth}px` }} />
              </colgroup>
              <thead><tr>
                {!isViewer && <th className="inventory-fixed-column" style={{ width: selectionColumnWidth, padding: headerPadding, letterSpacing: 0, ...fixedColumnStyle('left', true) }}><input type="checkbox" checked={allPageChecked} onChange={togglePageChecked} aria-label="选择当前页全部机器" /></th>}
                {visibleTableColumns.map((column) => {
                  const label = INVENTORY_TABLE_COLUMN_DEFINITIONS.find((definition) => definition.key === column.key)?.label || column.key;
                  return <th key={column.key} className={`group relative ${tableColumnFreezingEnabled && frozenOffsets[column.key] ? 'inventory-configurable-frozen' : ''}`} style={{ width: column.width, padding: headerPadding, letterSpacing: 0, ...stickyColumnStyle(column.key, true) }}>
                    <span className="block truncate pr-2" title={label}>{label}</span>
                    <span
                      role="separator"
                      aria-label={`调整${label}列宽`}
                      aria-orientation="vertical"
                      aria-valuemin={INVENTORY_TABLE_COLUMN_MIN_WIDTH}
                      aria-valuemax={INVENTORY_TABLE_COLUMN_MAX_WIDTH}
                      aria-valuenow={column.width}
                      tabIndex={tablePreferencesHydrated ? 0 : -1}
                      aria-disabled={!tablePreferencesHydrated}
                      title="拖动调整列宽；方向键微调"
                      onPointerDown={(event) => beginColumnResize(event, column.key, column.width)}
                      onPointerMove={moveColumnResize}
                      onPointerUp={(event) => finishColumnResize(event)}
                      onPointerCancel={(event) => finishColumnResize(event, true)}
                      onLostPointerCapture={(event) => finishColumnResize(event, true)}
                      onKeyDown={(event) => adjustColumnWidthWithKeyboard(event, column.key, column.width)}
                      className={`absolute inset-y-0 right-0 z-50 flex w-3 touch-none select-none items-center justify-center outline-none focus-visible:bg-primary/10 ${tablePreferencesHydrated ? 'cursor-col-resize' : 'pointer-events-none'}`}
                    ><span className="h-5 w-0.5 rounded-full bg-line-strong transition-colors group-hover:bg-primary group-focus-visible:bg-primary" /></span>
                  </th>;
                })}
                <th className="inventory-fixed-column text-right" style={{ width: actionColumnWidth, padding: headerPadding, letterSpacing: 0, ...fixedColumnStyle('right', true) }}>操作</th>
              </tr></thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id} onClick={() => openDetails(item)} className="cursor-pointer">
                    {!isViewer && <td className="inventory-fixed-column" onClick={(event) => event.stopPropagation()} style={{ width: selectionColumnWidth, padding: cellPadding, ...fixedColumnStyle('left') }}><input type="checkbox" checked={checkedIds.has(item.id)} onChange={() => toggleChecked(item.id)} aria-label={`选择 ${item.sn}`} /></td>}
                    {visibleTableColumns.map((column) => <td key={column.key} className={tableColumnFreezingEnabled && frozenOffsets[column.key] ? 'inventory-configurable-frozen' : undefined} style={{ width: column.width, padding: cellPadding, ...stickyColumnStyle(column.key) }}>{renderTableCell(item, column.key)}</td>)}
                    <td className="inventory-fixed-column text-right" style={{ width: actionColumnWidth, padding: cellPadding, ...fixedColumnStyle('right') }}><button type="button" onClick={(event) => { event.stopPropagation(); openDetails(item); }} title="查看机器详情" aria-label={`查看 ${item.sn} 详情`} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[12px] text-primary hover:bg-primary/10 rounded-lg transition-colors"><Eye className="w-3.5 h-3.5" />详情</button></td>
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
                  <div className="flex shrink-0 items-center gap-2">{!isViewer && <input type="checkbox" checked={checkedIds.has(item.id)} onChange={() => toggleChecked(item.id)} aria-label={`选择 ${item.sn}`} />}<span className={statusClass(item.status)} style={itemStatusStyle(item)}><span className="status-dot" />{itemStatusLabel(item)}</span></div>
                </div>
                <p className="mt-3 text-xs text-ink-soft">{machineDestination(item)}</p><div className="mt-4 space-y-2 text-[12px]">
                  <div className="flex items-center justify-between gap-3"><span className="text-ink-soft">配置</span><span className="truncate text-right text-ink-deep">{[formatCPUDisplay(item.cpu), item.ram, item.storage].filter(Boolean).join(' · ') || '-'}</span></div>
                  <div className="flex items-start justify-between gap-3"><span className="shrink-0 text-ink-soft">备注</span><div className="min-w-0 text-right"><InventoryRemarks remark={item.remark} skuRemark={item.skuRemark} /></div></div>
                  <div className="flex items-center justify-between gap-3"><span className="text-ink-soft">SN / IMEI</span><div className="flex min-w-0 items-center gap-1"><span className="truncate font-mono text-right text-ink-deep">{item.sn}</span><CopyTextButton value={item.sn} label="SN" /></div></div>
                  {item.itemNumber && <div className="flex items-center justify-between gap-3"><span className="text-ink-soft">编号</span><div className="flex min-w-0 items-center gap-1"><span className="truncate font-mono text-right text-ink-deep">{item.itemNumber}</span><CopyTextButton value={item.itemNumber} label="编号" /></div></div>}
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
            <div className="flex flex-wrap items-center justify-end gap-2"><label className="flex items-center gap-2">每页<CustomSelect aria-label="库存每页显示条数" value={String(pageSize)} onChange={value => { setPageSize(Number(value)); setPage(1); }} options={[20, 50, 100].map(value => ({ value: String(value), label: `${value} 条` }))} /></label><button type="button" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={page <= 1 || loading} title="上一页" aria-label="上一页" className="p-1.5 hover:bg-white/70 rounded-md"><ChevronLeft className="w-4 h-4" /></button><span className="text-center">第 {page} / {totalPages} 页</span><button type="button" onClick={() => setPage((current) => Math.min(totalPages, current + 1))} disabled={page >= totalPages || loading} title="下一页" aria-label="下一页" className="p-1.5 hover:bg-white/70 rounded-md"><ChevronRight className="w-4 h-4" /></button><label className="flex items-center gap-1">跳至<input type="number" min="1" max={totalPages} value={pageJump} onChange={event => setPageJump(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') applyPageJump(); }} className="field h-8 w-16 px-2 text-center" aria-label="跳转到库存页码" />页</label><button type="button" onClick={applyPageJump} disabled={loading} className="btn-ghost px-2 py-1">跳转</button></div>
          </footer>
        )}
      </section>

      {selected && active && (
        <div className="fixed inset-x-0 bottom-0 top-[100px] z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="库存详情">
          <button type="button" onClick={closeDetails} className="absolute inset-0 bg-ink-deep/20 backdrop-blur-[2px]" aria-label="关闭详情" />
          <aside className="drawer-panel relative z-10 flex h-full w-full max-w-[480px] flex-col bg-paper/95 backdrop-blur-xl shadow-2xl">
            <header className="flex items-start justify-between border-b border-line px-5 py-4"><div><div className="flex items-center gap-2"><h2 className="text-base font-semibold text-ink-deep">库存详情</h2><span className={statusClass(selected.status)} style={itemStatusStyle(selected)}>{itemStatusLabel(selected)}</span></div><div className="mt-1 flex items-center gap-1"><p className="font-mono text-[12px] text-ink-soft">{selected.sn}</p><CopyTextButton value={selected.sn} label="SN" /></div></div><button type="button" onClick={closeDetails} title="关闭" aria-label="关闭" className="p-2 text-ink-soft hover:bg-white/70 rounded-lg"><X className="w-4 h-4" /></button></header>

            <div className="flex-1 overflow-y-auto p-5">
              {selected.itemNumber && <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-line/70 bg-white/60 px-3 py-2 text-xs"><dl><DetailField label="编号" value={selected.itemNumber} /></dl><CopyTextButton value={selected.itemNumber} label="编号" /></div>}
              <div className="mb-5 rounded-xl border border-line/70 bg-white/45 p-4"><div className="mb-3 flex items-center gap-2 text-[13px] font-medium text-ink-deep"><Pencil className="w-4 h-4 text-primary" />{productName(selected)}</div><dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-[12px]"><DetailField label="所在仓库" value={selected.warehouseName || warehouses.find(w => w.id === selected.warehouseId)?.name} /><DetailField label="产品类型" value={selected.productType} /><DetailField label="品牌型号" value={productName(selected)} /><DetailField label="采购价格" value={formatMoney(selected.purchasePrice)} /><DetailField label="CPU" value={formatCPUDisplay(selected.cpu)} /><DetailField label="内存" value={selected.ram} /><DetailField label="显卡" value={formatGPUDisplay(selected.gpu)} /><DetailField label="硬盘" value={selected.storage} /><DetailField label="屏幕" value={formatScreenDisplay(selected.screen)} /><DetailField label="触屏" value={selected.touchScreen === null ? '未填写' : selected.touchScreen ? '是' : '否'} /><DetailField label="供应商" value={selected.supplierName} /><DetailField label="采购单号" value={selected.purchaseNo} /><DetailField label="入库日期" value={formatDate(selected.inboundDate)} /><DetailField label={selected.status === 'in_stock' || selected.status === 'custom' ? '在库天数' : '入库距今'} value={`${Math.max(0, Number(selected.inboundDays || 0))} 天`} />{selected.soldDate && <DetailField label="售出日期" value={formatDate(selected.soldDate)} />}{selected.sellingPrice !== null && <DetailField label="销售价格" value={formatMoney(selected.sellingPrice)} />}</dl></div>
              <section className="mb-5 rounded-xl border border-primary/15 bg-primary/5 p-4"><p className="text-xs text-ink-soft">当前去向</p><p className="mt-2 text-sm text-ink-deep">{machineDestination(selected)}</p>{selected.afterSaleId && isAdmin && <Link href={`/after-sales?recordId=${encodeURIComponent(selected.afterSaleId)}`} className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium text-primary">查看关联售后单 {selected.afterSaleNo}</Link>}{isAdmin && <Link href={`/sales/records?search=${encodeURIComponent(selected.sn)}`} className="mt-3 flex text-xs font-medium text-primary">查询本机销售历史</Link>}</section>{selected.statusRecord && <section className="mb-5 rounded-xl border border-line/70 bg-white/60 p-4"><h3 className="mb-3 text-sm font-medium">当前状态登记</h3><dl className="grid grid-cols-2 gap-3 text-xs"><DetailField label="原因" value={selected.statusRecord.reason} /><DetailField label="当前地点" value={selected.statusRecord.location} /><DetailField label="负责人" value={selected.statusRecord.responsiblePerson} /><DetailField label="预计归还" value={formatDate(selected.statusRecord.expectedReturnDate)} /><DetailField label="登记时间" value={formatDate(selected.statusRecord.createdAt || selected.statusRecord.startedAt)} /><DetailField label="业务权限" value={selected.allowStockOperations ? '允许参与在库业务' : '暂停参与在库业务'} /></dl>{selected.statusRecord.remark && <p className="mt-3 whitespace-pre-wrap text-xs text-ink-soft">{selected.statusRecord.remark}</p>}</section>}
              <div className="mb-4 flex flex-wrap gap-2">{canEditInventory && <button type="button" className="btn-ghost inline-flex items-center gap-1.5" onClick={openMachineEditor}><Pencil className="h-4 w-4" />编辑机器资料</button>}{isAdmin && (selected.status === 'in_stock' || selected.status === 'custom') && <>{selected.status === 'in_stock' && <button type="button" className="btn-ghost inline-flex items-center gap-1.5" onClick={() => setAssetChangeMachine(selected)}><MemoryStick className="h-4 w-4" />资产变更</button>}<button type="button" className="btn-ghost inline-flex items-center gap-1.5" onClick={() => setStatusDialog({ mode: selected.status === 'custom' ? 'restore' : 'register', machine: selected })}><Wrench className="h-4 w-4" />{selected.status === 'custom' ? '恢复在库' : '登记机器状态'}</button>{isSystemAccount && selected.status === 'in_stock' && <button type="button" className="inline-flex items-center gap-1.5 rounded-lg border border-danger/20 px-3 py-2 text-xs text-danger transition hover:bg-danger/5" onClick={() => setPurgeMachine(selected)}><Trash2 className="h-4 w-4" />永久删除</button>}</>}</div>
              <label htmlFor="inventory-remark" className="mb-2 block text-[13px] font-medium text-ink-deep">备注</label><textarea id="inventory-remark" value={remark} onChange={(event) => setRemark(event.target.value)} rows={5} placeholder="添加库存备注" disabled={!canEditInventory} className="field resize-y" />
              {remarkError && <p role="alert" className="mt-2 text-[12px] text-danger">{remarkError}</p>}
              {!canEditInventory && <p className="mt-2 text-[11px] text-ink-soft">此账号仅可查看机器资料。</p>}
              {selected.skuRemark && <div className="mt-4 rounded-lg bg-primary/5 px-3 py-2 text-[12px] text-ink-soft">SKU 补充信息：{selected.skuRemark}</div>}
              <section className="mt-5 rounded-xl border border-line/70 bg-white/45 p-4"><div className="mb-3 flex items-center gap-2 text-[13px] font-medium text-ink-deep"><History className="h-4 w-4 text-primary" />机器资料修改记录</div>{machineEditHistoryLoading ? <p className="text-xs text-ink-soft">加载中...</p> : machineEditHistoryError ? <p role="alert" className="text-xs text-danger">{machineEditHistoryError}</p> : machineEditHistory.length === 0 ? <p className="text-xs text-ink-soft">暂无资料修改记录</p> : <div className="space-y-3">{machineEditHistory.map(entry => <article key={entry.id} className="border-t border-line/60 pt-3 first:border-0 first:pt-0"><p className="text-[11px] text-ink-soft">{entry.createdAt?.replace('T', ' ').slice(0, 16) || '-'} · {entry.actorName || '未知操作人'}</p><ul className="mt-2 space-y-1">{inventoryEditFields.filter(([field]) => String(entry.beforeData?.[field] ?? '') !== String(entry.afterData?.[field] ?? '')).map(([field, label]) => <li key={field} className="break-words text-[11px] leading-5 text-ink-deep"><span className="text-ink-soft">{label}：</span>{String(entry.beforeData?.[field] ?? '空')}<span className="px-1 text-primary">→</span>{String(entry.afterData?.[field] ?? '空')}</li>)}</ul></article>)}</div>}</section>
              <InventoryMovementTimeline key={`${selected.id}:${movementRevision}`} inventoryId={selected.id} />
            </div>

            <footer className="flex items-center justify-end gap-3 border-t border-line px-5 py-4">{saved && <span className="mr-auto inline-flex items-center gap-1 text-[12px] text-success"><Check className="w-3.5 h-3.5" />已保存</span>}<button type="button" onClick={closeDetails} disabled={savingRemark || savingMachineEdit} className="btn-ghost">关闭</button>{!isViewer && <button type="button" onClick={saveRemark} disabled={savingRemark || !canEditInventory} className="btn-primary inline-flex items-center gap-1.5"><Save className="w-4 h-4" />{savingRemark ? '保存中...' : '保存备注'}</button>}</footer>
          </aside>
        </div>
      )}
      {selected && machineEditOpen && machineEditDraft && <BusinessDialog title="编辑机器资料" description={`仅修改当前机器档案，不改写采购单和既有业务快照。SN：${selected.sn}`} onClose={closeMachineEditor} footer={<><button type="button" className="btn-ghost" onClick={closeMachineEditor} disabled={savingMachineEdit}>取消</button><button type="submit" form="inventory-machine-edit" className="btn-primary inline-flex items-center gap-1.5" disabled={savingMachineEdit || !machineEditDirty}><Save className="h-4 w-4" />{savingMachineEdit ? '保存中...' : '保存资料'}</button></>}>
        <form id="inventory-machine-edit" onSubmit={saveMachineEdit} className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">{inventoryEditFields.map(([field, label, placeholder]) => <label key={field} className="block min-w-0 text-xs font-medium text-ink-deep">{label}{['sn', 'productType', 'brand', 'model', 'purchasePrice'].includes(field) && <span className="ml-1 text-danger">*</span>}{field === 'productType' ? <div className="mt-1.5"><CustomSelect aria-label="机器产品类型" value={machineEditDraft.productType} onChange={value => { setMachineEditDraft(current => current ? { ...current, productType: value } : current); setMachineEditError(''); }} options={machineEditProductTypeOptions.map(value => ({ value, label: value }))} /></div> : field === 'brand' ? <div className="mt-1.5"><CustomSelect aria-label="机器品牌" value={machineEditDraft.brand} onChange={value => { setMachineEditDraft(current => current ? { ...current, brand: value } : current); setMachineEditError(''); }} options={machineEditBrandOptions.map(value => ({ value, label: value }))} searchable /></div> : <input type={field === 'year' || field === 'purchasePrice' ? 'number' : 'text'} min={field === 'year' ? 1900 : field === 'purchasePrice' ? 0 : undefined} max={field === 'year' ? 2100 : field === 'purchasePrice' ? 1_000_000_000 : undefined} step={field === 'purchasePrice' ? '0.01' : undefined} maxLength={field === 'year' || field === 'purchasePrice' ? undefined : field === 'sn' ? 120 : 160} value={machineEditDraft[field]} onChange={event => { setMachineEditDraft(current => current ? { ...current, [field]: event.target.value } : current); setMachineEditError(''); }} placeholder={placeholder} className="field mt-1.5" />}</label>)}
            <label className="block text-xs font-medium text-ink-deep">触屏<div className="mt-1.5"><CustomSelect aria-label="机器触屏状态" value={machineEditDraft.touchScreen} onChange={value => { setMachineEditDraft(current => current ? { ...current, touchScreen: value } : current); setMachineEditError(''); }} options={[{ value: '', label: '未记录' }, { value: '0', label: '非触屏' }, { value: '1', label: '触屏' }]} /></div></label>
          </div>
          <p className="text-[11px] leading-5 text-ink-soft">屏幕规格保留自定义输入；修改后列表会显示新档案，既有业务记录仍按原快照追溯。</p>
          {machineEditError && <p role="alert" className="rounded-lg border border-danger/15 bg-danger/5 p-3 text-xs text-danger">{machineEditError}</p>}
        </form>
      </BusinessDialog>}
      <ConfirmDialog isOpen={machineEditDiscardConfirm} title="放弃机器资料修改？" message="关闭后，本次尚未保存的机器资料修改将被清除。" confirmText="关闭并放弃" cancelText="继续编辑" danger onCancel={() => setMachineEditDiscardConfirm(false)} onConfirm={() => { setMachineEditDiscardConfirm(false); setMachineEditOpen(false); setMachineEditDraft(null); setMachineEditError(''); }} />
      {assetChangeMachine && <InventoryAssetChangeDialog key={assetChangeMachine.id} machine={assetChangeMachine} onClose={() => setAssetChangeMachine(null)} onSaved={assetChanged} />}
      <ConfirmDialog isOpen={Boolean(pendingAssetPrintId)} title={assetPrintError ? '更新后的标签打印失败' : '资产变更完成，是否打印更新后的标签？'} message={assetPrintError ? `资产变更已保存。${assetPrintError}` : '标签将使用这台机器最新的内存和硬盘信息，并按默认标签模板打印。'} confirmText={printing || assetPrintBusy ? '准备打印…' : assetPrintError ? '重试打印' : '打印更新后的标签'} cancelText="暂不打印" onConfirm={() => { void printUpdatedAssetLabel(); }} onCancel={() => { if (!printing && !assetPrintBusy) { setPendingAssetPrintId(null); setAssetPrintError(''); } }} />
      {statusDialog && <InventoryStatusDialog key={`${statusDialog.mode}:${statusDialog.machine?.id || statusDialog.machines?.map(item => item.id).join(',') || 'new'}`} mode={statusDialog.mode} machine={statusDialog.machine} machines={statusDialog.machines} pinnedStatusIds={pinnedStatusIds} onTogglePin={togglePinnedStatus} onClose={() => setStatusDialog(null)} onChanged={statusChanged} />}
      {purgeMachine && <InventoryPurgeDialog key={purgeMachine.id} machine={purgeMachine} onClose={() => setPurgeMachine(null)} onDeleted={() => { setPurgeMachine(null); setSelected(null); setCheckedIds(current => { const next = new Set(current); next.delete(purgeMachine.id); return next; }); setCheckedMachines(current => { const next = new Map(current); next.delete(purgeMachine.id); return next; }); setReloadKey(current => current + 1); }} />}
      {exportOpen && <BusinessDialog title="导出库存" description="服务端会重新查询并检查仓库权限；导出设置不会改变日常表格列。" onClose={() => { if (!exportBusy) setExportOpen(false); }} footer={<><button type="button" className="btn-ghost" onClick={() => setExportOpen(false)} disabled={exportBusy}>取消</button><button type="button" className="btn-primary inline-flex items-center gap-1.5" onClick={() => void downloadInventoryExport()} disabled={exportBusy || exportPreviewLoading || !exportPreviewCount || !exportColumns.length}><FileDown className="h-4 w-4" />{exportBusy ? '正在生成…' : `导出 ${exportPreviewCount ?? 0} 台`}</button></>}>
        <div className="space-y-5">
          <fieldset>
            <legend className="mb-2 text-xs font-medium text-ink-deep">导出范围</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              <label className={`flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 transition ${exportMode === 'filtered' ? 'border-primary/40 bg-primary/5' : 'border-line/70 bg-white/60 hover:bg-white'}`}><input type="radio" name="inventory-export-mode" value="filtered" checked={exportMode === 'filtered'} onChange={() => setExportMode('filtered')} className="mt-0.5 accent-primary" /><span><span className="block text-xs font-medium text-ink-deep">当前筛选的全部机器</span><span className="mt-1 block text-[11px] text-ink-soft">忽略分页，导出所有符合条件的记录</span></span></label>
              <label className={`flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 transition ${exportMode === 'selected' ? 'border-primary/40 bg-primary/5' : 'border-line/70 bg-white/60 hover:bg-white'}`}><input type="radio" name="inventory-export-mode" value="selected" checked={exportMode === 'selected'} onChange={() => setExportMode('selected')} className="mt-0.5 accent-primary" /><span><span className="block text-xs font-medium text-ink-deep">仅导出所选机器</span><span className="mt-1 block text-[11px] text-ink-soft">已勾选 {checkedItems.length} 台；导出前会重新核对记录</span></span></label>
            </div>
          </fieldset>
          <section>
            <div className="mb-2 flex items-center justify-between gap-3"><h3 className="text-xs font-medium text-ink-deep">导出字段</h3><span className="text-[11px] text-ink-soft">默认跟随当前可见列 · 已选 {exportColumns.length} 项</span></div>
            <div className="grid max-h-64 grid-cols-1 gap-x-4 gap-y-1 overflow-y-auto rounded-lg border border-line/70 bg-white/50 p-3 sm:grid-cols-2">
              {INVENTORY_TABLE_COLUMN_DEFINITIONS.map(column => <label key={column.key} className="flex min-w-0 items-center gap-2 rounded px-1.5 py-1.5 text-xs text-ink-deep hover:bg-primary/5"><input type="checkbox" checked={exportColumns.includes(column.key)} onChange={() => toggleExportColumn(column.key)} className="accent-primary" /><span className="truncate">{column.label}</span></label>)}
            </div>
          </section>
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line/70 bg-white/60 px-3 py-2.5 text-xs" aria-live="polite"><span className="text-ink-soft">预计导出</span><strong className="font-mono text-ink-deep">{exportPreviewLoading ? '正在统计…' : `${exportPreviewCount ?? 0} 台机器`}</strong></div>
          {exportError && <p role="alert" className="rounded-lg border border-danger/20 bg-danger/5 p-3 text-xs text-danger">{exportError}</p>}
        </div>
      </BusinessDialog>}
      {tableSettingsOpen && tablePreferencesHydrated && user?.id && <InventoryColumnSettingsDialog key={user.id} initialValue={tablePreferences} onClose={() => setTableSettingsOpen(false)} onSave={saveTablePreferences} />}
      </WorkspaceSection>
      {!isViewer && <WorkspaceSection active={activeWorkspace === 'transfers'}><TransfersWorkspace /></WorkspaceSection>}
    </div>
  );
}

function DetailField({ label, value }: { label: string; value: string | null | undefined }) {
  return <div className="min-w-0"><dt className="text-ink-soft">{label}</dt><dd className="mt-0.5 truncate text-ink-deep">{value || '-'}</dd></div>;
}

function InventoryRemarks({ remark, skuRemark }: { remark: string | null; skuRemark: string | null }) {
  const machineRemark = remark?.trim();
  const skuNote = skuRemark?.trim();
  if (!machineRemark && !skuNote) return <span className="text-[11px] text-ink-soft">-</span>;

  const fullRemark = [machineRemark && `机器备注：${machineRemark}`, skuNote && `SKU备注：${skuNote}`]
    .filter(Boolean)
    .join('\n');

  return <div title={fullRemark} className="min-w-0 overflow-hidden text-[11px] leading-5 text-ink-soft">
    {machineRemark && <p className="truncate"><span className="font-medium text-ink-deep">机器备注：</span>{machineRemark}</p>}
    {skuNote && <p className="truncate"><span className="font-medium text-ink-deep">SKU备注：</span>{skuNote}</p>}
  </div>;
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

function FilterSelect({ label, value, options, onChange, disabled = false, emptyLabel }: { label: string; value: string; options: string[]; onChange: (value: string) => void; disabled?: boolean; emptyLabel?: string }) {
  const placeholder = emptyLabel || `全部${label}`;
  return <label className="block"><span className="mb-1.5 block text-[11px] text-ink-soft">{label}</span><CustomSelect value={value} onChange={onChange} options={[{ value: '', label: placeholder }, ...options.map((option) => ({ value: option, label: option }))]} placeholder={placeholder} searchable disabled={disabled} /></label>;
}
