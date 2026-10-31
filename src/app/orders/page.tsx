/**
 * 采购订单页面
 * 路径: /orders
 */
'use client';

import { useCallback, useRef, useState, useEffect } from 'react';
import { Plus, Search, Package, FileText, ArrowLeft, Pencil, Trash2, RefreshCw, CheckCircle2, Check, X } from 'lucide-react';
import SKUSelector, { SelectedConfig } from '@/components/SKUSelector';
import CustomSelect from '@/components/CustomSelect';
import ManualInput from '@/components/ManualInput';
import BatchInput from '@/components/BatchInput';
import ConfirmDialog from '@/components/ConfirmDialog';
import Toast from '@/components/Toast';
import { useInventoryLabelPrinter } from '@/components/InventoryLabelPrint';
import { useWorkspaceDirty } from '@/components/WorkspaceContext';
import { formatProductName } from '@/lib/product-name';
import { formatCPUDisplay, formatGPUDisplay, formatScreenDisplay } from '@/lib/sku-display';

interface PurchaseOrder {
  id: string;
  purchaseNo: string;
  supplierOrderNo: string;
  supplierName: string;
  purchaseDate: string;
  purchasedBy: string;
  totalAmount: number;
  totalQuantity: number;
  isInbounded: number;
  createdAt: string;
  itemCount?: number;
}

interface MachineItem {
  id: string;
  skuId?: string;
  manualSkuId?: string;
  productType: string;
  brand: string;
  model: string;
  year?: number;
  cpu: string;
  ram: string;
  gpu: string;
  storage: string;
  screen: string;
  touchScreen?: boolean; // 可选：用户可以不选择
  sn: string;
  purchasePrice: number;
  remark: string;
  skuRemark?: string; // SKU 补充信息
}

type MachinePayload = Omit<MachineItem, 'id'>;
type SupplierOption = { id: string; supplierName: string };
type BatchPresetConfig = Omit<MachinePayload, 'sn' | 'purchasePrice' | 'remark'>;

