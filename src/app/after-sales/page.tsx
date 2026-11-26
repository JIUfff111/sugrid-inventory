'use client';

import { FormEvent, KeyboardEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, Check, ChevronDown, ChevronLeft, ChevronRight, Ellipsis, RefreshCw, Search, Wrench, X } from 'lucide-react';
import CustomSelect, { SelectOption } from '@/components/CustomSelect';
import ConfirmDialog from '@/components/ConfirmDialog';
import BusinessDialog from '@/components/BusinessDialog';
import MachineSearchInput from '@/components/MachineSearchInput';
import { useWorkspace, useWorkspaceDirty } from '@/components/WorkspaceContext';
import { useMachineEligibility } from '@/components/useMachineEligibility';
import { useInventoryLabelPrinter } from '@/components/InventoryLabelPrint';
import { formatDisplayDateTime, parseStoredTimestamp } from '@/lib/display-date-time';
import { inventoryMovementLabel } from '@/lib/inventory-movement-labels';
import { matchesMachineScanSerial, stripMachineScanSuffix } from '@/lib/machine-scan';
import { formatProductName } from '@/lib/product-name';
import { formatCPUDisplay, formatGPUDisplay, formatScreenDisplay } from '@/lib/sku-display';

type SoldItem = { id: string; sn: string; brand: string; model: string; year: number | null; cpu: string; ram: string; gpu?: string | null; storage: string; screen?: string | null; sellingPrice: number | null; purchasePrice: number; saleOrderNo: string | null; salesRecordNo?: string | null; saleChannel?: string | null; saleDate?: string | null; warehouseId?: string | null };
type ReplacementItem = { id: string; sn: string; brand: string; model: string; year: number | null; cpu: string; ram: string; gpu?: string | null; storage: string; screen?: string | null; warehouseName?: string | null };
type AfterSale = ExchangeDetails & { id: string; afterSaleNo: string; inventoryId: string; sn: string; brand?: string | null; model?: string | null; year?: number | null; cpu?: string | null; ram?: string | null; gpu?: string | null; storage?: string | null; screen?: string | null; customerName?: string | null; customerPhone?: string | null; issueType: string; issueDescription: string | null; resolutionType: string; status: string; refundAmount?: number | null; resolutionNote: string | null; returnTrackingNo?: string | null; processingAt?: string | null; processingBy?: string | null; processingByName?: string | null; processingNote?: string | null; createdBy?: string | null; createdByName?: string | null; receivedBy?: string | null; receivedByName?: string | null; receivedCondition?: string | null; receivedNote?: string | null; stockNote?: string | null; stockCondition?: string | null; saleOrderNo: string | null; salesRecordNo?: string | null; saleChannel?: string | null; saleDate?: string | null; sellingPrice?: number | null; purchasePrice?: number | null; warehouseId?: string | null; replacementInventoryId: string | null; createdAt: string; receivedAt?: string; resolvedAt?: string | null; stockStatus?: string };
type ExchangeDetails = {
  originalWarehouseName?: string | null;
  reservedReplacementId?: string | null;
  reservedReplacementSn?: string | null;
  replacementSn?: string | null;
  replacementWarehouseName?: string | null;
  shippedReplacementTrackingNo?: string | null;
  latestActivityType?: string | null;
  latestActivityAt?: string | null;
  latestActivityByName?: string | null;
};
type ToastMessage = { text: string; tone: 'success' | 'error' };
type UpdateAction = 'receive' | 'start_processing' | 'repair_complete' | 'customer_return' | 'cancel' | 'update_progress' | 'update_condition' | 'reserve_exchange' | 'release_exchange' | 'ship_exchange' | 'restock';
type ConfirmAction = Exclude<UpdateAction, 'reserve_exchange' | 'update_progress' | 'update_condition'>;
const DEFAULT_ISSUE_TYPE = '';
const PAGE_SIZE = 15;
const EXCHANGE_UPDATE_MESSAGES = {
  receive: '原机已收，下一步可以预留替换机',
  reserve_exchange: '替换机已锁定，等待实际发货',
  release_exchange: '替换机已解锁，售后单回到待备货',
  ship_exchange: '换货发货已登记，原机仍留在售后暂存',
  restock: '原机已转入正式库存',
  update_condition: '机器状况和核验备注已保存',
} as const;
const WORK_QUEUES = [
  { value: 'todo', label: '全部待办' },
  { value: 'exchange_receive', label: '待收原机' },
  { value: 'exchange_reserve', label: '待备货' },
  { value: 'exchange_ship', label: '待发货' },
  { value: 'exchange_dispose', label: '原机待处置' },
  { value: 'other_active', label: '其他售后' },
] as const;
type QueueStatus = typeof WORK_QUEUES[number]['value'];
type RecordFilter = QueueStatus | 'stored' | 'all' | 'resolved' | 'cancelled';
type ListData = { items: AfterSale[]; total: number; totalPages: number; queueCounts: Record<RecordFilter, number> };