function localDateInput() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export default function OrdersPage() {
  const [orders, setOrders] = useState<PurchaseOrder[]>([]);
  const [suppliers, setSuppliers] = useState<SupplierOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [supplierFilter, setSupplierFilter] = useState('');
  const [purchaseDateFrom, setPurchaseDateFrom] = useState('');
  const [purchaseDateTo, setPurchaseDateTo] = useState('');
  const [amountMin, setAmountMin] = useState('');
  const [amountMax, setAmountMax] = useState('');
  const [isCreating, setIsCreating] = useState(false); // 是否处于新增/编辑模式
  const [editingOrderId, setEditingOrderId] = useState<string | null>(null);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [deleteOrderId, setDeleteOrderId] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [orderToast, setOrderToast] = useState<{ show: boolean; type: 'success' | 'error'; message: string }>({ show: false, type: 'success', message: '' });
  const [pendingPrintIds, setPendingPrintIds] = useState<string[]>([]);
  const [printPromptOpen, setPrintPromptOpen] = useState(false);
  const [printError, setPrintError] = useState('');
  const { printLabels, printing, printPortal } = useInventoryLabelPrinter();

  const printInboundLabels = async () => {
    setPrintPromptOpen(false);
    setPrintError('');
    try {
      await printLabels(pendingPrintIds);
      setPendingPrintIds([]);
    } catch (error) {
      setPrintError(error instanceof Error ? error.message : '打开打印失败，请重试');
    }
  };

  const loadOrders = useCallback(async () => {
    try {
      setLoading(true);
      const params = new URLSearchParams({ page: '1', pageSize: '100' });
      if (search.trim()) params.set('search', search.trim());
      if (statusFilter) params.set('isInbounded', statusFilter);
      if (supplierFilter) params.set('supplierId', supplierFilter);
      if (purchaseDateFrom) params.set('purchaseDateFrom', purchaseDateFrom);
      if (purchaseDateTo) params.set('purchaseDateTo', purchaseDateTo);
      if (amountMin.trim()) params.set('amountMin', amountMin.trim());
      if (amountMax.trim()) params.set('amountMax', amountMax.trim());
      const response = await fetch(`/api/purchase-orders?${params.toString()}`);
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error?.message || '加载采购单失败');
      setOrders(result.data.items || []);
    } catch (error) {
      console.error('加载采购单失败:', error);
    } finally {
      setLoading(false);
    }
  }, [search, statusFilter, supplierFilter, purchaseDateFrom, purchaseDateTo, amountMin, amountMax]);

  useEffect(() => {
    let cancelled = false;
    const loadSuppliers = async () => {
      try {
        const response = await fetch('/api/suppliers?page=1&pageSize=100&status=active');
        const result = await response.json();
        if (response.ok && result.success && !cancelled) {
          setSuppliers((result.data.items || []) as SupplierOption[]);
        }
      } catch (error) {
        console.error('加载供应商筛选项失败:', error);
      }
    };
    void loadSuppliers();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (isCreating) return;
    const timer = window.setTimeout(() => { void loadOrders(); }, 250);
    return () => window.clearTimeout(timer);
  }, [isCreating, loadOrders]);

  // 新增采购单
  const handleAddOrder = () => {
    setEditingOrderId(null);
    setIsCreating(true);
  };

  const handleEditOrder = (id: string) => {
    setEditingOrderId(id);
    setIsCreating(true);
  };

  // 取消新增
  const handleCancelCreate = () => {
    setShowCancelConfirm(true);
  };

  // 确认取消
  const confirmCancel = () => {
    setShowCancelConfirm(false);
    setIsCreating(false);
    setEditingOrderId(null);
  };

  const handleDeleteOrder = async (id: string) => {
    setDeleteOrderId(id);
  };

  const confirmDeleteOrder = async () => {
    if (!deleteOrderId || deleteBusy) return;
    try {
      setDeleteBusy(true);
      const response = await fetch(`/api/purchase-orders?id=${encodeURIComponent(deleteOrderId)}`, { method: 'DELETE' });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error?.message || '删除失败');
      setOrderToast({ show: true, type: 'success', message: '采购草稿已删除' });
      setDeleteOrderId(null);
      await loadOrders();
    } catch (error) {
      setOrderToast({ show: true, type: 'error', message: error instanceof Error ? error.message : '删除失败，请重试' });
    } finally {
      setDeleteBusy(false);
    }
  };

  const clearFilters = () => {
    setSearch('');
    setStatusFilter('');
    setSupplierFilter('');
    setPurchaseDateFrom('');
    setPurchaseDateTo('');
    setAmountMin('');
    setAmountMax('');
  };

  const hasOrderFilters = Boolean(
    search.trim() || statusFilter || supplierFilter || purchaseDateFrom || purchaseDateTo || amountMin || amountMax
  );

  // 如果处于新增模式，显示表单
  if (isCreating) {
    return (
      <>
        <div className="max-w-[1400px] mx-auto">
          <PurchaseOrderForm
            onCancel={handleCancelCreate}
            orderId={editingOrderId}
            onSuccess={(result) => {
              setIsCreating(false);
              setEditingOrderId(null);
              if (result.inventoryIds.length > 0) {
                setPendingPrintIds(result.inventoryIds);
                setPrintPromptOpen(true);
              }
            }}
          />
        </div>
        
        {/* 取消确认对话框 */}
        <ConfirmDialog
          isOpen={showCancelConfirm}
          title="确认返回"
          message="确定要返回列表吗？未保存的数据将丢失。"
          confirmText="确定返回"
          cancelText="继续编辑"
          onConfirm={confirmCancel}
          onCancel={() => setShowCancelConfirm(false)}
          danger={true}
        />
      </>
    );
  }

  // 否则显示列表
  return (
    <div className="max-w-[1400px] mx-auto">
      {printPortal}
      <ConfirmDialog
        isOpen={printPromptOpen}
        title="入库成功，是否打印标签？"
        message={`本次已入库 ${pendingPrintIds.length} 台机器，使用默认标签模板打印。`}
        confirmText="确认打印"
        cancelText="暂不打印"
        onConfirm={() => { void printInboundLabels(); }}
        onCancel={() => { setPrintPromptOpen(false); }}
      />
      <ConfirmDialog
        isOpen={Boolean(deleteOrderId)}
        title="删除采购草稿"
        message="确定删除这个采购草稿吗？已入库的采购单不能删除。"
        confirmText={deleteBusy ? '正在删除…' : '删除草稿'}
        cancelText="取消"
        onConfirm={() => { void confirmDeleteOrder(); }}
        onCancel={() => { if (!deleteBusy) setDeleteOrderId(null); }}
        danger
      />
      <Toast isOpen={orderToast.show} type={orderToast.type} message={orderToast.message} onClose={() => setOrderToast({ show: false, type: 'success', message: '' })} />
      {(printing || printError || pendingPrintIds.length > 0) && !printPromptOpen && (
        <div role="status" className={`mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3 text-[13px] ${printError ? 'border-danger/20 bg-danger/5 text-danger' : 'border-primary/20 bg-primary/5 text-ink-soft'}`}>
          <span>{printing ? '正在准备标签并打开打印窗口…' : printError || `入库成功，可打印本次 ${pendingPrintIds.length} 张标签`}</span>
          {!printing && <button type="button" onClick={() => { void printInboundLabels(); }} className="btn-ghost !py-1.5">{printError ? '重试打印' : '打印标签'}</button>}
        </div>
      )}
      {/* 页面标题 */}
      <header className="mb-6">
        <h1 className="text-xl font-bold tracking-wide text-ink-deep mb-2">
          采购订单
        </h1>
        <p className="text-[13px] text-ink-soft">
          管理采购单和机器录入，支持草稿保存和批量入库
        </p>
      </header>

      {/* 操作栏 */}
      <div className="sticky top-2 z-20 glass p-4 mb-4 shadow-sm">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[220px] max-w-xl">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-soft" />
            <input
              type="text"
              placeholder="搜索采购单号、供应商、供应商采购单号"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') void loadOrders(); }}
              className="w-full pl-10 pr-4 py-2.5 bg-white/60 border border-line rounded-lg text-[13px]
                       placeholder:text-ink-soft/50 focus:outline-none focus:ring-2 focus:ring-primary/20
                       focus:border-primary transition-all"
            />
          </div>
          <button
            type="button"
            onClick={() => void loadOrders()}
            disabled={loading}
            className="p-2.5 text-ink-soft hover:text-primary hover:bg-white/60 border border-line/70 rounded-lg transition-all disabled:opacity-50"
            title="刷新"
            aria-label="刷新采购订单"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button
            onClick={handleAddOrder}
            className="flex items-center gap-2 px-4 py-2.5 bg-primary text-white rounded-lg
                     text-[13px] font-medium hover:bg-primary-hover transition-all ripple-hover
                     shadow-sm hover:shadow-md"
          >
            <Plus className="w-4 h-4" />
            新增采购单
          </button>
        </div>

        <div className="mt-3 grid grid-cols-2 md:grid-cols-3 xl:grid-cols-7 gap-3 items-end">
          <label className="block">
            <span className="block mb-1.5 text-[11px] text-ink-soft">状态</span>
            <CustomSelect
              value={statusFilter}
              onChange={setStatusFilter}
              options={[
                { value: '', label: '全部状态' },
                { value: '0', label: '草稿' },
                { value: '1', label: '已入库' },
              ]}
              placeholder="全部状态"
            />
          </label>
          <label className="block col-span-2 md:col-span-1">
            <span className="block mb-1.5 text-[11px] text-ink-soft">供应商</span>
            <CustomSelect
              value={supplierFilter}
              onChange={setSupplierFilter}
              options={[
                { value: '', label: '全部供应商' },
                ...suppliers.map((supplier) => ({ value: supplier.id, label: supplier.supplierName })),
              ]}
              placeholder="全部供应商"
              searchable
            />
          </label>
          <label className="block">
            <span className="block mb-1.5 text-[11px] text-ink-soft">采购日期起</span>
            <input
              type="date"
              value={purchaseDateFrom}
              onChange={(event) => setPurchaseDateFrom(event.target.value)}
              className="w-full min-w-0 px-3 py-[11px] bg-white/60 border border-line rounded-lg text-[12px]
                       focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all"
            />
          </label>
          <label className="block">
            <span className="block mb-1.5 text-[11px] text-ink-soft">采购日期止</span>
            <input
              type="date"
              value={purchaseDateTo}
              onChange={(event) => setPurchaseDateTo(event.target.value)}
              className="w-full min-w-0 px-3 py-[11px] bg-white/60 border border-line rounded-lg text-[12px]
                       focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all"
            />
          </label>
          <label className="block">
            <span className="block mb-1.5 text-[11px] text-ink-soft">最低金额</span>
            <input
              type="number"
              min="0"
              step="0.01"
              inputMode="decimal"
              value={amountMin}
              onChange={(event) => setAmountMin(event.target.value)}
              placeholder="不限"
              className="w-full min-w-0 px-3 py-[11px] bg-white/60 border border-line rounded-lg text-[12px]
                       placeholder:text-ink-soft/50 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all"
            />
          </label>
          <div className="flex items-end gap-2 col-span-2 md:col-span-1 xl:col-span-2">
            <label className="block flex-1 min-w-0">
              <span className="block mb-1.5 text-[11px] text-ink-soft">最高金额</span>
              <input
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                value={amountMax}
                onChange={(event) => setAmountMax(event.target.value)}
                placeholder="不限"
                className="w-full min-w-0 px-3 py-[11px] bg-white/60 border border-line rounded-lg text-[12px]
                         placeholder:text-ink-soft/50 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all"
              />
            </label>
            {hasOrderFilters && (
              <button
                type="button"
                onClick={clearFilters}
                className="shrink-0 px-2.5 py-2.5 text-[12px] text-ink-soft hover:text-primary hover:bg-white/60 rounded-lg transition-all"
              >
                清空条件
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="glass overflow-hidden">
        {loading ? (
          <div className="p-12 text-center text-[13px] text-ink-soft">正在加载采购单...</div>
        ) : orders.length === 0 ? (
          <div className="p-12 text-center">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-primary-alpha-12 mb-4">
              <Package className="w-8 h-8 text-primary" />
            </div>
            <p className="text-ink-soft text-[13px] mb-4">{hasOrderFilters ? '没有符合条件的采购单' : '暂无采购订单数据，点击右上角新增采购单'}</p>
            <p className="text-[12px] text-ink-soft/60">{hasOrderFilters ? '请调整或清空筛选条件' : '等待准备入库的采购单会显示在这里'}</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead className="bg-paper/60 border-b border-line">
                <tr className="text-[12px] text-ink-soft">
                  <th className="px-4 py-3 font-medium">采购单号</th>
                  <th className="px-4 py-3 font-medium">供应商</th>
                  <th className="px-4 py-3 font-medium">采购日期</th>
                  <th className="px-4 py-3 font-medium">数量</th>
                  <th className="px-4 py-3 font-medium">金额</th>
                  <th className="px-4 py-3 font-medium">状态</th>
                  <th className="px-4 py-3 font-medium text-right">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line/60">
                {orders.map((order) => (
                  <tr key={order.id} className="text-[13px] text-ink hover:bg-white/50">
                    <td className="px-4 py-3 font-medium text-ink-deep">{order.purchaseNo}</td>
                    <td className="px-4 py-3">{order.supplierName}</td>
                    <td className="px-4 py-3 text-ink-soft">{order.purchaseDate}</td>
                    <td className="px-4 py-3">{order.totalQuantity} 台</td>
                    <td className="px-4 py-3">¥{Number(order.totalAmount || 0).toFixed(2)}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] ${order.isInbounded ? 'bg-success/10 text-success' : 'bg-warning/10 text-warning'}`}>
                        {order.isInbounded ? <CheckCircle2 className="w-3 h-3" /> : null}
                        {order.isInbounded ? '已入库' : '草稿'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        {!order.isInbounded && (
                          <>
                            <button type="button" onClick={() => handleEditOrder(order.id)} className="inline-flex items-center gap-1 px-2 py-1.5 text-[12px] text-primary hover:bg-primary/10 rounded-md" title="继续编辑">
                              <Pencil className="w-3.5 h-3.5" />继续编辑
                            </button>
                            <button type="button" onClick={() => handleDeleteOrder(order.id)} className="p-1.5 text-danger hover:bg-danger/10 rounded-md" title="删除草稿">
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 采购单表单组件（内嵌在页面中）
 */
interface PurchaseOrderFormProps {
  onCancel: () => void;
  orderId: string | null;
  onSuccess: (result: { inventoryIds: string[] }) => void;
}

function PurchaseOrderForm({ onCancel, orderId, onSuccess }: PurchaseOrderFormProps) {
  const [suppliers, setSuppliers] = useState<SupplierOption[]>([]);
  const [formData, setFormData] = useState({
    supplierId: '',
    supplierOrderNo: '',
    purchaseDate: localDateInput(),
    purchasedBy: '当前用户',
    remark: ''
  });
  const [machineItems, setMachineItems] = useState<MachineItem[]>([]);
  const [baseline, setBaseline] = useState(() => JSON.stringify({ formData, machineItems }));
  const loadedOrder = useRef<string | null>(null);
  const [showInboundConfirm, setShowInboundConfirm] = useState(false);
  const submitLock = useRef(false);
  const [showSKUSelector, setShowSKUSelector] = useState(false);
  const [showManualInput, setShowManualInput] = useState(false);
  const [showBatchInput, setShowBatchInput] = useState(false);
  const [batchPresetConfig, setBatchPresetConfig] = useState<BatchPresetConfig | null>(null); // 批量输入的预设配置
  const [editingMachineId, setEditingMachineId] = useState<string | null>(null);
  const [editingMachineDraft, setEditingMachineDraft] = useState<MachineItem | null>(null);
  const [saving, setSaving] = useState(false); // 保存中状态
  useWorkspaceDirty(JSON.stringify({ formData, machineItems }) !== baseline || showSKUSelector || showManualInput || showBatchInput || editingMachineDraft !== null);
  const [toast, setToast] = useState<{ show: boolean; type: 'success' | 'error' | 'warning' | 'info'; message: string }>({
    show: false,
    type: 'success',
    message: ''
  });

  useEffect(() => {
    if (!orderId || loadedOrder.current === orderId) return;
    const controller = new AbortController();
    const loadOrder = async () => {
      try {
        const response = await fetch(`/api/purchase-orders?id=${encodeURIComponent(orderId)}`, { signal: controller.signal });
        const result = await response.json();
        if (!result.success) throw new Error(result.error?.message || '加载采购单失败');
        if (controller.signal.aborted) return;
        const order = result.data;
        const loadedForm = {
          supplierId: order.supplierId || '',
          supplierOrderNo: order.supplierOrderNo || '',
          purchaseDate: order.purchaseDate || localDateInput(),
          purchasedBy: order.purchasedBy || '当前用户',
          remark: order.remark || '',
        };
        const loadedItems = (order.items || []).map((item: MachineItem, index: number) => ({
          ...item,
          id: item.id || `loaded_${index}_${Date.now()}`,
          skuId: item.skuId || undefined,
          manualSkuId: item.manualSkuId || undefined,
          productType: item.productType || '笔记本电脑',
          brand: item.brand || '',
          model: item.model || '',
          year: item.year === null || item.year === undefined ? undefined : Number(item.year),
          cpu: item.cpu || '',
          ram: item.ram || '',
          gpu: item.gpu || '',
          storage: item.storage || '',
          screen: item.screen || '',
          touchScreen: item.touchScreen,
          sn: item.sn || '',
          purchasePrice: Number(item.purchasePrice) || 0,
          remark: item.remark || '',
          skuRemark: item.skuRemark || '',
        }));
        loadedOrder.current = orderId;
        setFormData(loadedForm);
        setMachineItems(loadedItems);
        setBaseline(JSON.stringify({ formData: loadedForm, machineItems: loadedItems }));
      } catch (error) {
        if (controller.signal.aborted) return;
        console.error('加载采购单详情失败:', error);
        setToast({ show: true, type: 'error', message: '加载采购单失败，请返回重试' });
      }
    };
    loadOrder();
    return () => controller.abort();
  }, [orderId]);

  // 加载供应商列表
  useEffect(() => {
    let cancelled = false;
    const loadSuppliers = async () => {
      try {
        const response = await fetch('/api/suppliers?pageSize=100&status=active');
        const result = await response.json();
        if (result.success && !cancelled) setSuppliers((result.data.items || []) as SupplierOption[]);
      } catch (error) {
        console.error('加载供应商失败:', error);
      }
    };
    void loadSuppliers();
    return () => { cancelled = true; };
  }, []);

  // 处理 SKU 选择完成 - 单台录入（现在包含 SN 和价格）
  const handleSKUSelectorComplete = (config: SelectedConfig, mode: 'close' | 'continue') => {
    const newItem: MachineItem = {
      id: 'temp_' + Date.now(),
      skuId: config.sku.id,
      productType: config.sku.productType,
      brand: config.sku.brand,
      model: config.sku.model,
      year: (config.sku as SelectedConfig['sku'] & { year?: number | null }).year ?? undefined,
      cpu: config.cpu,
      ram: config.ram,
      gpu: config.gpu,
      storage: config.storage,
      screen: config.screen,
      touchScreen: config.touchScreen,
      sn: config.sn || '',
      purchasePrice: config.purchasePrice || 0,
      remark: '',
      skuRemark: config.skuRemark // SKU 补充信息
    };
    
    setMachineItems((currentItems) => [...currentItems, newItem]);
    if (mode === 'close') {
      setShowSKUSelector(false);
    }
  };

  // 处理 SKU 选择完成 - 批量录入
  const handleSKUBatchSelect = (config: SelectedConfig) => {
    // 关闭 SKU 选择器，保存配置，打开批量输入
    setShowSKUSelector(false);
    setBatchPresetConfig({
      skuId: config.sku.id,
      productType: config.sku.productType,
      brand: config.sku.brand,
      model: config.sku.model,
      year: (config.sku as SelectedConfig['sku'] & { year?: number | null }).year ?? undefined,
      cpu: config.cpu,
      ram: config.ram,
      gpu: config.gpu,
      storage: config.storage,
      screen: config.screen,
      touchScreen: config.touchScreen,
      skuRemark: config.skuRemark
    });
    setShowBatchInput(true);
  };

  // 处理手工录入完成
  const handleManualInputComplete = (machine: MachinePayload, mode: 'close' | 'continue') => {
    const newItem: MachineItem = {
      id: 'temp_' + Date.now(),
      ...machine
    };
    
    setMachineItems((currentItems) => [...currentItems, newItem]);
    if (mode === 'close') {
      setShowManualInput(false);
    }
  };

  // 处理批量录入完成
  const handleBatchInputComplete = (machines: MachinePayload[], mode: 'close' | 'continue') => {
    const newItems: MachineItem[] = machines.map(machine => ({
      id: 'temp_' + Date.now() + '_' + Math.random(),
      ...machine
    }));
    
    setMachineItems((current) => [...current, ...newItems]);
    if (mode === 'close') {
      setShowBatchInput(false);
      setBatchPresetConfig(null);
    }
  };

  // 删除机器
  const handleRemoveMachine = (id: string) => {
    setMachineItems(machineItems.filter(item => item.id !== id));
    if (editingMachineId === id) {
      setEditingMachineId(null);
      setEditingMachineDraft(null);
    }
  };

  const handleEditMachine = (item: MachineItem) => {
    if (editingMachineId && editingMachineId !== item.id) return;
    setEditingMachineId(item.id);
    setEditingMachineDraft({ ...item });
  };

  const handleCancelMachineEdit = () => {
    setEditingMachineId(null);
    setEditingMachineDraft(null);
  };

  const updateEditingMachineDraft = <K extends keyof MachineItem>(field: K, value: MachineItem[K]) => {
    setEditingMachineDraft((draft) => draft ? { ...draft, [field]: value } : draft);
  };

  const handleSaveMachineEdit = () => {
    if (!editingMachineDraft) return;
    if (
      !editingMachineDraft.productType.trim() ||
      !editingMachineDraft.brand.trim() ||
      !editingMachineDraft.model.trim() ||
      !editingMachineDraft.cpu.trim() ||
      !editingMachineDraft.ram.trim() ||
      !editingMachineDraft.storage.trim()
    ) {
      setToast({ show: true, type: 'warning', message: '请填写产品类型、品牌、型号、CPU、内存和硬盘' });
      return;
    }
    if (!Number.isFinite(editingMachineDraft.purchasePrice) || editingMachineDraft.purchasePrice < 0) {
      setToast({ show: true, type: 'warning', message: '采购价格格式不正确' });
      return;
    }

    setMachineItems((items) => items.map((item) => (
      item.id === editingMachineDraft.id ? {
        ...editingMachineDraft,
        skuId: item.productType === editingMachineDraft.productType &&
          item.brand === editingMachineDraft.brand &&
          item.model === editingMachineDraft.model &&
          item.year === editingMachineDraft.year ? item.skuId : undefined,
      } : item
    )));
    handleCancelMachineEdit();
  };

  const validateBeforeSubmit = (inbound: boolean) => {
    if (!formData.supplierId) return '请选择供应商';
    if (!formData.purchaseDate) return '请选择采购时间';
    if (!formData.purchasedBy.trim()) return '请填写采购人';
    if (machineItems.length === 0) return '请至少添加一台机器';
    if (inbound) {
      if (machineItems.some((item) => !item.sn.trim())) return '请填写所有机器的 SN 序列号';
      if (machineItems.some((item) => !Number.isFinite(item.purchasePrice) || item.purchasePrice <= 0)) return '请填写所有机器的采购价格';
    }
    return null;
  };

  const submitOrder = async (action: 'draft' | 'inbound') => {
    if (submitLock.current) return;
    const validationError = validateBeforeSubmit(action === 'inbound');
    if (validationError) {
      setToast({ show: true, type: 'warning', message: validationError });
      return;
    }
    try {
      submitLock.current = true;
      setSaving(true);
      const response = await fetch('/api/purchase-orders', {
        method: orderId ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: orderId || undefined,
          supplierId: formData.supplierId,
          supplierOrderNo: formData.supplierOrderNo,
          purchaseDate: formData.purchaseDate,
          purchasedBy: formData.purchasedBy,
          remark: formData.remark,
          items: machineItems,
          status: action === 'inbound' ? 'completed' : 'draft',
          action,
        }),
      });
      const result = await response.json();
      if (!result.success) {
        setToast({ show: true, type: 'error', message: result.error?.message || '保存失败' });
        return;
      }
      setToast({ show: true, type: 'success', message: action === 'inbound' ? '入库成功' : '草稿保存成功' });
      const inventoryIds = Array.isArray(result.data?.inventoryIds)
        ? result.data.inventoryIds.filter((id: unknown): id is string => typeof id === 'string' && id.trim().length > 0)
        : [];
      setBaseline(JSON.stringify({ formData, machineItems }));
      onSuccess({ inventoryIds });
    } catch (error) {
      console.error('保存采购单失败:', error);
      setToast({ show: true, type: 'error', message: '保存失败，请重试' });
    } finally {
      submitLock.current = false;
      setSaving(false);
    }
  };

  const handleSaveDraft = () => submitOrder('draft');
  const handleConfirmInbound = () => {
    const validationError = validateBeforeSubmit(true);
    if (validationError) {
      setToast({ show: true, type: 'warning', message: validationError });
      return;
    }
    setShowInboundConfirm(true);
  };

  return (
    <>
      {/* 页面标题栏 */}
      <header className="mb-6">
        <div className="flex items-center gap-3">
          <button
            onClick={onCancel}
            className="p-2 hover:bg-paper rounded-lg transition-all ripple-hover"
          >
            <ArrowLeft className="w-5 h-5 text-ink" />
          </button>
          <div className="flex-1">
            <h1 className="text-xl font-bold tracking-wide text-ink-deep mb-1">
              {orderId ? '继续编辑采购单' : '新增采购单'}
            </h1>
            <p className="text-[13px] text-ink-soft">
              填写采购信息并添加机器明细
            </p>
          </div>
        </div>
      </header>

      {/* 表单内容 */}
      <div className="space-y-5">
        {/* 基础信息卡片 */}
        <div className="glass p-5 rounded-xl">
          <div className="flex items-center gap-2 mb-4">
            <FileText className="w-4 h-4 text-primary" />
            <h3 className="text-[15px] font-semibold text-ink-deep">基础信息</h3>
          </div>
          
          <div className="grid grid-cols-2 gap-4">
            {/* 供应商 */}
            <div>
              <label className="block text-[13px] font-medium text-ink-deep mb-2">
                供应商 <span className="text-danger">*</span>
              </label>
              <CustomSelect
                value={formData.supplierId}
                onChange={(value) => setFormData({ ...formData, supplierId: value })}
                options={suppliers.map(s => ({ value: s.id, label: s.supplierName }))}
                placeholder="请选择供应商"
                searchable
                required
              />
            </div>

            {/* 供应商采购单号 */}
            <div>
              <label className="block text-[13px] font-medium text-ink-deep mb-2">
                供应商采购单号 <span className="text-ink-soft font-normal">（选填）</span>
              </label>
              <input
                type="text"
                value={formData.supplierOrderNo}
                onChange={(e) => setFormData({ ...formData, supplierOrderNo: e.target.value })}
                placeholder="有供应商单号时填写"
                className="w-full px-4 py-2.5 bg-white/60 border border-line rounded-lg text-[13px]
                         placeholder:text-ink-soft/50 focus:outline-none focus:ring-2 
                         focus:ring-primary/20 focus:border-primary transition-all"
              />
            </div>

            {/* 采购时间 */}
            <div>
              <label className="block text-[13px] font-medium text-ink-deep mb-2">
                采购时间 <span className="text-danger">*</span>
              </label>
              <input
                type="date"
                value={formData.purchaseDate}
                onChange={(e) => setFormData({ ...formData, purchaseDate: e.target.value })}
                className="w-full px-4 py-2.5 bg-white/60 border border-line rounded-lg text-[13px]
                         focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary 
                         transition-all"
                required
              />
            </div>

            {/* 采购人 */}
            <div>
              <label className="block text-[13px] font-medium text-ink-deep mb-2">
                采购人 <span className="text-danger">*</span>
              </label>
              <input
                type="text"
                value={formData.purchasedBy}
                onChange={(e) => setFormData({ ...formData, purchasedBy: e.target.value })}
                className="w-full px-4 py-2.5 bg-white/60 border border-line rounded-lg text-[13px]
                         focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary 
                         transition-all"
                required
              />
            </div>

            {/* 备注 */}
            <div className="col-span-2">
              <label className="block text-[13px] font-medium text-ink-deep mb-2">
                备注
              </label>
              <textarea
                value={formData.remark}
                onChange={(e) => setFormData({ ...formData, remark: e.target.value })}
                placeholder="请输入备注信息"
                rows={3}
                className="w-full px-4 py-2.5 bg-white/60 border border-line rounded-lg text-[13px]
                         placeholder:text-ink-soft/50 focus:outline-none focus:ring-2 
                         focus:ring-primary/20 focus:border-primary transition-all resize-none"
              />
            </div>
          </div>
        </div>

        {/* PLACEHOLDER_FOR_MACHINE_LIST */}

        {/* 机器明细卡片 */}
        <div className="glass p-5 rounded-xl">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Package className="w-4 h-4 text-primary" />
              <h3 className="text-[15px] font-semibold text-ink-deep">机器明细</h3>
              <span className="text-[13px] text-ink-soft">
                ({machineItems.length} 台)
              </span>
            </div>
            
            {/* 添加机器按钮 */}
            <div className="flex gap-2">
              <button
                onClick={() => setShowSKUSelector(true)}
                className="flex items-center gap-2 px-3 py-1.5 bg-primary text-white rounded-lg 
                         text-[13px] font-medium hover:bg-primary-hover transition-all ripple-hover
                         shadow-sm"
              >
                <Plus className="w-4 h-4" />
                从 SKU 选择
              </button>
              <button
                onClick={() => setShowManualInput(true)}
                className="flex items-center gap-2 px-3 py-1.5 border border-line rounded-lg 
                         text-[13px] font-medium hover:bg-white/60 transition-all ripple-hover"
              >
                手工录入
              </button>
            </div>
          </div>

          {/* 机器列表 */}
          {machineItems.length === 0 ? (
            <div className="py-12 text-center">
              <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-primary-alpha-08 mb-3">
                <Package className="w-6 h-6 text-primary" />
              </div>
              <p className="text-[13px] text-ink-soft mb-2">
                暂未添加机器明细
              </p>
              <p className="text-[12px] text-ink-soft/60">
                点击上方按钮添加机器
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {machineItems.map((item, index) => (
                <div key={item.id} className="bg-white/60 p-4 rounded-lg border border-line">
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-2">
                        <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-primary text-white text-[11px] font-bold">
                          {index + 1}
                        </span>
                        <span className="text-[14px] font-semibold text-ink-deep">
                          {formatProductName(item)}
                          {item.skuRemark && (
                            <span className="text-ink-soft font-normal ml-2">({item.skuRemark})</span>
                          )}
                        </span>
                      </div>
                      <div className="text-[12px] text-ink-soft space-y-1">
                        <div>{formatCPUDisplay(item.cpu)} / {item.ram} / {item.storage}</div>
                        <div className="flex flex-wrap gap-2">
                          {item.screen && <span>屏幕: {formatScreenDisplay(item.screen)}</span>}
                          {item.gpu && <span>显卡: {formatGPUDisplay(item.gpu)}</span>}
                          {item.touchScreen !== undefined && (
                            <span>触屏: {item.touchScreen ? '是' : '否'}</span>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      {editingMachineId === item.id ? (
                        <>
                          <button
                            type="button"
                            onClick={handleSaveMachineEdit}
                            className="p-1.5 text-success hover:bg-success/10 rounded-lg transition-all"
                            title="保存机器配置"
                          >
                            <Check className="w-4 h-4" />
                          </button>
                          <button
                            type="button"
                            onClick={handleCancelMachineEdit}
                            className="p-1.5 text-ink-soft hover:bg-paper rounded-lg transition-all"
                            title="取消编辑"
                          >
                            <X className="w-4 h-4" />
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          onClick={() => handleEditMachine(item)}
                          disabled={editingMachineId !== null}
                          className="p-1.5 text-primary hover:bg-primary/10 rounded-lg transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                          title="编辑机器配置"
                        >
                          <Pencil className="w-4 h-4" />
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => handleRemoveMachine(item.id)}
                        className="p-1.5 hover:bg-danger/10 rounded-lg transition-all text-danger"
                        title="删除"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  </div>

                  {editingMachineId === item.id && editingMachineDraft ? (
                    <div className="space-y-4">
                      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                        {([
                          ['productType', '产品类型', '如：笔记本电脑'],
                          ['brand', '品牌', '如：ThinkPad'],
                          ['model', '型号', '如：T14 Gen3'],
                          ['cpu', 'CPU 处理器', '如：i5-1240P'],
                          ['ram', '内存', '如：16GB'],
                          ['gpu', '显卡', '选填'],
                          ['storage', '硬盘', '如：512GB'],
                          ['screen', '屏幕分辨率', '选填'],
                        ] as const).map(([field, label, placeholder]) => (
                          <label key={field} className="block">
                            <span className="block text-[12px] font-medium text-ink-deep mb-1.5">
                              {label}{['productType', 'brand', 'model', 'cpu', 'ram', 'storage'].includes(field) && <span className="text-danger"> *</span>}
                            </span>
                            <input
                              type="text"
                              value={editingMachineDraft[field] as string}
                              onChange={(event) => updateEditingMachineDraft(field, event.target.value)}
                              placeholder={placeholder}
                              readOnly={Boolean(editingMachineDraft.manualSkuId && ['productType', 'brand', 'model'].includes(field))}
                              className="w-full px-3 py-2 bg-white border border-line rounded-lg text-[13px] placeholder:text-ink-soft/50 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all"
                            />
                          </label>
                        ))}
                        <label className="block">
                          <span className="block text-[12px] font-medium text-ink-deep mb-1.5">型号年份</span>
                          <input
                            type="number"
                            min="1980"
                            max="2100"
                            value={editingMachineDraft.year || ''}
                            onChange={(event) => updateEditingMachineDraft('year', event.target.value ? Number(event.target.value) : undefined)}
                            readOnly={Boolean(editingMachineDraft.manualSkuId)}
                            placeholder="如：2020（可选）"
                            className="w-full px-3 py-2 bg-white border border-line rounded-lg text-[13px] placeholder:text-ink-soft/50 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all"
                          />
                        </label>
                      </div>
                      {editingMachineDraft.manualSkuId && <p className="text-[11px] text-ink-soft">品牌、型号与年份由独立手工 SKU 库管理；如需修改，请到手工 SKU 库更新档案。</p>}

                      <div>
                        <span className="block text-[12px] font-medium text-ink-deep mb-1.5">触屏</span>
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => updateEditingMachineDraft('touchScreen', editingMachineDraft.touchScreen === false ? undefined : false)}
                            className={`px-3 py-2 rounded-lg text-[12px] font-medium transition-all ${editingMachineDraft.touchScreen === false ? 'bg-primary text-white' : 'glass hover:bg-white/60'}`}
                          >
                            {editingMachineDraft.touchScreen === false && <Check className="w-3.5 h-3.5 inline mr-1" />}
                            非触屏
                          </button>
                          <button
                            type="button"
                            onClick={() => updateEditingMachineDraft('touchScreen', editingMachineDraft.touchScreen === true ? undefined : true)}
                            className={`px-3 py-2 rounded-lg text-[12px] font-medium transition-all ${editingMachineDraft.touchScreen === true ? 'bg-primary text-white' : 'glass hover:bg-white/60'}`}
                          >
                            {editingMachineDraft.touchScreen === true && <Check className="w-3.5 h-3.5 inline mr-1" />}
                            触屏
                          </button>
                          <span className="self-center text-[11px] text-ink-soft">可不选</span>
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-3">
                        <label className="block">
                          <span className="block text-[12px] font-medium text-ink-deep mb-1.5">SN 序列号</span>
                          <input
                            type="text"
                            value={editingMachineDraft.sn}
                            onChange={(event) => updateEditingMachineDraft('sn', event.target.value)}
                            placeholder="请输入 SN"
                            className="w-full px-3 py-2 bg-white border border-line rounded-lg text-[13px] placeholder:text-ink-soft/50 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all"
                          />
                        </label>
                        <label className="block">
                          <span className="block text-[12px] font-medium text-ink-deep mb-1.5">采购价格</span>
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            value={editingMachineDraft.purchasePrice || ''}
                            onChange={(event) => updateEditingMachineDraft('purchasePrice', Number(event.target.value) || 0)}
                            placeholder="请输入价格"
                            className="w-full px-3 py-2 bg-white border border-line rounded-lg text-[13px] placeholder:text-ink-soft/50 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all"
                          />
                        </label>
                      </div>

                      <div className="grid grid-cols-2 gap-3">
                        <label className="block">
                          <span className="block text-[12px] font-medium text-ink-deep mb-1.5">SKU 补充信息</span>
                          <input
                            type="text"
                            value={editingMachineDraft.skuRemark || ''}
                            onChange={(event) => updateEditingMachineDraft('skuRemark', event.target.value)}
                            placeholder="选填"
                            className="w-full px-3 py-2 bg-white border border-line rounded-lg text-[13px] placeholder:text-ink-soft/50 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all"
                          />
                        </label>
                        <label className="block">
                          <span className="block text-[12px] font-medium text-ink-deep mb-1.5">机器备注</span>
                          <input
                            type="text"
                            value={editingMachineDraft.remark}
                            onChange={(event) => updateEditingMachineDraft('remark', event.target.value)}
                            placeholder="选填"
                            className="w-full px-3 py-2 bg-white border border-line rounded-lg text-[13px] placeholder:text-ink-soft/50 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all"
                          />
                        </label>
                      </div>
                    </div>
                  ) : (
                    /* SN 和价格输入 */
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-[12px] font-medium text-ink-deep mb-1.5">
                          SN 序列号 <span className="text-danger">*</span>
                        </label>
                        <input
                          type="text"
                          value={item.sn}
                          onChange={(e) => {
                            const updated = [...machineItems];
                            updated[index].sn = e.target.value;
                            setMachineItems(updated);
                          }}
                          placeholder="请输入 SN"
                          className="w-full px-3 py-2 bg-white border border-line rounded-lg text-[13px]
                                   placeholder:text-ink-soft/50 focus:outline-none focus:ring-2 
                                   focus:ring-primary/20 focus:border-primary transition-all"
                        />
                      </div>
                      <div>
                        <label className="block text-[12px] font-medium text-ink-deep mb-1.5">
                          采购价格 <span className="text-danger">*</span>
                        </label>
                        <input
                          type="number"
                          value={item.purchasePrice || ''}
                          onChange={(e) => {
                            const updated = [...machineItems];
                            updated[index].purchasePrice = parseFloat(e.target.value) || 0;
                            setMachineItems(updated);
                          }}
                          placeholder="请输入价格"
                          className="w-full px-3 py-2 bg-white border border-line rounded-lg text-[13px]
                                   placeholder:text-ink-soft/50 focus:outline-none focus:ring-2 
                                   focus:ring-primary/20 focus:border-primary transition-all"
                        />
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 底部操作栏 */}
        <div className="glass p-4 flex items-center justify-between sticky bottom-0">
          <div className="text-[13px] text-ink-soft">
            已添加 <span className="font-semibold text-ink">{machineItems.length}</span> 台机器
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={onCancel}
              disabled={saving}
              className="px-4 py-2 text-[13px] font-medium text-ink hover:bg-white 
                       rounded-lg transition-all ripple-hover disabled:opacity-50 disabled:cursor-not-allowed"
            >
              取消
            </button>
            <button
              onClick={handleSaveDraft}
              disabled={saving}
              className="px-4 py-2 border border-line text-[13px] font-medium rounded-lg
                       hover:bg-white transition-all ripple-hover disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? '保存中...' : '保存草稿'}
            </button>
            <button
              onClick={handleConfirmInbound}
              disabled={machineItems.length === 0 || saving}
              className="px-4 py-2 bg-primary text-white text-[13px] font-medium rounded-lg
                       hover:bg-primary-hover transition-all ripple-hover shadow-sm hover:shadow-md
                       disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? '处理中...' : '确认入库并打印'}
            </button>
          </div>
        </div>
      </div>

      {/* SKU 选择器 */}
      {showSKUSelector && (
        <SKUSelector
          onSelect={handleSKUSelectorComplete}
          onBatchSelect={handleSKUBatchSelect}
          onCancel={() => setShowSKUSelector(false)}
          selectedMachineCount={machineItems.length}
        />
      )}

      {/* 手工录入 */}
      {showManualInput && (
        <ManualInput
          onConfirm={handleManualInputComplete}
          onCancel={() => setShowManualInput(false)}
          selectedMachineCount={machineItems.length}
        />
      )}

      {/* 批量录入 */}
      {showBatchInput && (
        <BatchInput
          presetConfig={batchPresetConfig || undefined}
          onConfirm={handleBatchInputComplete}
          onCancel={() => {
            setShowBatchInput(false);
            setBatchPresetConfig(null);
          }}
        />
      )}

      {/* Toast 提示 */}
      <ConfirmDialog
        isOpen={showInboundConfirm}
        title="确认入库"
        message={`确认将本采购单的 ${machineItems.length} 台机器入库吗？入库后将生成库存记录。`}
        confirmText="确认入库"
        cancelText="返回检查"
        onConfirm={() => { setShowInboundConfirm(false); void submitOrder('inbound'); }}
        onCancel={() => setShowInboundConfirm(false)}
      />
      <Toast
        isOpen={toast.show}
        type={toast.type}
        message={toast.message}
        onClose={() => setToast({ show: false, type: 'success', message: '' })}
      />
    </>
  );
}