function money(value: number | null | undefined) { return '¥' + Number(value || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function isOverdue(receivedAt: string | null | undefined, checkedAt: number) {
  const receivedTime = parseStoredTimestamp(receivedAt)?.getTime();
  return receivedTime !== undefined && checkedAt - receivedTime > 86400000;
}
function configText(item: Pick<SoldItem, 'cpu' | 'ram' | 'storage'> & { gpu?: string | null; screen?: string | null }) { return [formatCPUDisplay(item.cpu), item.ram, item.storage, formatGPUDisplay(item.gpu), formatScreenDisplay(item.screen)].filter(Boolean).join(' · ') || '配置待补充'; }
function statusClass(status: string) { return status === 'created' ? 'warn' : status === 'resolved' ? 'ok' : 'info'; }
function resolutionLabel(type: string) { return ({ repair: '维修', exchange: '换货', customer_return: '退货退款' } as Record<string, string>)[type] || type || '未记录'; }
function productName(item: { brand?: string | null; model?: string | null; year?: number | null }) { return formatProductName(item); }
function needsOriginalDisposition(record: AfterSale) { return record.status === 'resolved' && record.resolutionType === 'exchange' && record.stockStatus === 'stored'; }
function initialFilter(view: string | null, search: string): RecordFilter { return view === 'stock' || view === 'stored' ? 'stored' : search ? 'all' : 'todo'; }
function preventScanSubmit(event: KeyboardEvent<HTMLInputElement>) {
  if (event.key === 'Enter' && !event.nativeEvent.isComposing) event.preventDefault();
}

function recordStageFallback(record: AfterSale) {
  if (record.resolutionType === 'exchange') {
    if (record.status === 'created') return { label: '待收原机', action: '收原机', event: '登记', at: record.createdAt, by: record.createdByName };
    if (record.status === 'received' || record.status === 'processing') {
      if (record.reservedReplacementId) return { label: '待发货', action: '登记发货', event: '预留替换机', at: record.processingAt, by: record.processingByName };
      return { label: '待备货', action: '选择替换机', event: record.processingAt ? '开始处理' : '签收', at: record.processingAt || record.receivedAt, by: record.processingByName || record.receivedByName };
    }
  }
  switch (record.status) {
    case 'created': return { label: '待收机', action: '登记收件', event: '登记', at: record.createdAt, by: record.createdByName };
    case 'received': return { label: '待处理', action: '开始处理', event: '签收', at: record.receivedAt, by: record.receivedByName };
    case 'processing': return { label: '处理中', action: '继续处理', event: '开始处理', at: record.processingAt, by: record.processingByName };
    case 'resolved': return { label: needsOriginalDisposition(record) ? '原机待处置' : '已完成', action: needsOriginalDisposition(record) ? '处置原机' : '查看结果', event: record.resolutionType === 'exchange' && record.shippedReplacementTrackingNo ? '换货发出' : '完成', at: record.resolvedAt };
    case 'cancelled': return { label: '已取消', action: '查看记录', event: '取消', at: record.resolvedAt };
    default: return { label: record.status || '未记录', action: '查看记录', event: '登记', at: record.createdAt, by: record.createdByName };
  }
}

function recordStage(record: AfterSale) {
  const stage = recordStageFallback(record);
  if (record.resolutionType !== 'exchange' || !record.latestActivityType || !record.latestActivityAt) return stage;
  return { ...stage, event: inventoryMovementLabel(record.latestActivityType), at: record.latestActivityAt, by: record.latestActivityByName };
}

async function fetchRecord(id: string, signal?: AbortSignal): Promise<AfterSale> {
  const response = await fetch('/api/after-sales?id=' + encodeURIComponent(id), { cache: 'no-store', signal });
  const payload = await response.json();
  if (!response.ok || !payload.success) throw new Error(payload.error?.message || '售后单加载失败');
  const record = payload.data?.items?.[0];
  if (!record) throw new Error('售后单已不存在');
  return record;
}

function ModalShell({ title, subtitle, onClose, children, footer }: { title: string; subtitle?: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  return <BusinessDialog title={title} description={subtitle} onClose={onClose} footer={footer}>{children}</BusinessDialog>;
}

export default function AfterSalesPage() {
  const { active, searchParams } = useWorkspace();
  const recordId = searchParams.get('recordId') || '';
  const routeSearch = searchParams.get('search') || '';
  const routeView = searchParams.get('view');
  const openedRecord = useRef('');
  const moreActions = useRef<HTMLDetailsElement>(null);
  const nextAction = useRef<HTMLHeadingElement>(null);
  const updatingRecord = useRef(false);
  const [soldItems, setSoldItems] = useState<SoldItem[]>([]);
  const [replacementItems, setReplacementItems] = useState<ReplacementItem[]>([]);
  const [list, setList] = useState<ListData | null>(null);
  const [search, setSearch] = useState(routeSearch);
  const [checkedAt, setCheckedAt] = useState(0);
  const [machineSearch, setMachineSearch] = useState('');
  const [status, setStatus] = useState<RecordFilter>(initialFilter(routeView, routeSearch));
  const [page, setPage] = useState(1);
  const [listError, setListError] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [issueType, setIssueType] = useState(DEFAULT_ISSUE_TYPE);
  const [returnTrackingNo, setReturnTrackingNo] = useState('');
  const [issueDescription, setIssueDescription] = useState('');
  const [resolutionType, setResolutionType] = useState('repair');
  const [remark, setRemark] = useState('');
  const [replacementId, setReplacementId] = useState('');
  const [replacementSearch, setReplacementSearch] = useState('');
  const [changingReplacement, setChangingReplacement] = useState(false);
  const [shippingTrackingNo, setShippingTrackingNo] = useState('');
  const [shippingSerial, setShippingSerial] = useState('');
  const [dispositionCondition, setDispositionCondition] = useState('');
  const [editingCondition, setEditingCondition] = useState(false);
  const [handlingNote, setHandlingNote] = useState('');
  const [receivedCondition, setReceivedCondition] = useState('');
  const [receivedNote, setReceivedNote] = useState('');
  const [pendingAction, setPendingAction] = useState<ConfirmAction | null>(null);
  const [returnConfirmOpen, setReturnConfirmOpen] = useState(false);
  const [pendingPrint, setPendingPrint] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedRecord, setSelectedRecord] = useState<AfterSale | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const { printLabels, printing, printPortal } = useInventoryLabelPrinter();

  const notify = (text: string, tone: ToastMessage['tone'] = 'success') => setToast({ text, tone });

  const openRecord = useCallback((record: AfterSale) => {
    setSelectedRecord(record);
    setReplacementId(''); setReplacementSearch(''); setChangingReplacement(false); setShippingTrackingNo(''); setShippingSerial(''); setDispositionCondition(''); setEditingCondition(false); setDetailError('');
    setHandlingNote(record.processingNote || ''); setReceivedCondition(record.receivedCondition || record.stockCondition || ''); setReceivedNote(record.receivedNote || record.stockNote || '');
  }, []);

  useEffect(() => {
    setSearch(routeSearch);
    setStatus(initialFilter(routeView, routeSearch));
    setPage(1);
  }, [routeSearch, routeView]);

  useEffect(() => {
    if (!active || !recordId || openedRecord.current === recordId) return;
    const controller = new AbortController();
    void fetchRecord(recordId, controller.signal).then(record => {
      if (controller.signal.aborted) return;
      openedRecord.current = recordId;
      openRecord(record);
    }).catch(error => { if (!controller.signal.aborted) setToast({ text: error.message || '关联售后单加载失败', tone: 'error' }); });
    return () => controller.abort();
  }, [active, recordId, openRecord]);

  const loadController = useRef<AbortController | null>(null);
  const loadData = useCallback(async () => {
    loadController.current?.abort(); const controller = new AbortController(); loadController.current = controller;
    setLoading(true); setListError('');
    try {
      const response = await fetch('/api/after-sales?' + new URLSearchParams({ status, search, page: String(page), pageSize: String(PAGE_SIZE), includeCounts: '1' }), { cache: 'no-store', signal: controller.signal });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error?.message || '加载售后记录失败');
      if (controller.signal.aborted) return;
      const data: ListData = payload.data;
      if (page > Math.max(1, data.totalPages)) {
        setPage(Math.max(1, data.totalPages));
        return;
      }
      setCheckedAt(Date.now());
      setList(data);
    } catch (loadError) {
      if (!controller.signal.aborted) setListError(loadError instanceof Error ? loadError.message : '加载售后数据失败');
    } finally { if (!controller.signal.aborted) setLoading(false); }
  }, [search, status, page, setCheckedAt, setList]);

  const soldController = useRef<AbortController | null>(null);
  const loadSoldItems = useCallback(async () => {
    soldController.current?.abort(); const controller = new AbortController(); soldController.current = controller;
    try {
      const response = await fetch('/api/inventory/lookup?context=after-sale&q=' + encodeURIComponent(machineSearch) + '&limit=100', { cache: 'no-store', signal: controller.signal });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error?.message || '加载已售机器失败');
      setSoldItems(current => { const next: SoldItem[] = payload.data?.items || []; return [...next, ...current.filter(item => item.id === selectedId && !next.some(row => row.id === item.id))]; });
    } catch (loadError) { if (!controller.signal.aborted) notify(loadError instanceof Error ? loadError.message : '加载已售机器失败', 'error'); }
  }, [machineSearch, selectedId]);

  useEffect(() => {
    if (!active) return;
    const timer = window.setTimeout(() => { void loadData(); }, 250);
    return () => { window.clearTimeout(timer); loadController.current?.abort(); };
  }, [active, loadData]);

  useEffect(() => {
    if (!active || !createOpen) return;
    const timer = window.setTimeout(() => { void loadSoldItems(); }, 200);
    return () => { window.clearTimeout(timer); soldController.current?.abort(); };
  }, [active, createOpen, loadSoldItems]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 3800);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const selectedMachine = useMemo(() => soldItems.find((item) => item.id === selectedId), [soldItems, selectedId]);
  const selectedReplacement = replacementItems.find(item => item.id === replacementId);
  const validity = useMachineEligibility(selectedMachine && createOpen ? [selectedMachine] : [], 'after-sale');
  const replacementValidity = useMachineEligibility(selectedReplacement && selectedRecord ? [selectedReplacement] : [], 'exchange');
  const conditionChanged = selectedRecord && (receivedCondition !== (selectedRecord.receivedCondition || selectedRecord.stockCondition || '') || receivedNote !== (selectedRecord.receivedNote || selectedRecord.stockNote || ''));
  useWorkspaceDirty(Boolean((createOpen && (selectedId || issueDescription || remark || returnTrackingNo || issueType !== DEFAULT_ISSUE_TYPE || resolutionType !== 'repair')) || (selectedRecord && (replacementId || shippingTrackingNo || shippingSerial || dispositionCondition || handlingNote !== (selectedRecord.processingNote || '') || conditionChanged))));
  const expectedShippingSerial = selectedRecord?.reservedReplacementSn?.trim() || '';
  const confirmedReplacementSn = shippingSerial.trim();
  const shippingSerialMatches = matchesMachineScanSerial(confirmedReplacementSn, expectedShippingSerial);
  const duplicateTracking = Boolean(shippingTrackingNo.trim() && shippingTrackingNo.trim().toLocaleLowerCase() === selectedRecord?.returnTrackingNo?.trim().toLocaleLowerCase());
  const selectFilter = (filter: RecordFilter) => {
    if (filter === status) return;
    loadController.current?.abort(); setLoading(true); setStatus(filter); setPage(1);
  };
  const changeSearch = (value: string) => {
    if (value === search) return;
    loadController.current?.abort(); setLoading(true); setSearch(value); setPage(1);
  };
  const changePage = (value: number) => {
    setLoading(true); setPage(value);
  };
  const resetCreateForm = () => {
    setSelectedId(''); setIssueType(DEFAULT_ISSUE_TYPE); setReturnTrackingNo(''); setIssueDescription(''); setResolutionType('repair'); setRemark(''); setMachineSearch(''); setReturnConfirmOpen(false);
  };

  const createAfterSale = async () => {
    if (!selectedMachine) { notify('请选择已售机器', 'error'); return; }
    if (validity.checking || validity.error || validity.invalidIds.length) { notify(validity.error || '所选机器已不可登记售后，请重新选择', 'error'); return; }
    setSubmitting(true);
    try {
      const response = await fetch('/api/after-sales', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ inventoryId: selectedId, issueType, returnTrackingNo, issueDescription, resolutionType, remark }) });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error?.message || '创建售后单失败');
      const returnedToStock = resolutionType === 'customer_return';
      setCreateOpen(false); resetCreateForm(); setReturnConfirmOpen(false);
      if (returnedToStock) {
        setPendingPrint(payload.data?.inventoryId || selectedMachine.id);
        notify('退货退款已完成，机器已恢复正式库存');
      } else {
        notify('售后单 ' + payload.data.afterSaleNo + ' 已创建，等待收机');
        if (resolutionType === 'exchange') {
          try { openRecord(await fetchRecord(payload.data.id)); }
          catch { notify('换货单已创建，详情未能加载，请从售后列表打开。', 'error'); }
        }
      }
      await loadData();
    } catch (submitError) { notify(submitError instanceof Error ? submitError.message : '创建售后单失败', 'error'); } finally { setSubmitting(false); }
  };

  const submitAfterSale = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedMachine) { notify('请选择已售机器', 'error'); return; }
    if (resolutionType === 'customer_return') { setReturnConfirmOpen(true); return; }
    void createAfterSale();
  };

  const updateRecord = async (record: AfterSale, action: UpdateAction) => {
    if (updatingRecord.current) return;
    if (action === 'reserve_exchange' && !selectedReplacement) { notify('请选择替换机器', 'error'); return; }
    if (action === 'reserve_exchange' && (replacementValidity.checking || replacementValidity.error || replacementValidity.invalidIds.length)) {
      notify(replacementValidity.error || '替换机器状态已变化，请重新选择', 'error'); return;
    }
    if (action === 'ship_exchange' && (!record.reservedReplacementId || !shippingSerialMatches || !shippingTrackingNo.trim() || duplicateTracking || changingReplacement)) { notify('请核对实物 SN，并填写寄给客户的运单号', 'error'); return; }
    if (action === 'restock' && !dispositionCondition.trim()) { notify('请记录原机的入库检查结果', 'error'); return; }
    updatingRecord.current = true;
    setUpdating(true);
    setDetailError('');
    try {
      const exchangeAction = ['reserve_exchange', 'release_exchange', 'ship_exchange'].includes(action);
      const body = {
        id: record.id,
        action,
        replacementInventoryId: action === 'reserve_exchange' ? replacementId : undefined,
        expectedReplacementInventoryId: exchangeAction ? (record.reservedReplacementId ?? null) : undefined,
        shippingTrackingNo: action === 'ship_exchange' ? shippingTrackingNo.trim() : undefined,
        confirmedReplacementSn: action === 'ship_exchange' ? confirmedReplacementSn : undefined,
        originalReturnedToCustomer: action === 'cancel' && record.resolutionType === 'exchange' && record.stockStatus === 'stored' ? true : undefined,
        condition: (action === 'restock' ? dispositionCondition : receivedCondition).trim() || null,
        note: action === 'restock' ? undefined : receivedNote.trim() || null,
        processingNote: handlingNote.trim() || null,
        resolutionNote: handlingNote.trim() || (action === 'repair_complete' ? '维修完成并归还客户' : action === 'cancel' ? '取消售后' : undefined),
      };
      const response = await fetch('/api/after-sales', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error?.message || '更新售后单失败');
      setPendingAction(null);
      if (action === 'update_progress') {
        setSelectedRecord(current => current ? { ...current, processingNote: handlingNote.trim() } : current);
        notify(record.afterSaleNo + ' 当前进展已保存');
      } else if (action === 'reserve_exchange' || action === 'release_exchange' || action === 'ship_exchange' || action === 'restock' || action === 'update_condition' || (action === 'receive' && record.resolutionType === 'exchange')) {
        try {
          const refreshed = await fetchRecord(record.id);
          if (action === 'update_condition') {
            setSelectedRecord(refreshed);
            setReceivedCondition(refreshed.receivedCondition || refreshed.stockCondition || '');
            setReceivedNote(refreshed.receivedNote || refreshed.stockNote || '');
            setEditingCondition(false);
          } else {
            openRecord(refreshed);
            window.requestAnimationFrame(() => nextAction.current?.focus());
          }
          notify(EXCHANGE_UPDATE_MESSAGES[action]);
        } catch {
          setSelectedRecord(null);
          notify(`${EXCHANGE_UPDATE_MESSAGES[action]}；详情未能刷新，请重新打开售后单。`, 'error');
        }
      } else {
        setSelectedRecord(null);
        notify(record.afterSaleNo + ' 已更新');
      }
      await loadData();
    } catch (updateError) {
      setPendingAction(null);
      setDetailError(updateError instanceof Error ? updateError.message : '更新售后单失败');
    } finally { updatingRecord.current = false; setUpdating(false); }
  };

  const refreshRecord = async (record: AfterSale) => {
    if (updatingRecord.current) return;
    updatingRecord.current = true;
    setUpdating(true);
    try {
      const refreshed = await fetchRecord(record.id);
      if (refreshed.status !== record.status || refreshed.stockStatus !== record.stockStatus || refreshed.reservedReplacementId !== record.reservedReplacementId || refreshed.reservedReplacementSn !== record.reservedReplacementSn) {
        openRecord(refreshed);
        notify('工单状态已变化，请按当前步骤操作。');
      } else {
        setSelectedRecord(refreshed);
        setDetailError('');
      }
      await loadData();
    } catch (refreshError) { setDetailError(refreshError instanceof Error ? refreshError.message : '无法刷新工单'); }
    finally { updatingRecord.current = false; setUpdating(false); }
  };

  const resolutionOptions: SelectOption[] = [
    { value: 'customer_return', label: '退货退款' }, { value: 'exchange', label: '换货' }, { value: 'repair', label: '维修' },
  ];
  const gridColumns = 'lg:grid-cols-[minmax(112px,0.78fr)_minmax(155px,1.15fr)_minmax(175px,1.15fr)_minmax(155px,1.1fr)_minmax(100px,auto)]';
  const historySelected = status === 'all' || status === 'resolved' || status === 'cancelled';
  const detailStage = selectedRecord ? recordStage(selectedRecord) : null;
  const canWork = selectedRecord?.status === 'received' || selectedRecord?.status === 'processing';
  const isExchange = selectedRecord?.resolutionType === 'exchange';
  const exchangeProcessing = Boolean(canWork && isExchange);
  const actionableRecord = selectedRecord && ['created', 'received', 'processing'].includes(selectedRecord.status);
  const originalNeedsDisposition = selectedRecord && needsOriginalDisposition(selectedRecord);
  const hasReservation = Boolean(selectedRecord?.reservedReplacementId);
  const reserveMode = exchangeProcessing && (!hasReservation || changingReplacement);
  const cancelRequiresReturn = isExchange && selectedRecord?.stockStatus === 'stored';
  const reservationValid = Boolean(selectedReplacement && !replacementValidity.checking && !replacementValidity.error && replacementValidity.invalidIds.length === 0);
  const closeCreate = () => { if (!returnConfirmOpen && !submitting) setCreateOpen(false); };
  const closeRecord = () => { if (!pendingAction && !updating) setSelectedRecord(null); };
  const actionConfirmation = pendingAction && selectedRecord ? {
    receive: {
      title: '确认收到售后机器',
      message: receivedCondition.trim() || receivedNote.trim()
        ? `机器将进入售后暂存。登记内容：${[receivedCondition.trim(), receivedNote.trim()].filter(Boolean).join(' · ')}。`
        : '机器将进入售后暂存。机器状况暂未填写，可以稍后在原单补录。',
    },
    start_processing: { title: '开始售后处理', message: '确认开始处理此售后单？' },
    repair_complete: { title: '维修完成并归还客户', message: '确认维修已完成，机器已归还客户并恢复已售状态？' },
    customer_return: { title: '确认完成退货退款', message: '机器将沿用原采购成本和仓库恢复正式库存，销售来源记录保留。' },
    release_exchange: { title: '解除替换机锁定', message: '当前替换机将恢复可用，售后单回到待备货。' },
    ship_exchange: {
      title: '确认替换机已发货',
      message: `寄给客户的替换机：SN ${selectedRecord.reservedReplacementSn || '—'}\n寄给客户的运单号：${shippingTrackingNo.trim()}\n\n确认只会将替换机出库。原机 SN ${selectedRecord.sn} 继续留在售后暂存。`,
    },
    restock: { title: '确认原机检查合格并入库', message: `原机 SN ${selectedRecord.sn} 将转回正式库存并恢复可用。只有机器检查合格后才可确认。` },
    cancel: {
      title: cancelRequiresReturn ? '原机已归还客户并取消换货' : '取消售后',
      message: cancelRequiresReturn
        ? `仅在原机 SN ${selectedRecord.sn} 已实际归还客户后确认取消。${hasReservation ? '如果只想释放替换机，请返回，在「更多操作」中选择「解除预留」。' : ''}`
        : hasReservation
        ? '原机器将恢复为已售状态，暂存记录保留；未发货的替换机会解除锁定。'
        : '确认取消售后？原机器将恢复为已售状态，暂存记录保留。',
    },
  }[pendingAction] : null;
  const confirmActionText = pendingAction === 'ship_exchange' ? '确认发货并出库'
    : pendingAction === 'restock' ? '确认原机入库'
    : pendingAction === 'release_exchange' ? '确认解除预留'
    : pendingAction === 'cancel' && cancelRequiresReturn ? '原机已归还，取消换货' : '确认';

  return <div className="mx-auto max-w-[1400px] space-y-4 pb-8 page-transition-enter">
    <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
      <h1 className="text-xl font-bold tracking-tight text-ink-deep">售后处理</h1>
      <button type="button" onClick={() => { resetCreateForm(); setCreateOpen(true); }} className="btn-primary inline-flex items-center gap-2">
        <Wrench aria-hidden="true" className="h-4 w-4" />登记售后
      </button>
    </header>

    <section aria-label="售后工作台" className="overflow-hidden rounded-2xl border border-line bg-white/95 shadow-sm">
      <div className="flex flex-col gap-2 border-b border-line/80 px-3 py-3 sm:px-5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5" role="group" aria-label="售后队列">
          {WORK_QUEUES.map(({ value, label }) => (
            <button key={value} type="button" aria-pressed={status === value} onClick={() => selectFilter(value)}
              className={`inline-flex min-h-9 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 text-[13px] font-medium outline-offset-2 transition-colors sm:px-3 ${status === value ? 'bg-primary/10 text-primary' : 'text-ink-soft hover:bg-slate-100 hover:text-ink-deep'}`}>
              {label}{list && <span className="rounded bg-slate-100/85 px-1.5 py-0.5 text-[11px] tabular-nums text-ink-deep">{list.queueCounts[value] ?? 0}</span>}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-0 basis-full sm:max-w-lg sm:flex-1">
            <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-ink-soft" />
            <input type="search" aria-label="搜索售后记录" value={search} onChange={event => changeSearch(event.target.value)}
              placeholder="搜索运单、SN、客户或售后单号" className="field w-full !pl-9" />
          </div>
          {search.trim() && status !== 'all' && <button type="button" onClick={() => selectFilter('all')} className="btn-ghost min-h-9 text-xs">搜索全部记录</button>}
          <button type="button" aria-pressed={status === 'stored'} onClick={() => selectFilter(status === 'stored' ? 'todo' : 'stored')}
            className={`btn-ghost min-h-9 text-xs ${status === 'stored' ? '!bg-primary/10 !text-primary' : ''}`}>仅看售后暂存</button>
          <label className="relative min-w-28">
            <select aria-label="历史记录" value={historySelected ? status : ''} onChange={event => selectFilter(event.target.value as RecordFilter)}
              className={`field w-full appearance-none !pr-8 ${historySelected ? '!text-primary' : ''}`}>
              <option value="" disabled>历史记录</option>
              <option value="resolved">已结束处理</option>
              <option value="cancelled">已取消</option>
              <option value="all">全部记录</option>
            </select>
            <ChevronDown aria-hidden="true" className="pointer-events-none absolute top-1/2 right-3 h-3.5 w-3.5 -translate-y-1/2 text-ink-soft" />
          </label>
          <button type="button" aria-label="刷新售后列表" onClick={() => void loadData()} disabled={loading}
            className="btn-ghost ml-auto inline-flex min-h-9 items-center gap-1.5 px-2.5 text-xs sm:ml-0">
            <RefreshCw aria-hidden="true" className={`h-3.5 w-3.5 ${loading ? 'motion-safe:animate-spin' : ''}`} />刷新
          </button>
        </div>
      </div>

      <div aria-busy={loading} aria-label="售后列表" role="region">
        {loading ? <p role="status" className="px-5 py-14 text-center text-sm text-ink-soft">正在加载售后记录…</p>
          : listError ? <div role="alert" className="flex flex-wrap items-center justify-center gap-3 px-5 py-14 text-sm"><p className="text-danger">{listError}</p><button type="button" className="btn-ghost" onClick={() => void loadData()}>重试</button></div>
          : !list?.items.length ? <div className="px-5 py-14 text-center">
            <p className="text-sm font-medium text-ink-deep">{search.trim() ? '没有符合条件的售后记录' : status === 'todo' ? '当前没有售后待办' : '暂无此类售后记录'}</p>
            {search.trim() && <div className="mt-2 flex flex-wrap justify-center gap-2">
              <button type="button" onClick={() => changeSearch('')} className="btn-ghost text-xs">清除搜索</button>
            </div>}
          </div> : <>
            <div aria-hidden="true" className={`hidden gap-4 border-b border-line/70 bg-slate-50 px-5 py-2.5 text-xs font-medium text-ink-soft lg:grid ${gridColumns}`}>
              <span>当前待办</span><span>机器与客户</span><span>运单与工单</span><span>最近交接</span><span className="text-right">下一步</span>
            </div>
            <ul className="divide-y divide-line/75">
              {list.items.map(record => {
                const stage = recordStage(record);
                const overdue = ['received', 'processing'].includes(record.status) && isOverdue(record.receivedAt, checkedAt);
                const tracking = record.returnTrackingNo?.trim();
                return <li key={record.id} className={`grid min-w-0 grid-cols-2 items-start gap-x-3 gap-y-2 px-3 py-3 transition-colors hover:bg-slate-50/80 sm:px-5 lg:items-center lg:gap-4 ${gridColumns}`}>
                  <div className="col-span-2 flex min-w-0 flex-wrap items-center gap-1.5 lg:col-span-1">
                    <span className={`status-pill ${needsOriginalDisposition(record) || stage.label === '待发货' || stage.label === '待备货' ? 'warn' : statusClass(record.status)}`}>{stage.label}</span>
                    {overdue && <span className="text-[11px] font-medium whitespace-nowrap text-danger">签收超 24 小时</span>}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold break-words text-ink-deep">{productName(record)}</p>
                    <p className="mt-0.5 font-mono text-xs break-all text-ink-soft">{record.resolutionType === 'exchange' ? '原机' : 'SN'} {record.sn}</p>
                    {(record.reservedReplacementSn || record.replacementSn) && <p className="mt-0.5 font-mono text-xs break-all text-ink-soft">替换机 {record.reservedReplacementSn || record.replacementSn}</p>}
                    {record.customerName?.trim() && <p className="mt-0.5 truncate text-xs text-ink-soft" title={record.customerName}>{record.customerName}</p>}
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs break-all text-ink-deep"><span className="mr-1 text-ink-soft">寄回</span>{tracking ? <span className="font-mono font-medium">{tracking}</span> : '未填写'}</p>
                    {record.shippedReplacementTrackingNo && <p className="mt-0.5 text-xs break-all text-ink-deep"><span className="mr-1 text-ink-soft">寄出</span><span className="font-mono font-medium">{record.shippedReplacementTrackingNo}</span></p>}
                    <p className="mt-0.5 text-[11px] break-all text-ink-soft">{record.afterSaleNo}</p>
                  </div>
                  <div className="min-w-0 self-center">
                    <p className="truncate text-xs text-ink-deep" title={stage.by || undefined}>{stage.event}{stage.by ? ` · ${stage.by}` : ''}</p>
                    <p className="mt-0.5 text-[11px] tabular-nums text-ink-soft">{formatDisplayDateTime(stage.at, '时间未记录')}</p>
                  </div>
                  <div className="min-w-0 justify-self-end self-center text-right">
                    <button type="button" aria-label={`${stage.action}：${record.afterSaleNo}`} onClick={() => openRecord(record)}
                      className="inline-flex min-h-8 items-center gap-0.5 whitespace-nowrap rounded-md px-2 text-xs font-semibold text-primary outline-offset-2 transition-colors hover:bg-primary/10">
                      {stage.action}<ChevronRight aria-hidden="true" className="h-3.5 w-3.5" />
                    </button>
                    <p className="pr-2 text-[11px] text-ink-soft">{resolutionLabel(record.resolutionType)}</p>
                  </div>
                </li>;
              })}
            </ul>
          </>}
      </div>
      {list && !loading && !listError && <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line/70 bg-slate-50 px-3 py-2 text-xs text-ink-soft sm:px-5">
        <span role="status">共 {list.total} 条售后记录</span>
        {list.totalPages > 1 && <nav aria-label="售后列表分页" className="flex items-center gap-2 tabular-nums">
          <button type="button" aria-label="上一页" disabled={page <= 1} onClick={() => changePage(page - 1)} className="btn-ghost p-1.5 disabled:opacity-45"><ChevronLeft aria-hidden="true" className="h-4 w-4" /></button>
          <span>{page} / {list.totalPages}</span>
          <button type="button" aria-label="下一页" disabled={page >= list.totalPages} onClick={() => changePage(page + 1)} className="btn-ghost p-1.5 disabled:opacity-45"><ChevronRight aria-hidden="true" className="h-4 w-4" /></button>
        </nav>}
      </div>}
    </section>

    {createOpen && <ModalShell title="登记销售售后" subtitle="原销售渠道、售价和成本会随机器自动带入" onClose={closeCreate} footer={<><button type="button" onClick={closeCreate} className="btn-ghost">取消</button><button form="after-sale-create-form" type="submit" disabled={submitting || validity.checking || !!validity.error || validity.invalidIds.length > 0} className="btn-primary inline-flex items-center gap-2 disabled:opacity-60"><Check className="h-4 w-4" />{submitting ? '处理中...' : resolutionType === 'customer_return' ? '确认退货退款' : '创建售后单'}</button></>}>
      <form id="after-sale-create-form" onSubmit={submitAfterSale} className="space-y-5">
        <section><div className="mb-2"><h3 className="text-sm font-semibold text-ink-deep">选择已售机器 <span className="text-danger">*</span></h3><p className="mt-1 text-xs text-ink-soft">仅显示当前已售且未有进行中售后的机器</p></div><MachineSearchInput<SoldItem> value={machineSearch} onChange={setMachineSearch} endpoint="/api/inventory/lookup?context=after-sale" onSelect={item => { setSoldItems(current => [item, ...current.filter(row => row.id !== item.id)]); setSelectedId(item.id); setMachineSearch(item.sn); }} onSearch={setMachineSearch} scanEnabled placeholder="输入 SN 后四位、型号或销售单号" ariaLabel="搜索已售机器" /><div className="mt-2 max-h-48 overflow-y-auto rounded-xl border border-line/80 bg-white/55">{soldItems.length === 0 ? <p className="p-4 text-center text-xs text-ink-soft">暂无可登记售后的已售机器</p> : soldItems.map((item) => <button type="button" key={item.id} onClick={() => setSelectedId(item.id)} className={'flex w-full items-center justify-between gap-3 border-b border-line/70 px-3 py-3 text-left last:border-0 ' + (selectedId === item.id ? 'bg-primary/10' : 'hover:bg-white/70')}><span className="min-w-0"><span className="block truncate text-[13px] font-medium text-ink-deep">{productName(item)}</span><span className="mt-1 block truncate font-mono text-[11px] text-ink-soft">{item.sn} · {configText(item)}</span></span><span className="shrink-0 text-xs text-ink-deep">{money(item.sellingPrice)}</span></button>)}</div></section>
        {(validity.error || validity.invalidIds.length > 0) && <p role="alert" className="rounded-xl bg-danger/5 p-3 text-xs text-danger">{validity.error || '所选机器状态已变化，请重新选择。'}</p>}
        {selectedMachine && <dl className="grid gap-3 rounded-xl border border-primary/15 bg-primary/5 p-3 sm:grid-cols-2"><DetailValue label="机器 SN / 配置" value={selectedMachine.sn + ' · ' + configText(selectedMachine)} /><DetailValue label="原销售单 / 渠道" value={(selectedMachine.salesRecordNo || selectedMachine.saleOrderNo || '未关联销售单') + ' · ' + (selectedMachine.saleChannel || '未记录渠道')} /><DetailValue label="原销售日期 / 售售价" value={(selectedMachine.saleDate || '—') + ' · ' + money(selectedMachine.sellingPrice)} /><DetailValue label="原采购成本" value={money(selectedMachine.purchasePrice)} /></dl>}
        <section className="grid gap-3 sm:grid-cols-2">
          <label className="text-xs text-ink-soft">售后原因 <span className="font-normal">选填</span><input type="text" maxLength={160} value={issueType} onChange={(event) => setIssueType(event.target.value)} className="field mt-1.5" placeholder="填写具体售后原因" /></label>
          <label className="text-xs text-ink-soft">处理方式<div className="mt-1.5"><CustomSelect value={resolutionType} onChange={setResolutionType} options={resolutionOptions} /></div></label>
          <label className="text-xs text-ink-soft sm:col-span-2">寄回快递单号 <span className="font-normal">选填</span><input type="text" maxLength={100} value={returnTrackingNo} onChange={(event) => setReturnTrackingNo(event.target.value)} className="field mt-1.5 font-mono" placeholder="客户寄回机器时填写，后续可按单号跟进" /></label>
          <label className="text-xs text-ink-soft sm:col-span-2">问题描述<textarea value={issueDescription} onChange={(event) => setIssueDescription(event.target.value)} rows={3} className="field mt-1.5 resize-y" placeholder="记录机器故障或客户反馈" /></label>
          <label className="text-xs text-ink-soft sm:col-span-2">备注<textarea value={remark} onChange={(event) => setRemark(event.target.value)} rows={2} className="field mt-1.5 resize-y" placeholder="可选" /></label>
        </section>
      </form>
    </ModalShell>}

    {selectedRecord && detailStage && <ModalShell title="售后单详情" subtitle={selectedRecord.afterSaleNo} onClose={closeRecord} footer={<>
      {actionableRecord && (isExchange ? <details ref={moreActions} className="group relative mr-auto">
        <summary className="btn-ghost flex min-h-9 cursor-pointer list-none items-center gap-1.5 whitespace-nowrap text-xs sm:text-sm [&::-webkit-details-marker]:hidden">
          <Ellipsis aria-hidden="true" className="h-4 w-4" />更多操作
        </summary>
        <div className="absolute bottom-full left-0 z-10 mb-2 flex w-40 flex-col gap-0.5 rounded-lg border border-line bg-white p-1.5 shadow-lg motion-safe:animate-fade-in">
          {hasReservation && <>
            <button type="button" disabled={updating || changingReplacement} className="btn-ghost min-h-9 text-left text-xs" onClick={() => {
              if (moreActions.current) moreActions.current.open = false;
              setChangingReplacement(true); setReplacementId(''); setReplacementSearch('');
              window.requestAnimationFrame(() => nextAction.current?.focus());
            }}>更换替换机</button>
            <button type="button" disabled={updating || changingReplacement} className="btn-ghost min-h-9 text-left text-xs" onClick={() => {
              if (moreActions.current) moreActions.current.open = false;
              setPendingAction('release_exchange');
            }}>解除预留</button>
          </>}
          <button type="button" disabled={updating || changingReplacement} className="btn-ghost min-h-9 text-left text-xs text-danger" onClick={() => {
            if (moreActions.current) moreActions.current.open = false;
            setPendingAction('cancel');
          }}>取消换货</button>
        </div>
      </details> : <button type="button" disabled={updating} onClick={() => setPendingAction('cancel')} className="btn-ghost mr-auto text-danger">取消售后</button>)}
      {selectedRecord.status === 'created' && <button type="button" disabled={updating} onClick={() => {
        if (isExchange) void updateRecord(selectedRecord, 'receive'); else setPendingAction('receive');
      }} className="btn-primary">{isExchange ? '确认收到原机' : '确认收件'}</button>}
      {selectedRecord.status === 'received' && !isExchange && <button type="button" disabled={updating} onClick={() => setPendingAction('start_processing')} className="btn-primary">开始处理</button>}
      {selectedRecord.status === 'processing' && selectedRecord.resolutionType === 'repair' && <button type="button" disabled={updating} onClick={() => setPendingAction('repair_complete')} className="btn-primary">维修完成并归还</button>}
      {selectedRecord.status === 'processing' && selectedRecord.resolutionType === 'customer_return' && <button type="button" disabled={updating} onClick={() => setPendingAction('customer_return')} className="btn-primary">完成退货退款入库</button>}
      {exchangeProcessing && (reserveMode
        ? <button type="button" disabled={updating || !reservationValid} onClick={() => void updateRecord(selectedRecord, 'reserve_exchange')} className="btn-primary">{hasReservation ? '改为预留这台替换机' : '预留这台替换机'}</button>
        : <button type="button" disabled={updating || !shippingSerialMatches || !shippingTrackingNo.trim() || duplicateTracking} onClick={() => setPendingAction('ship_exchange')} className="btn-primary">登记已发货并出库</button>)}
      {originalNeedsDisposition && <button type="button" disabled={updating || !dispositionCondition.trim()} onClick={() => setPendingAction('restock')} className="btn-primary">检查合格后将原机入库</button>}
      {!actionableRecord && !originalNeedsDisposition && <button type="button" onClick={closeRecord} className="btn-primary">关闭</button>}
    </>}>
      <div className="space-y-4">
        {isExchange ? <section aria-label="换货机器与当前待办" className="space-y-3">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className={`status-pill ${originalNeedsDisposition || exchangeProcessing ? 'warn' : statusClass(selectedRecord.status)}`}>{detailStage.label}</span>
            <span className="text-xs text-ink-soft">{detailStage.event}{detailStage.by ? ` · ${detailStage.by}` : ''} · {formatDisplayDateTime(detailStage.at, '时间未记录')}</span>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <ExchangeMachineCard
              direction="in"
              status={selectedRecord.stockStatus === 'stored' ? '在售后暂存' : selectedRecord.stockStatus === 'restocked' ? '已转正式库存' : selectedRecord.status === 'created' || (selectedRecord.status === 'cancelled' && !selectedRecord.receivedAt) ? '尚未签收' : selectedRecord.stockStatus === 'released' ? '已归还客户' : '原机去向详见记录'}
              sn={selectedRecord.sn}
              name={productName(selectedRecord)}
              warehouse={selectedRecord.stockStatus === 'stored' || selectedRecord.stockStatus === 'restocked' ? selectedRecord.originalWarehouseName : undefined}
              tracking={selectedRecord.returnTrackingNo || '未填写'}
            />
            <ExchangeMachineCard
              direction="out"
              status={hasReservation ? '已预留，未出库' : selectedRecord.replacementInventoryId ? '已出库' : selectedRecord.status === 'cancelled' ? '未发出' : '尚未预留'}
              sn={selectedRecord.reservedReplacementSn || selectedRecord.replacementSn}
              warehouse={selectedRecord.replacementWarehouseName}
              tracking={selectedRecord.shippedReplacementTrackingNo || (selectedRecord.replacementInventoryId ? '历史未记录' : '发货后登记')}
            />
          </div>
          {(selectedRecord.customerName || selectedRecord.customerPhone) && <p className="text-xs break-words text-ink-soft">客户：{[selectedRecord.customerName, selectedRecord.customerPhone].filter(Boolean).join(' · ')}</p>}
        </section> : <section className="space-y-3 rounded-xl border border-line bg-white/80 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`status-pill ${originalNeedsDisposition || exchangeProcessing ? 'warn' : statusClass(selectedRecord.status)}`}>{detailStage.label}</span>
            <span className="text-xs text-ink-soft">{resolutionLabel(selectedRecord.resolutionType)}</span>
            {selectedRecord.stockStatus === 'stored' && <span className="text-xs text-ink-soft">· 售后暂存</span>}
            {canWork && isOverdue(selectedRecord.receivedAt, checkedAt) && <span className="status-pill danger">签收超 24 小时</span>}
          </div>
          <div>
            <h3 className="text-base font-semibold break-words text-ink-deep">{productName(selectedRecord)}</h3>
            <p className="mt-0.5 font-mono text-xs break-all text-ink-soft">SN {selectedRecord.sn}</p>
          </div>
          <dl className="grid grid-cols-2 gap-3 border-t border-line/70 pt-3">
            <DetailValue label="寄回快递单号" value={selectedRecord.returnTrackingNo || '未填写'} />
            {(selectedRecord.customerName || selectedRecord.customerPhone) && <DetailValue label="客户" value={[selectedRecord.customerName, selectedRecord.customerPhone].filter(Boolean).join(' · ')} />}
          </dl>
        </section>}

        {detailError && <div className="flex flex-wrap items-center gap-2 rounded-lg border border-danger/20 bg-danger/5 px-3 py-2">
          <p role="alert" className="flex-1 text-xs text-danger">{detailError}</p>
          <button type="button" disabled={updating} onClick={() => void refreshRecord(selectedRecord)} className="btn-ghost min-h-9 whitespace-nowrap text-xs">刷新工单状态</button>
        </div>}

        {selectedRecord.status === 'created' && <section className="rounded-xl border border-primary/15 bg-primary/5 p-4">
          <h3 ref={nextAction} tabIndex={-1} className="text-sm font-semibold text-ink-deep">{isExchange ? '下一步：收原机' : '下一步：登记收件'}</h3>
          <p className="mt-1 text-xs text-ink-soft">{isExchange ? `核对已收到的原机 SN ${selectedRecord.sn}，确认后进入售后暂存。机器状况可稍后补录。` : '机器状况可在拆包后补录。'}</p>
          <div className="mt-3 grid gap-3">
            <label className="text-xs text-ink-soft">机器状况（选填）<input value={receivedCondition} onChange={event => setReceivedCondition(event.target.value)} maxLength={160} className="field mt-1.5" placeholder="例如：外观完好、屏幕破损" /></label>
            <label className="text-xs text-ink-soft">拆包核验备注<textarea value={receivedNote} onChange={event => setReceivedNote(event.target.value)} rows={2} maxLength={1000} className="field mt-1.5 resize-y" placeholder="记录配件、外观和通电检查情况" /></label>
          </div>
        </section>}

        {exchangeProcessing && (reserveMode ? <section key="reserve" className="space-y-3 rounded-xl border border-primary/15 bg-primary/5 p-4 motion-safe:animate-fade-in">
          <div>
            <h3 ref={nextAction} tabIndex={-1} className="text-sm font-semibold text-ink-deep">{changingReplacement ? '下一步：选择新的替换机' : '下一步：选择要寄给客户的替换机'}</h3>
            <p className="mt-1 text-xs leading-5 text-ink-soft">{changingReplacement ? '保存新替换机后才会释放原来的预留。' : '从可用库存选一台。预留后其他订单不能使用这台机器，机器仍在仓。'}</p>
          </div>
          <MachineSearchInput<ReplacementItem> value={replacementSearch} onChange={value => { setReplacementSearch(stripMachineScanSuffix(value)); setReplacementId(''); }} endpoint="/api/inventory/lookup?context=exchange"
            onSelect={item => { setReplacementItems(current => [item, ...current.filter(row => row.id !== item.id)]); setReplacementId(item.id); setReplacementSearch(item.sn); }}
            scanEnabled placeholder="输入或扫描替换机 SN" ariaLabel="搜索换货替换机器" />
          {selectedReplacement && <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-primary/15 bg-white px-3 py-2">
            <div className="min-w-0">
              <p className="text-xs font-medium break-words text-ink-deep">待预留 · {productName(selectedReplacement)}{selectedReplacement.warehouseName ? ` · ${selectedReplacement.warehouseName}` : ''}</p>
              <p className="mt-0.5 font-mono text-sm font-semibold break-all text-ink-deep">SN {selectedReplacement.sn}</p>
            </div>
            {!changingReplacement && <button type="button" disabled={updating} className="btn-ghost text-xs" onClick={() => { setReplacementId(''); setReplacementSearch(''); }}>取消选择</button>}
          </div>}
          {(replacementValidity.error || replacementValidity.invalidIds.length > 0) && <p role="alert" className="text-xs text-danger">{replacementValidity.error || '替换机器已不可用，请重新选择。'}</p>}
          {changingReplacement && <button type="button" disabled={updating} className="btn-ghost min-h-9 text-xs" onClick={() => {
            setChangingReplacement(false); setReplacementId(''); setReplacementSearch('');
            window.requestAnimationFrame(() => nextAction.current?.focus());
          }}>保留原替换机</button>}
        </section> : <section key="ship" className="space-y-3 rounded-xl border border-primary/15 bg-primary/5 p-4 motion-safe:animate-fade-in">
          <div>
            <h3 ref={nextAction} tabIndex={-1} className="text-sm font-semibold text-ink-deep">下一步：登记替换机发货</h3>
            <p className="mt-1 text-xs leading-5 text-ink-soft">请在机器实际寄出后登记。确认只会将替换机出库，原机继续暂存。</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="text-xs text-ink-soft">
              <label htmlFor="exchange-ship-serial">核对实际发出的替换机 SN <span aria-hidden="true" className="text-danger">*</span></label>
              <input id="exchange-ship-serial" value={shippingSerial} onChange={event => setShippingSerial(event.target.value)} maxLength={206}
                onKeyDown={preventScanSubmit} autoComplete="off" spellCheck={false} className="field mt-1.5 font-mono" placeholder="扫描或输入实物 SN"
                aria-required="true" aria-invalid={Boolean(confirmedReplacementSn && !shippingSerialMatches)} aria-describedby="exchange-ship-serial-message" />
              <span id="exchange-ship-serial-message" aria-live="polite" className={`mt-1 block break-words ${confirmedReplacementSn && !shippingSerialMatches ? 'text-danger' : shippingSerialMatches ? 'text-success' : 'text-ink-soft'}`}>
                {shippingSerialMatches ? '已与预留 SN 核对一致' : confirmedReplacementSn ? `扫描结果 ${confirmedReplacementSn} 与预留 SN ${expectedShippingSerial || '未记录'} 不符。` : '核对寄出的那一台机器。'}
              </span>
            </div>
            <div className="text-xs text-ink-soft">
              <label htmlFor="exchange-ship-tracking">寄给客户的运单号 <span aria-hidden="true" className="text-danger">*</span></label>
              <input id="exchange-ship-tracking" value={shippingTrackingNo} onChange={event => setShippingTrackingNo(event.target.value)} maxLength={100}
                onKeyDown={preventScanSubmit} autoComplete="off" spellCheck={false} className="field mt-1.5 font-mono" placeholder="填写寄出运单号"
                aria-required="true" aria-invalid={duplicateTracking} aria-describedby="exchange-ship-tracking-message" />
              <span id="exchange-ship-tracking-message" aria-live="polite" className={`mt-1 block ${duplicateTracking ? 'text-danger' : 'text-ink-soft'}`}>{duplicateTracking ? '与客户寄回的运单号相同，请核对寄出面单。' : '使用替换机寄出的运单。'}</span>
            </div>
          </div>
        </section>)}
        {canWork && !isExchange && <section className="rounded-xl border border-primary/15 bg-primary/5 p-4">
          <h3 className="text-sm font-semibold text-ink-deep">{selectedRecord.status === 'received' ? '下一步：开始处理' : '处理进展'}</h3>
          <label className="mt-3 block text-xs text-ink-soft">{selectedRecord.status === 'received' ? '交接备注' : '当前处理进展'}<textarea value={handlingNote} onChange={event => setHandlingNote(event.target.value)} rows={2} maxLength={1000} className="field mt-1.5 resize-y" placeholder="记录已采取的处理、遇到的问题或交接事项" /></label>
          {selectedRecord.status === 'processing' && <button type="button" className="btn-ghost mt-2" disabled={updating || !handlingNote.trim()} onClick={() => void updateRecord(selectedRecord, 'update_progress')}>{updating ? '保存中…' : '保存当前进展'}</button>}
        </section>}

        {['received', 'processing'].includes(selectedRecord.status) && selectedRecord.resolutionType === 'customer_return' && <p className="rounded-xl border border-primary/15 bg-primary/5 p-4 text-xs leading-5 text-ink-soft">退货退款将沿用原销售记录、原采购成本和原仓库恢复正式库存，随后可打印库存标签。</p>}
        {!isExchange && (selectedRecord.status === 'resolved' || selectedRecord.status === 'cancelled') && <section className="rounded-xl border border-line bg-slate-50 p-4">
          <h3 className="text-sm font-semibold text-ink-deep">处理结果</h3>
          <dl className="mt-3 grid gap-3 sm:grid-cols-2">
            <DetailValue label={detailStage.event + '时间'} value={formatDisplayDateTime(detailStage.at, '未记录')} />
            {selectedRecord.refundAmount != null && <DetailValue label="退款金额" value={money(selectedRecord.refundAmount)} />}
            <DetailValue label="结果备注" value={selectedRecord.resolutionNote || '未填写'} />
          </dl>
        </section>}
        {originalNeedsDisposition && <section className="rounded-xl border border-primary/15 bg-primary/5 p-4">
          <h3 ref={nextAction} tabIndex={-1} className="text-sm font-semibold text-ink-deep">下一步：处置原机</h3>
          <p className="mt-1 text-xs leading-5 text-ink-soft">替换机已出库。原机需要继续检修时，可关闭工单并留在售后暂存；检查合格后再入库。</p>
          <label className="mt-3 block text-xs text-ink-soft">入库检查结果 <span className="text-danger">*</span>
            <input value={dispositionCondition} onChange={event => setDispositionCondition(event.target.value)} maxLength={160} className="field mt-1.5" placeholder="例如：已完成维修，通电及功能检查合格" />
          </label>
        </section>}

        <details className="group rounded-lg border border-line bg-white/70" open={isExchange ? undefined : true}>
          <summary className="flex min-h-10 cursor-pointer list-none items-center justify-between gap-2 px-3 py-2.5 text-sm font-medium text-ink-deep hover:bg-slate-50">
            问题与交接记录<ChevronDown aria-hidden="true" className="h-4 w-4 text-ink-soft transition-transform group-open:rotate-180 motion-reduce:transition-none" />
          </summary>
          <div className="space-y-3 border-t border-line/70 p-3">
          <dl className="grid gap-3 sm:grid-cols-2">
            <DetailValue label="售后原因" value={selectedRecord.issueType || '未填写'} />
            <DetailValue label="登记" value={`${selectedRecord.createdByName || '未记录登记人'} · ${formatDisplayDateTime(selectedRecord.createdAt, '时间未记录')}`} />
            {selectedRecord.receivedAt && <DetailValue label="签收" value={`${selectedRecord.receivedByName || '未记录签收人'} · ${formatDisplayDateTime(selectedRecord.receivedAt)}`} />}
            {selectedRecord.processingAt && <DetailValue label="开始处理" value={`${selectedRecord.processingByName || '未记录处理人'} · ${formatDisplayDateTime(selectedRecord.processingAt)}`} />}
            {selectedRecord.issueDescription && <DetailValue wide label="问题描述" value={selectedRecord.issueDescription} />}
            {selectedRecord.receivedAt && <DetailValue wide label="拆包核验" value={[selectedRecord.receivedCondition || selectedRecord.stockCondition || '机器状况未记录', selectedRecord.receivedNote || selectedRecord.stockNote].filter(Boolean).join('\n')} />}
            {(!canWork || isExchange) && selectedRecord.processingNote && <DetailValue wide label="处理进展" value={selectedRecord.processingNote} />}
            {isExchange && !canWork && selectedRecord.resolutionNote && <DetailValue wide label="结果备注" value={selectedRecord.resolutionNote} />}
          </dl>
          {(canWork || originalNeedsDisposition) && (editingCondition ? <div className="grid gap-3 rounded-lg border border-line bg-white/70 p-3">
            <label className="text-xs text-ink-soft">机器状况（选填）<input value={receivedCondition} onChange={event => setReceivedCondition(event.target.value)} maxLength={160} className="field mt-1.5" placeholder="例如：外观完好、屏幕破损" /></label>
            <label className="text-xs text-ink-soft">拆包核验备注<textarea value={receivedNote} onChange={event => setReceivedNote(event.target.value)} rows={2} maxLength={1000} className="field mt-1.5 resize-y" /></label>
            <div className="flex flex-wrap justify-end gap-2">
              <button type="button" disabled={updating} className="btn-ghost text-xs" onClick={() => { setReceivedCondition(selectedRecord.receivedCondition || selectedRecord.stockCondition || ''); setReceivedNote(selectedRecord.receivedNote || selectedRecord.stockNote || ''); setEditingCondition(false); }}>取消修改</button>
              <button type="button" disabled={updating || !conditionChanged} className="btn-primary text-xs" onClick={() => void updateRecord(selectedRecord, 'update_condition')}>保存核验记录</button>
            </div>
          </div> : <button type="button" disabled={updating} className="btn-ghost text-xs" onClick={() => setEditingCondition(true)}>补录机器状况</button>)}
          {canWork && isExchange && <div className="space-y-2">
            <label className="block text-xs text-ink-soft">交接备注<textarea value={handlingNote} onChange={event => setHandlingNote(event.target.value)} rows={2} maxLength={1000} className="field mt-1.5 resize-y" placeholder="记录已采取的处理、遇到的问题或交接事项" /></label>
            {selectedRecord.status === 'processing'
              ? <button type="button" className="btn-ghost min-h-9 text-xs" disabled={updating || !handlingNote.trim() || handlingNote.trim() === (selectedRecord.processingNote || '')} onClick={() => void updateRecord(selectedRecord, 'update_progress')}>保存交接备注</button>
              : <p className="text-xs text-ink-soft">预留替换机时会同时保存这段备注。</p>}
          </div>}
          </div>
        </details>

        <details className="group rounded-lg border border-line bg-white/70">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2.5 text-sm font-medium text-ink-deep hover:bg-slate-50">
            原销售与机器配置<ChevronDown aria-hidden="true" className="h-4 w-4 text-ink-soft transition-transform group-open:rotate-180 motion-reduce:transition-none" />
          </summary>
          <dl className="grid gap-3 border-t border-line/70 p-3 sm:grid-cols-2">
            <DetailValue wide label="机器配置" value={configText({ cpu: selectedRecord.cpu || '', ram: selectedRecord.ram || '', storage: selectedRecord.storage || '', gpu: selectedRecord.gpu, screen: selectedRecord.screen })} />
            <DetailValue label="原销售单 / 渠道" value={(selectedRecord.salesRecordNo || selectedRecord.saleOrderNo || '未关联销售单') + ' · ' + (selectedRecord.saleChannel || '未记录渠道')} />
            <DetailValue label="原销售价 / 采购成本" value={money(selectedRecord.sellingPrice) + ' / ' + money(selectedRecord.purchasePrice)} />
            {selectedRecord.replacementInventoryId && <DetailValue label="替换机器记录" value={selectedRecord.replacementInventoryId} />}
          </dl>
        </details>
      </div>
    </ModalShell>}

    <ConfirmDialog isOpen={Boolean(actionConfirmation)} title={actionConfirmation?.title || '确认处理'} message={actionConfirmation?.message || ''} confirmText={updating ? '处理中…' : confirmActionText} cancelText="返回" danger={pendingAction === 'cancel'} onConfirm={() => { if (selectedRecord && pendingAction && !updating) void updateRecord(selectedRecord, pendingAction); }} onCancel={() => { if (!updating) setPendingAction(null); }} />
    <ConfirmDialog isOpen={returnConfirmOpen} title="确认退货退款并入库" message={selectedMachine ? `${productName(selectedMachine)}（SN ${selectedMachine.sn}）将沿用原销售记录和采购成本，直接恢复到原仓库。` : ''} confirmText={submitting ? '处理中...' : '确认退货退款'} cancelText="返回修改" onConfirm={() => { if (!submitting) void createAfterSale(); }} onCancel={() => { if (!submitting) setReturnConfirmOpen(false); }} />
    <ConfirmDialog isOpen={Boolean(pendingPrint)} title="打印库存标签" message="退货退款已入库，是否使用默认标签样式立即打印？" confirmText={printing ? '准备打印...' : '立即打印'} cancelText="稍后打印" onConfirm={() => { if (!printing && pendingPrint) void printLabels([pendingPrint]).then(() => setPendingPrint(null)).catch((error) => { notify(error instanceof Error ? error.message : '打印失败，请重试', 'error'); setPendingPrint(null); }); }} onCancel={() => { if (!printing) setPendingPrint(null); }} />
    {toast && <div role="status" aria-live="polite" className={'fixed bottom-5 right-5 z-[120] flex max-w-[calc(100vw-2.5rem)] items-center gap-3 rounded-xl border px-4 py-3 text-sm shadow-lg backdrop-blur-xl ' + (toast.tone === 'error' ? 'border-danger/20 bg-white/95 text-danger' : 'border-success/20 bg-white/95 text-success')}><span>{toast.text}</span><button type="button" onClick={() => setToast(null)} aria-label="关闭提示"><X className="h-4 w-4" /></button></div>}
    {printPortal}
  </div>;
}

function DetailValue({ label, value, wide }: { label: string; value: string; wide?: boolean }) {
  return <div className={`min-w-0 ${wide ? 'sm:col-span-2' : ''}`}><dt className="text-[11px] text-ink-soft">{label}</dt><dd className="mt-0.5 text-[13px] break-words whitespace-pre-wrap text-ink-deep">{value}</dd></div>;
}

function ExchangeMachineCard({ direction, status, sn, name, warehouse, tracking }: { direction: 'in' | 'out'; status: string; sn?: string | null; name?: string; warehouse?: string | null; tracking: string }) {
  const inbound = direction === 'in';
  const DirectionIcon = inbound ? ArrowDownToLine : ArrowUpFromLine;
  return <section className={`min-w-0 rounded-xl border p-3 ${inbound ? 'border-line bg-white/85' : 'border-primary/15 bg-primary/5'}`}>
    <h3 className="flex items-center gap-1.5 text-xs font-semibold text-ink-deep">
      <DirectionIcon aria-hidden="true" className={`h-3.5 w-3.5 shrink-0 ${inbound ? 'text-ink-soft' : 'text-primary'}`} />
      {inbound ? '客户寄回的原机 A' : '寄给客户的替换机 B'}
    </h3>
    {name && <p className="mt-1 break-words text-xs text-ink-soft">{name}</p>}
    {sn && <p className="mt-1 font-mono text-sm font-semibold break-all text-ink-deep">SN {sn}</p>}
    <p className="mt-1 text-xs break-words text-ink-deep">{status}{warehouse ? ` · ${!inbound && status === '已出库' ? '发货仓：' : ''}${warehouse}` : ''}</p>
    <p className="mt-2 border-t border-line/70 pt-1.5 text-xs break-all text-ink-soft">
      {inbound ? '客户寄回' : '寄给客户'}运单：<span className="font-mono text-ink-deep">{tracking}</span>
    </p>
  </section>;
}

