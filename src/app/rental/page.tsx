'use client';

import { FormEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CalendarPlus, ChevronLeft, ChevronRight, CircleDollarSign, Copy, Laptop, List, MessageSquareText, Pencil, Plus, RotateCcw, Search, X } from 'lucide-react';
import Link from 'next/link';
import CustomSelect, { SelectOption } from '@/components/CustomSelect';
import BusinessDialog from '@/components/BusinessDialog';
import MachineSearchInput from '@/components/MachineSearchInput';
import { useWorkspace, useWorkspaceDirty } from '@/components/WorkspaceContext';
import { useMachineEligibility } from '@/components/useMachineEligibility';
import { formatDisplayDateTime } from '@/lib/display-date-time';
import { formatProductName } from '@/lib/product-name';
import { formatCPUDisplay } from '@/lib/sku-display';
import { addRentalDays, addRentalMonths, calculateRentalDuration } from '@/lib/rental-duration';

type InventoryItem = { id: string; sn: string; brand: string; model: string; year: number | null; cpu: string; ram: string; storage: string; purchasePrice: number; supplierName: string };
type Warehouse = { id: string; name: string; status: string };
type RentalEvent = { id?: string; eventType?: string; note?: string | null; actorName?: string | null; actorId?: string | null; createdAt?: string; afterData?: string | null };
type Billing = 'day' | 'month' | 'fixed';
type RentalRenewal = { id: string; batchId: string; periodStartDate: string; previousEndDate: string; newEndDate: string; billingUnit: Billing; duration: number; priceMode: string; unitPrice: number; totalAmount: number; depositBefore: number; depositDelta: number; depositAfter: number; depositChangeReason: string | null; note: string | null; actorName: string; createdAt: string };
type Rental = { id: string; rentalOrderId: string | null; orderKey?: string; rentalNo: string; displayRentalNo?: string; orderMachineCount?: number; inventoryId: string; sn: string; currentInventorySn: string | null; brand: string; model: string; year: number | null; warehouseId: string | null; config: string; customerName: string; customerPhone: string; customerAddress: string; handlerUserId: string | null; handlerName: string | null; salespersonName: string | null; sourceType: string | null; platformName: string | null; platformOrderNo: string | null; rentalStartDate: string; rentalEndDate: string; rentalType: string; rentalUnitPrice: number; rentalDuration: number; rentalTotalPrice: number; renewalTotal?: number; cumulativeRentalAmount?: number; daysUntilDue?: number | null; renewals?: RentalRenewal[]; deposit: number; status: string; returnDate: string | null; returnType: string | null; remark: string | null; salesRecordId?: string | null; saleTransactionType?: string | null; buyoutBuyerName?: string | null; buyoutSource?: string | null; depositRefundAmount?: number; depositAppliedAmount?: number; depositRetainedAmount?: number; settlementAdjustment?: number; settlementNote?: string | null; events?: RentalEvent[] };
type RentalTerms = { rentalUnitPrice: string; rentalTotalPrice: string; deposit: string };
type RentalAppendTarget = { orderId: string; orderKey: string; rentalNo: string; customerName: string; rentalType: Billing };
type OrderSummary = { key: string; rentalNo: string; customerName: string; totalCount: number; matchedCount: number; activeCount: number; returnedCount: number; boughtOutCount: number; nearestDueDate: string | null; latestReturnDate: string | null; totalPrice: number };
type OrderDetail = { order: OrderSummary; items: Rental[] };
type ListView = 'orders' | 'machines';
type DueFilter = 'all' | 'overdue' | 'today' | 'soon';
type Summary = Record<Exclude<DueFilter, 'all'>, number>;
type HandlerUser = { id: string; username: string; realName: string | null; status: string };
type ToastMessage = { text: string; tone: 'success' | 'error' };
type RentalAction = 'renew' | 'buyout' | 'exception' | 'cancel_buyout' | 'edit_terms' | null;
type RenewalPriceMode = 'original_unit' | 'custom_unit' | 'custom_total';
type RenewalMode = 'duration' | 'date';

function dateInput(offset = 0) {
  return new Date(Date.now() + (8 + offset * 24) * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function dueText(date: string | null, offset?: number | null) {
  if (!date) return '';
  const days = offset ?? (Date.parse(date) - Date.parse(dateInput())) / 86400000;
  return days < 0 ? `已逾期 ${-days} 天` : days === 0 ? '今日到期' : days <= 3 ? `${days} 天后到期` : '';
}
function dueLabel(rental: Rental) { return rental.status === 'renting' ? dueText(rental.rentalEndDate, rental.daysUntilDue) : ''; }
function rentalStatusLabel(status: string) { return status === 'renting' ? '租赁中' : status === 'returned' ? '已归还' : status === 'purchased' ? '已买断出库' : '已结束'; }
function billingOf(value?: string): Billing { return value === 'fixed' ? 'fixed' : value === 'month' || value === 'monthly' ? 'month' : 'day'; }
function billingLabel(value?: string) { return billingOf(value) === 'fixed' ? '固定租金' : billingOf(value) === 'month' ? '按月计费' : '按日计费'; }
function validMoney(value: string, allowZero = false) { return /^\d+(?:\.\d{1,2})?$/.test(value) && Number.isSafeInteger(Math.round(Number(value) * 100)) && (allowZero || Number(value) > 0); }
function sumMoney(values: number[]) { return values.reduce((sum, value) => sum + Math.round(value * 100), 0) / 100; }
const BLANK_TERMS: RentalTerms = { rentalUnitPrice: '', rentalTotalPrice: '', deposit: '' };
const EMPTY_SUMMARY: Summary = { overdue: 0, today: 0, soon: 0 };

function money(value: number) { return '¥' + Number(value || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function configText(item: Pick<InventoryItem, 'cpu' | 'ram' | 'storage'>) { return [formatCPUDisplay(item.cpu), item.ram, item.storage].filter(Boolean).join(' · ') || '配置待补充'; }
function productName(item: { brand: string; model: string; year?: number | null }) { return formatProductName(item); }

function ModalShell({ title, subtitle, onClose, children, footer, wide = false }: { title: string; subtitle?: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  return <BusinessDialog title={title} description={subtitle} onClose={onClose} footer={footer} placement="side" size={wide ? 'wide' : 'default'}>{children}</BusinessDialog>;
}

async function rentalResource<T>(params: Record<string, string>, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/rentals?${new URLSearchParams(params)}`, { cache: 'no-store', signal });
  const payload = await response.json();
  if (!response.ok || !payload.success) throw new Error(payload.error?.message || '加载租赁记录失败');
  return payload.data as T;
}

export default function RentalPage() {
  const { active, user } = useWorkspace();
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [rentals, setRentals] = useState<Rental[]>([]);
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [summary, setSummary] = useState<Summary>(EMPTY_SUMMARY);
  const [view, setView] = useState<ListView>('orders');
  const [search, setSearch] = useState('');
  const [machineSearch, setMachineSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [due, setDue] = useState<DueFilter>('all');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [listMeta, setListMeta] = useState({ total: 0, page: 1, totalPages: 1 });
  const [listError, setListError] = useState('');
  const [openedOrder, setOpenedOrder] = useState<OrderDetail | null>(null);
  const [detailPending, setDetailPending] = useState(false);
  const [backToOrder, setBackToOrder] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [rentalTerms, setRentalTerms] = useState<Record<string, RentalTerms>>({});
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [customerAddress, setCustomerAddress] = useState('');
  const [handlerUserId, setHandlerUserId] = useState('');
  const [handlerName, setHandlerName] = useState('');
  const [salespersonName, setSalespersonName] = useState('');
  const [sourceType, setSourceType] = useState('');
  const [platformName, setPlatformName] = useState('');
  const [platformOrderNo, setPlatformOrderNo] = useState('');
  const [handlerUsers, setHandlerUsers] = useState<HandlerUser[]>([]);
  const [handlerLoadError, setHandlerLoadError] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [rentalType, setRentalType] = useState<Billing>('day');
  const [unitPrice, setUnitPrice] = useState('');
  const [fixedPrice, setFixedPrice] = useState('');
  const [createStep, setCreateStep] = useState(1);
  const [deposit, setDeposit] = useState('');
  const [remark, setRemark] = useState('');
  const [returnDate, setReturnDate] = useState('');
  const [returnType, setReturnType] = useState('正常归还');
  const [returnWarehouseId, setReturnWarehouseId] = useState('');
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [warehouseLoadError, setWarehouseLoadError] = useState('');
  const [selectedRenewalIds, setSelectedRenewalIds] = useState<Set<string>>(() => new Set());
  const [rentalAction, setRentalAction] = useState<RentalAction>(null);
  const [newEndDate, setNewEndDate] = useState('');
  const [renewalTargets, setRenewalTargets] = useState<Rental[]>([]);
  const [renewalMode, setRenewalMode] = useState<RenewalMode>('duration');
  const [renewalBillingUnit, setRenewalBillingUnit] = useState<'day' | 'month'>('day');
  const [renewalDuration, setRenewalDuration] = useState('1');
  const [renewalPriceMode, setRenewalPriceMode] = useState<RenewalPriceMode>('original_unit');
  const [renewalUnitPrices, setRenewalUnitPrices] = useState<Record<string, string>>({});
  const [renewalTotalPrices, setRenewalTotalPrices] = useState<Record<string, string>>({});
  const [bulkRenewalPrice, setBulkRenewalPrice] = useState('');
  const [renewalDepositDeltas, setRenewalDepositDeltas] = useState<Record<string, string>>({});
  const [renewalDepositReason, setRenewalDepositReason] = useState('');
  const [renewalNote, setRenewalNote] = useState('');
  const [buyoutDate, setBuyoutDate] = useState('');
  const [buyoutPrice, setBuyoutPrice] = useState('');
  const [buyoutBuyerName, setBuyoutBuyerName] = useState('');
  const [buyoutSource, setBuyoutSource] = useState('');
  const [buyoutOrderNo, setBuyoutOrderNo] = useState('');
  const [buyoutDepositRefund, setBuyoutDepositRefund] = useState('0');
  const [buyoutDepositApplied, setBuyoutDepositApplied] = useState('0');
  const [buyoutDepositRetained, setBuyoutDepositRetained] = useState('0');
  const [buyoutSettlementAdjustment, setBuyoutSettlementAdjustment] = useState('0');
  const [buyoutSettlementNote, setBuyoutSettlementNote] = useState('');
  const [buyoutCancelReason, setBuyoutCancelReason] = useState('');
  const [exceptionNote, setExceptionNote] = useState('');
  const [editRentalStartDate, setEditRentalStartDate] = useState('');
  const [editRentalEndDate, setEditRentalEndDate] = useState('');
  const [editRentalPrices, setEditRentalPrices] = useState<Record<string, string>>({});
  const [editRentalReason, setEditRentalReason] = useState('');
  const [editScope, setEditScope] = useState<'dates' | 'prices'>('dates');
  const [createOpen, setCreateOpen] = useState(false);
  const [appendTarget, setAppendTarget] = useState<RentalAppendTarget | null>(null);
  const [selectedRental, setSelectedRental] = useState<Rental | null>(null);
  const [returnOpen, setReturnOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [returning, setReturning] = useState(false);
  const [savingAction, setSavingAction] = useState(false);
  const [toast, setToast] = useState<ToastMessage | null>(null);

  const notify = (text: string, tone: ToastMessage['tone'] = 'success') => setToast({ text, tone });

  useEffect(() => {
    setStartDate((value) => value || dateInput());
    setEndDate((value) => value || dateInput(1));
    setReturnDate((value) => value || dateInput());
  }, []);

  const loadController = useRef<AbortController | null>(null);
  const detailController = useRef<AbortController | null>(null);
  const selectedIdsRef = useRef<string[]>([]);
  const formHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { selectedIdsRef.current = selectedIds; }, [selectedIds]);
  useEffect(() => {
    if (!rentalAction && !returnOpen && !createOpen) return;
    const frame = requestAnimationFrame(() => formHeading.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [rentalAction, returnOpen, createOpen, createStep]);
  const loadData = useCallback(async () => {
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    setLoading(true); setListError('');
        try {
      const payload = await rentalResource<{ items: (Rental | OrderSummary)[]; total: number; page: number; totalPages: number; summary: Summary }>({ resource: 'workspace', view, status, due, search, page: String(page), pageSize: String(pageSize) }, controller.signal);
      if (controller.signal.aborted) return;
      if (view === 'orders') setOrders(payload.items as OrderSummary[]);
      else setRentals(payload.items as Rental[]);
      setSummary(payload.summary);
      setListMeta({ total: payload.total, page: payload.page, totalPages: Math.max(1, payload.totalPages) });
    } catch (error) {
      if (!controller.signal.aborted) setListError(error instanceof Error ? error.message : '加载租赁记录失败');
    } finally { if (!controller.signal.aborted) setLoading(false); }
  }, [view, status, due, search, page, pageSize]);

  useEffect(() => {
    if (!active) return;
    const timer = window.setTimeout(() => { void loadData(); }, 200);
    return () => { window.clearTimeout(timer); loadController.current?.abort(); };
  }, [active, loadData]);

  const [inventoryError, setInventoryError] = useState('');
  useEffect(() => {
    if (!active || !createOpen || createStep !== 1) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch('/api/inventory/lookup?context=rental&limit=12&q=' + encodeURIComponent(machineSearch), { cache: 'no-store', signal: controller.signal });
        const payload = await response.json();
        if (!response.ok || !payload.success) throw new Error(payload.error?.message || '加载可租机器失败');
        if (controller.signal.aborted) return;
        const next: InventoryItem[] = payload.data?.items || [];
        setInventory(current => [...next, ...current.filter(item => selectedIdsRef.current.includes(item.id) && !next.some(row => row.id === item.id))]);
        setInventoryError('');
      } catch (error) {
        if (!controller.signal.aborted) setInventoryError(error instanceof Error ? error.message : '加载可租机器失败');
      }
    }, 200);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [active, createOpen, createStep, machineSearch]);

  useEffect(() => {
    if (!active || !createOpen || appendTarget) return;
    const controller = new AbortController();
    fetch('/api/users?status=active', { cache: 'no-store', signal: controller.signal })
      .then(response => response.json().then(payload => {
        if (!response.ok || !payload.success) throw new Error(payload.error?.message || '加载经手人账号失败');
        setHandlerUsers((payload.data?.users || []).filter((entry: HandlerUser) => entry.status === 'active'));
        setHandlerLoadError('');
      }))
      .catch(error => { if (!controller.signal.aborted) setHandlerLoadError(error instanceof Error ? error.message : '加载经手人账号失败'); });
    return () => controller.abort();
  }, [active, createOpen, appendTarget]);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    fetch('/api/warehouses', { cache: 'no-store', signal: controller.signal })
      .then(response => response.json().then(payload => {
        if (!response.ok || !payload.success) throw new Error(payload.error?.message || '加载仓库失败');
        setWarehouses((payload.data || []).filter((entry: Warehouse) => entry.status === 'active'));
        setWarehouseLoadError('');
      }))
      .catch(error => { if (!controller.signal.aborted) setWarehouseLoadError(error instanceof Error ? error.message : '加载仓库失败'); });
    return () => controller.abort();
  }, [active]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 3800);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const selectedMachines = useMemo(() => inventory.filter(item => selectedIds.includes(item.id)), [inventory, selectedIds]);
  const selectedRentalOrder = openedOrder;
  const selectedOrderHasMixedTerms = Boolean(selectedRentalOrder?.items.length && selectedRentalOrder.items.some(item =>
    item.rentalStartDate !== selectedRentalOrder.items[0].rentalStartDate ||
    item.rentalEndDate !== selectedRentalOrder.items[0].rentalEndDate ||
    billingOf(item.rentalType) !== billingOf(selectedRentalOrder.items[0].rentalType)));
  const selectedOrderCanEditTerms = Boolean(selectedRentalOrder?.items.length && !selectedOrderHasMixedTerms && selectedRentalOrder.items.every(item => item.status === 'renting' && !(item.renewals?.length)));
  const orderActiveItems = openedOrder?.items.filter(item => item.status === 'renting') ?? [];
  const canAppend = Boolean(orderActiveItems[0]?.rentalOrderId && new Set(orderActiveItems.map(item => billingOf(item.rentalType))).size === 1);
  const orderRenewalTargets = orderActiveItems.filter(item => selectedRenewalIds.has(item.id));
  const renewingFixed = renewalTargets.some(item => billingOf(item.rentalType) === 'fixed');
  const returnedTo = selectedRental && rentalReturnWarehouse(selectedRental);
  const validity = useMachineEligibility(selectedMachines.map(({ id, sn }) => ({ id, sn })), 'rental');
  useWorkspaceDirty(Boolean((createOpen && (selectedIds.length || customerName || customerPhone || customerAddress || salespersonName || sourceType || platformName || platformOrderNo || remark || rentalType !== 'day')) || returnOpen || rentalAction));
  const duration = calculateRentalDuration(startDate, endDate, rentalType === 'month' ? 'month' : 'day');
  const currentRentField = rentalType === 'fixed' ? 'rentalTotalPrice' : 'rentalUnitPrice';
  const totalPrice = sumMoney(selectedIds.map(id => (Number(rentalTerms[id]?.[currentRentField]) || 0) * (rentalType === 'fixed' ? 1 : duration)));
  const totalDeposit = sumMoney(selectedIds.map(id => Number(rentalTerms[id]?.deposit) || 0));
  const priceHeading = rentalType === 'fixed' ? '本期固定租金' : rentalType === 'month' ? '每月租金' : '每日租金';
  const renewalEndFor = (rental: Rental) => renewalMode === 'duration'
    ? renewalBillingUnit === 'month'
      ? addRentalMonths(rental.rentalEndDate, Math.max(1, Number(renewalDuration) || 1)) || ''
      : addRentalDays(rental.rentalEndDate, Math.max(1, Number(renewalDuration) || 1)) || ''
    : newEndDate;
  const renewalDurationFor = (rental: Rental) => calculateRentalDuration(rental.rentalEndDate, renewalEndFor(rental), renewalBillingUnit);
  const editRentalDuration = calculateRentalDuration(editRentalStartDate, editRentalEndDate, billingOf(selectedRental?.rentalType) === 'month' ? 'month' : 'day');
  const renewalAmountFor = (rental: Rental) => {
    const units = renewalDurationFor(rental);
    if (renewalPriceMode === 'custom_total') return Number(renewalTotalPrices[rental.id] || 0);
    const rate = renewalPriceMode === 'custom_unit' ? Number(renewalUnitPrices[rental.id] || 0) : Number(rental.rentalUnitPrice || 0);
    return Math.round(rate * units * 100) / 100;
  };
  const customRenewalPriceMissing = renewalPriceMode === 'custom_total'
    ? renewalTargets.some(rental => !(renewalTotalPrices[rental.id] ?? '').trim())
    : renewalPriceMode === 'custom_unit' && renewalTargets.some(rental => !(renewalUnitPrices[rental.id] ?? '').trim());

  const resetCreateForm = () => {
    setAppendTarget(null); setSelectedIds([]); setRentalTerms({}); setCustomerName(''); setCustomerPhone(''); setCustomerAddress('');
    setHandlerUserId(''); setHandlerName(''); setSalespersonName(''); setSourceType(''); setPlatformName(''); setPlatformOrderNo('');
    setStartDate(dateInput()); setEndDate(dateInput(1)); setRentalType('day'); setUnitPrice(''); setFixedPrice(''); setDeposit(''); setRemark(''); setMachineSearch(''); setCreateStep(1); setInventoryError('');
  };

  const addMachine = (item: InventoryItem) => {
    setInventory(current => [item, ...current.filter(row => row.id !== item.id)]);
    setSelectedIds(current => current.includes(item.id) ? current : [...current, item.id]);
    setRentalTerms(current => current[item.id] ? current : { ...current, [item.id]: { rentalUnitPrice: unitPrice, rentalTotalPrice: fixedPrice, deposit } });
  };

  const openAppendMachines = (order: OrderDetail) => {
    const activeItems = order.items.filter(item => item.status === 'renting');
    const first = activeItems[0];
    if (!first?.rentalOrderId || !canAppend) {
      notify('该租赁单已结束或计费方式不一致，暂不能追加机器', 'error');
      return;
    }
    const rentalType = billingOf(first.rentalType);
    const start = dateInput();
    const latestEnd = activeItems.map(item => item.rentalEndDate).sort().at(-1) || '';
    const end = latestEnd > start && calculateRentalDuration(start, latestEnd, rentalType === 'month' ? 'month' : 'day') > 0
      ? latestEnd
      : rentalType === 'month' ? addRentalMonths(start, 1) || '' : addRentalDays(start, 1) || '';
    resetCreateForm();
    setAppendTarget({ orderId: first.rentalOrderId, orderKey: order.order.key, rentalNo: order.order.rentalNo, customerName: first.customerName, rentalType });
    setCustomerName(first.customerName);
    setCustomerPhone(first.customerPhone);
    setCustomerAddress(first.customerAddress);
    setHandlerUserId(first.handlerUserId || '');
    setHandlerName(first.handlerName || '');
    setSalespersonName(first.salespersonName || '');
    setSourceType(first.sourceType || '');
    setPlatformName(first.platformName || '');
    setPlatformOrderNo(first.platformOrderNo || '');
    setStartDate(start);
    setEndDate(end);
    setRentalType(rentalType);
    if (rentalType !== 'fixed') setUnitPrice(String(first.rentalUnitPrice));
    setDeposit(String(first.deposit || 0));
    setRemark(first.remark || '');
    setCreateOpen(true);
  };

  const updateRentalTerm = (id: string, key: keyof RentalTerms, value: string) => {
    setRentalTerms(current => ({ ...current, [id]: { ...(current[id] || BLANK_TERMS), [key]: value } }));
  };

  const createStepError = (step: number) => {
    if (step === 1) {
      if (!selectedIds.length) return '请至少选择一台可租机器';
      if (validity.checking || validity.error || validity.invalidIds.length) return validity.error || '请等待可租状态检查，或移除已不可租的机器';
    }
    if (step === 2) {
      if (!appendTarget && (!customerName.trim() || !customerPhone.trim() || !customerAddress.trim())) return '请填写客户姓名、联系电话和地址';
      if (!appendTarget && (!handlerUserId || !salespersonName.trim())) return '请确认经手账号并填写业务员';
      if (!appendTarget && (sourceType !== 'online' && sourceType !== 'offline')) return '请选择线上或线下租赁来源';
      if (!appendTarget && sourceType === 'online' && (!platformName.trim() || !platformOrderNo.trim())) return '线上租赁请填写平台和平台订单号';
      if (!duration) return rentalType === 'month' ? '租期至少需要包含一个完整计费月' : '到期日必须晚于起租日';
    }
    if (step === 3 && selectedIds.some(id => !validMoney(rentalTerms[id]?.[currentRentField] || '') || !validMoney(rentalTerms[id]?.deposit || '0', true))) return '请填写每台机器有效的租金和押金，金额最多两位小数';
    return '';
  };

  const closeCreate = () => {
    if (submitting) return;
    if ((selectedIds.length || customerName && !appendTarget || unitPrice || fixedPrice || salespersonName && !appendTarget || handlerUserId && !appendTarget || sourceType && !appendTarget || rentalType !== 'day' && !appendTarget || remark && !appendTarget) &&
        !window.confirm('关闭后将丢弃这次尚未保存的录入，确定关闭吗？')) return;
    setCreateOpen(false); resetCreateForm();
  };

  const submitRental = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    for (let step = 1; step <= createStep; step++) {
      const error = createStepError(step);
      if (error) { notify(error, 'error'); setCreateStep(step); return; }
    }
    if (createStep < 3) { setCreateStep(createStep + 1); return; }
    setSubmitting(true);
    const appendAtSubmit = appendTarget;
    try {
      const response = await fetch('/api/rentals', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: selectedIds.map(inventoryId => ({ inventoryId, [currentRentField]: Number(rentalTerms[inventoryId]?.[currentRentField]), deposit: Number(rentalTerms[inventoryId]?.deposit || 0) })), ...(appendAtSubmit ? { rentalOrderId: appendAtSubmit.orderId } : { customerName, customerPhone, customerAddress, handlerUserId, salespersonName, sourceType, platformName, platformOrderNo }), rentalStartDate: startDate, rentalEndDate: endDate, rentalType, remark }) });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error?.message || '创建租赁记录失败');
      setCreateOpen(false); resetCreateForm(); notify(appendAtSubmit ? `已向租赁单 ${appendAtSubmit.rentalNo} 追加 ${payload.data.count} 台机器` : '租赁单 ' + payload.data.rentalNo + ' 已创建，共 ' + payload.data.count + ' 台');
      if (appendAtSubmit) await Promise.all([loadData(), refreshOrder(appendAtSubmit.orderKey)]);
      else await loadData();
    } catch (submitError) { notify(submitError instanceof Error ? submitError.message : '创建租赁记录失败', 'error'); } finally { setSubmitting(false); }
  };

  const completeReturn = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedRental) return;
    if (!returnWarehouseId) { notify('请选择实际接收仓库', 'error'); return; }
    setReturning(true);
    try {
      const response = await fetch('/api/rentals', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: selectedRental.id, action: 'return', returnDate, returnType, returnWarehouseId }) });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error?.message || '归还失败');
      const updated = { ...selectedRental, status: 'returned', returnDate, returnType, warehouseId: returnWarehouseId };
      setSelectedRental(updated);
      setReturnOpen(false);
      notify('租赁单 ' + selectedRental.rentalNo + ' 已归还');
      await refreshDetails(updated);
    } catch (returnError) { notify(returnError instanceof Error ? returnError.message : '归还失败', 'error'); } finally { setReturning(false); }
  };

  const beginRenewal = (targets: Rental[]) => {
    if (!targets.length || targets.some(item => item.status !== 'renting')) return;
    const first = targets[0];
    setSelectedRental(first); setRenewalTargets(targets); setRentalAction('renew'); setReturnOpen(false);
    const fixed = targets.some(item => billingOf(item.rentalType) === 'fixed');
    const originalUnits = new Set(targets.map(item => billingOf(item.rentalType)));
    setRenewalMode(fixed ? 'date' : 'duration'); setRenewalBillingUnit(billingOf(first.rentalType) === 'month' ? 'month' : 'day'); setRenewalDuration('1');
    setNewEndDate(addRentalDays(targets.map(item => item.rentalEndDate).sort().at(-1) || first.rentalEndDate, 1) || ''); setRenewalPriceMode(fixed || originalUnits.size > 1 ? 'custom_total' : 'original_unit');
    setRenewalUnitPrices(Object.fromEntries(targets.map(item => [item.id, String(item.rentalUnitPrice || 0)])));
    setRenewalTotalPrices(Object.fromEntries(targets.map(item => [item.id, ''])));
    setRenewalDepositDeltas(Object.fromEntries(targets.map(item => [item.id, '0'])));
    setBulkRenewalPrice(''); setRenewalDepositReason(''); setRenewalNote('');
  };

  const openRentalAction = (action: Exclude<RentalAction, null>) => {
    if (!selectedRental) return;
    if (action === 'renew') { beginRenewal([selectedRental]); return; }
    if (action === 'edit_terms') {
      if (!selectedRentalOrder || !selectedOrderCanEditTerms) {
        notify('订单已有续租记录或已结束，不能覆盖原租赁条款', 'error');
        return;
      }
      setEditRentalStartDate(selectedRentalOrder.items[0].rentalStartDate);
      setEditRentalEndDate(selectedRentalOrder.items[0].rentalEndDate);
      setEditRentalPrices(Object.fromEntries(selectedRentalOrder.items.map(item => [item.id, String(billingOf(item.rentalType) === 'fixed' ? item.rentalTotalPrice : item.rentalUnitPrice)])));
      setEditScope('dates'); setEditRentalReason(''); setRentalAction(action); return;
    }
    if (action === 'buyout') {
      if (selectedRental.status !== 'renting') return;
      setRentalAction(action); setBuyoutDate(dateInput()); setBuyoutPrice(''); setBuyoutBuyerName(selectedRental.customerName);
      setBuyoutSource(''); setBuyoutOrderNo(''); setBuyoutDepositRefund(String(Number(selectedRental.deposit || 0)));
      setBuyoutDepositApplied('0'); setBuyoutDepositRetained('0'); setBuyoutSettlementAdjustment('0'); setBuyoutSettlementNote('');
      return;
    }
    if (action === 'cancel_buyout') {
      if (selectedRental.status !== 'purchased' || selectedRental.returnType !== '客户买断') return;
      setRentalAction(action); setBuyoutCancelReason(''); return;
    }
    if (selectedRental.status !== 'renting') return;
    setRentalAction(action); setExceptionNote('');
  };

  const submitRentalAction = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedRental || !rentalAction) return;
    let body: Record<string, unknown>;
    if (rentalAction === 'renew') {
      if (!renewalTargets.length) { notify('请选择需要续租的机器', 'error'); return; }
      const items = renewalTargets.map(rental => {
        const endDate = renewalEndFor(rental);
        const totalText = renewalTotalPrices[rental.id] ?? '';
        const unitText = renewalUnitPrices[rental.id] ?? '';
        const total = renewalPriceMode === 'custom_total' && totalText.trim() ? Number(totalText) : undefined;
        const unit = renewalPriceMode === 'custom_unit' && unitText.trim() ? Number(unitText) : undefined;
        return { id: rental.id, newEndDate: endDate, billingUnit: renewalPriceMode === 'custom_total' ? 'fixed' : renewalBillingUnit, priceMode: renewalPriceMode, unitPrice: unit, totalAmount: total, depositDelta: Number(renewalDepositDeltas[rental.id] || 0), depositChangeReason: renewalDepositReason.trim(), note: renewalNote.trim() };
      });
      const invalidDate = renewalTargets.find(rental => !renewalEndFor(rental) || renewalEndFor(rental) <= rental.rentalEndDate);
      if (invalidDate) { notify(`SN ${invalidDate.sn} 的新到期日必须晚于当前到期日`, 'error'); return; }
      if (renewalPriceMode === 'custom_unit' && renewalTargets.some(rental => !(renewalUnitPrices[rental.id] ?? '').trim())) { notify('请填写每台机器的续租单价', 'error'); return; }
      if (renewalPriceMode === 'custom_unit' && items.some(item => !Number.isFinite(item.unitPrice) || Number(item.unitPrice) < 0)) { notify('请填写每台机器有效的续租单价', 'error'); return; }
      if (renewalPriceMode === 'custom_total' && renewalTargets.some(rental => !(renewalTotalPrices[rental.id] ?? '').trim())) { notify('请填写每台机器的本次续租总额', 'error'); return; }
      if (renewalPriceMode === 'custom_total' && renewalTargets.some(item => !validMoney(renewalTotalPrices[item.id] || '', true))) { notify('请填写每台机器有效的本次租金，金额最多两位小数', 'error'); return; }
      if (renewalTargets.some(rental => renewalAmountFor(rental) === 0) && !renewalNote.trim()) { notify('续租金额为 0 时，请填写原因', 'error'); return; }
      if (items.some(item => !Number.isFinite(item.depositDelta) || Number(item.depositDelta) + Number(renewalTargets.find(target => target.id === item.id)?.deposit || 0) < 0)) { notify('押金退还金额不能超过当前押金', 'error'); return; }
      if (items.some(item => item.depositDelta !== 0) && !renewalDepositReason.trim()) { notify('请填写押金调整原因', 'error'); return; }
      body = items.length === 1 ? { action: 'renew', ...items[0] } : { action: 'renew_batch', items };
    } else if (rentalAction === 'edit_terms') {
      const orderItems = selectedRentalOrder?.items || [];
      if (!orderItems.length || !selectedOrderCanEditTerms) { notify('订单已有续租记录或已结束，不能覆盖原租赁条款', 'error'); return; }
      if (!editRentalReason.trim()) { notify('请填写条款更正原因', 'error'); return; }
      if (editScope === 'dates' && !editRentalDuration) { notify('到期日必须晚于起租日；按月计费需至少一个完整计费月', 'error'); return; }
      const fixed = billingOf(selectedRental.rentalType) === 'fixed';
      if (editScope === 'prices' && orderItems.some(item => !validMoney(editRentalPrices[item.id] || ''))) { notify('请为每台机器填写大于 0 的有效租金', 'error'); return; }
      body = {
        id: selectedRental.id, action: 'edit_terms',
        rentalStartDate: editScope === 'dates' ? editRentalStartDate : selectedRentalOrder?.items[0].rentalStartDate,
        rentalEndDate: editScope === 'dates' ? editRentalEndDate : selectedRentalOrder?.items[0].rentalEndDate,
        reason: editRentalReason.trim(), note: editRentalReason.trim(),
        items: editScope === 'dates' ? [] : orderItems.map(item => ({ id: item.id, [fixed ? 'rentalTotalPrice' : 'rentalUnitPrice']: Number(editRentalPrices[item.id]) })),
      };
    } else if (rentalAction === 'buyout') {
      const refund = Number(buyoutDepositRefund); const applied = Number(buyoutDepositApplied); const retained = Number(buyoutDepositRetained);
      if (!buyoutBuyerName.trim() || !buyoutSource.trim()) { notify('请填写买断方和买断来源/渠道', 'error'); return; }
      if (!Number.isFinite(Number(buyoutPrice)) || Number(buyoutPrice) < 0) { notify('请填写有效的买断金额', 'error'); return; }
      if (![refund, applied, retained].every(Number.isFinite) || [refund, applied, retained].some(value => value < 0) || Math.round((refund + applied + retained) * 100) !== Math.round(Number(selectedRental.deposit || 0) * 100)) { notify(`押金退款、抵扣和留存合计须等于 ${money(Number(selectedRental.deposit || 0))}`, 'error'); return; }
      body = { id: selectedRental.id, action: 'buyout', saleDate: buyoutDate, sellingPrice: Number(buyoutPrice), buyerName: buyoutBuyerName.trim(), buyoutSource: buyoutSource.trim(), saleOrderNo: buyoutOrderNo.trim() || undefined, depositRefundAmount: refund, depositAppliedAmount: applied, depositRetainedAmount: retained, settlementAdjustment: Number(buyoutSettlementAdjustment || 0), settlementNote: buyoutSettlementNote.trim() };
    } else if (rentalAction === 'cancel_buyout') {
      if (!buyoutCancelReason.trim()) { notify('请填写撤销原因', 'error'); return; }
      body = { id: selectedRental.id, action: 'cancel_buyout', reason: buyoutCancelReason.trim() };
    } else {
      if (selectedRental.status !== 'renting') return;
      if (!exceptionNote.trim()) { notify('请填写异常跟进内容', 'error'); return; }
      body = { id: selectedRental.id, action: 'exception', note: exceptionNote.trim() };
    }
    setSavingAction(true);
    try {
      const response = await fetch('/api/rentals', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error?.message || '处理失败');
      const actionLabel = rentalAction === 'renew' ? `续租已登记 ${renewalTargets.length} 台` : rentalAction === 'buyout' ? '买断出库已完成' : rentalAction === 'cancel_buyout' ? '买断已撤销，机器恢复租赁中' : rentalAction === 'edit_terms' ? `已保存租赁更正 · ${payload.data.count} 台` : '异常跟进已记录';
      setRentalAction(null);
      setRenewalTargets([]); setSelectedRenewalIds(new Set());
      notify(actionLabel);
      await refreshDetails(selectedRental);
      if (backToOrder && listActionRef.current === 'order') setSelectedRental(null);
    } catch (error) { notify(error instanceof Error ? error.message : '处理失败', 'error'); }
    finally { setSavingAction(false); }
  };

  const fetchOrder = (key: string, signal?: AbortSignal) => rentalResource<OrderDetail>({ resource: 'order-detail', orderKey: key }, signal);
  const fetchMachine = (id: string, signal?: AbortSignal) => rentalResource<Rental>({ resource: 'machine-detail', id }, signal);
  const orderKeyOf = (item: Rental) => item.orderKey || (item.rentalOrderId ? `order:${item.rentalOrderId}` : `legacy:${item.id}`);
  const refreshOrder = async (key: string) => {
    try {
      const next = await fetchOrder(key);
      setOpenedOrder(current => current?.order.key === key ? next : current);
    } catch { notify('操作已保存，订单详情刷新失败，请重新打开订单', 'error'); }
  };
  const refreshDetails = async (rental: Rental) => {
    try {
      const [, order] = await Promise.all([loadData(), fetchOrder(orderKeyOf(rental))]);
      setOpenedOrder(current => current?.order.key === order.order.key ? order : current);
      const machine = order.items.find(item => item.id === rental.id);
      if (machine) setSelectedRental(current => current?.id === rental.id ? machine : current);
    } catch { notify('操作已保存，详情刷新失败，请重新打开记录', 'error'); }
  };
  const openOrder = async (key: string) => {
    detailController.current?.abort();
    const controller = new AbortController(); detailController.current = controller;
    setDetailPending(true);
    try {
      const next = await fetchOrder(key, controller.signal);
      if (controller.signal.aborted) return;
      setSelectedRental(null); setOpenedOrder(next); setSelectedRenewalIds(new Set());
      setRenewalTargets([]); setReturnOpen(false); setRentalAction(null); setBackToOrder(false);
    } catch (error) {
      if (!controller.signal.aborted) notify(error instanceof Error ? error.message : '加载订单失败', 'error');
    } finally { if (!controller.signal.aborted) setDetailPending(false); }
  };
  const openRentalDetail = async (rental: Rental, fromOrder = false) => {
    detailController.current?.abort();
    const controller = new AbortController(); detailController.current = controller;
    setDetailPending(true);
    try {
      const row = fromOrder ? rental : await fetchMachine(rental.id, controller.signal);
      if (controller.signal.aborted) return;
      if (!fromOrder) setOpenedOrder(null);
      listActionRef.current = 'machine'; setSelectedRental(row); setBackToOrder(fromOrder); setRenewalTargets([]); setReturnOpen(false); setRentalAction(null);
    } catch (error) {
      if (!controller.signal.aborted) notify(error instanceof Error ? error.message : '加载机器详情失败', 'error');
    } finally { if (!controller.signal.aborted) setDetailPending(false); }
  };
  const closeMachine = () => {
    if (savingAction || returning) return;
    if ((returnOpen || rentalAction) && !window.confirm('当前操作尚未保存，确定关闭吗？')) return;
    setSelectedRental(null); setRenewalTargets([]); setReturnOpen(false); setRentalAction(null);
    if (!backToOrder) setOpenedOrder(null);
  };
  const exitAction = () => {
    setReturnOpen(false); setRentalAction(null); setRenewalTargets([]);
    if (backToOrder && listActionRef.current === 'order') setSelectedRental(null);
  };
  const listActionRef = useRef<'machine' | 'order'>('machine');
  const toggleRenewalSelection = (id: string) => setSelectedRenewalIds(current => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const switchView = (next: ListView) => {
    if (view === next) return;
    setView(next); setStatus('all'); setPage(1); setLoading(true); setSelectedRenewalIds(new Set());
    try { window.localStorage.setItem('sugrid-rental-view', next); } catch { /* browser storage is optional */ }
  };
  useEffect(() => {
    try { if (window.localStorage.getItem('sugrid-rental-view') === 'machines') setView('machines'); } catch { /* browser storage is optional */ }
  }, []);
  const updateDue = (next: DueFilter) => { setDue(next); if (next !== 'all') setStatus('all'); setPage(1); setLoading(true); };
  const clearFilters = () => { setSearch(''); setStatus('all'); setDue('all'); setPage(1); setLoading(true); };
  const copySN = async (sn: string) => {
    if (!sn) return;
    try { await navigator.clipboard.writeText(sn); notify('已复制 SN'); }
    catch { notify('复制失败，请选中 SN 手动复制', 'error'); }
  };
  const statusOptions: SelectOption[] = [
    { value: 'all', label: '全部状态' }, { value: 'renting', label: view === 'orders' ? '仍有在租' : '租赁中' },
    { value: 'returned', label: view === 'orders' ? '全部已归还' : '已归还' }, { value: 'purchased', label: view === 'orders' ? '全部已买断' : '已买断' },
    ...(view === 'orders' ? [{ value: 'closed', label: '已结束（含混合）' }] : []),
  ];
  const typeOptions: SelectOption[] = [
    { value: 'day', label: '按日计费' }, { value: 'month', label: '按月计费' }, { value: 'fixed', label: '固定租金' },
  ];
  const sourceOptions: SelectOption[] = [
    { value: 'offline', label: '线下' }, { value: 'online', label: '线上' },
  ];
  const handlerOptions: SelectOption[] = [
    ...(user ? [{ value: user.id, label: `${user.realName || user.username}（当前账号）` }] : []),
    ...handlerUsers.filter(entry => entry.id !== user?.id).map(entry => ({ value: entry.id, label: `${entry.realName || entry.username}（${entry.username}）` })),
  ];
  const returnOptions: SelectOption[] = [
    { value: '正常归还', label: '正常归还' }, { value: '维修归还', label: '维修归还' }, { value: '其他', label: '其他' },
  ];
  const rows = view === 'orders' ? orders : rentals;
  const filtered = Boolean(search.trim() || status !== 'all' || due !== 'all');
  const orderEdit = () => {
    if (!openedOrder?.items[0] || !selectedOrderCanEditTerms) return;
    const items = openedOrder.items;
    listActionRef.current = 'order'; setBackToOrder(true); setSelectedRental(items[0]);
    setEditRentalStartDate(items[0].rentalStartDate); setEditRentalEndDate(items[0].rentalEndDate);
    setEditRentalPrices(Object.fromEntries(items.map(item => [item.id, String(billingOf(item.rentalType) === 'fixed' ? item.rentalTotalPrice : item.rentalUnitPrice)])));
    setEditScope('dates'); setEditRentalReason(''); setRentalAction('edit_terms');
  };
  const createSteps = ['选择机器', '客户与租期', '费用确认'];
  const listedInventory = inventory.filter(item => !selectedIds.includes(item.id));
  const applyBulkTerms = () => setRentalTerms(current => Object.fromEntries(selectedIds.map(id => [id, {
    ...(current[id] || BLANK_TERMS), ...((rentalType === 'fixed' ? fixedPrice : unitPrice) === '' ? {} : { [currentRentField]: rentalType === 'fixed' ? fixedPrice : unitPrice }), ...(deposit === '' ? {} : { deposit }),
  }])));
  const removeMachine = (id: string) => {
    setSelectedIds(current => current.filter(value => value !== id));
    setRentalTerms(current => { const next = { ...current }; delete next[id]; return next; });
  };
  const grid = 'grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 px-3 sm:px-4 md:grid-cols-[minmax(0,1.25fr)_minmax(0,1.15fr)_minmax(0,1fr)_minmax(80px,.65fr)_90px]';
  return <div className="mx-auto max-w-[1400px] space-y-4 pb-8 text-ink-deep">
    <header className="flex flex-wrap items-center justify-between gap-3 py-1.5">
      <div><h1 className="text-2xl font-bold tracking-tight">租赁管理</h1><p className="mt-1 hidden text-sm text-ink-soft sm:block">查看租赁进度、跟进到期和处理归还</p></div>
      <button type="button" onClick={() => { resetCreateForm(); setCreateOpen(true); }} className="btn-primary inline-flex items-center gap-1.5 transition-transform active:scale-[0.98]"><Plus className="h-4 w-4" />新建租赁</button>
    </header>
    <section aria-label="到期待办" className="grid grid-cols-3 divide-x divide-line overflow-hidden rounded-xl border border-line bg-white/95">
      {([{ key: 'overdue', label: '已逾期', color: 'text-danger' }, { key: 'today', label: '今日到期', color: 'text-amber-700' }, { key: 'soon', label: '未来 3 天', color: 'text-primary' }] as const).map(({ key, label, color }) => <button type="button" key={key} onClick={() => updateDue(due === key ? 'all' : key)} aria-pressed={due === key} className={`flex min-h-12 flex-wrap items-center gap-x-2 px-2.5 py-2 text-left transition-colors hover:bg-blue-50 sm:px-4 ${due === key ? 'bg-blue-50 ring-1 ring-inset ring-primary/40' : ''}`}><span className="text-xs text-ink-soft sm:text-sm">{label}</span><span className={`whitespace-nowrap text-sm font-semibold tabular-nums sm:ml-auto sm:text-base ${summary[key] ? color : 'text-ink-soft'}`}>{summary[key]} 台</span></button>)}
    </section>
    <section aria-label="租赁记录" className="overflow-hidden rounded-xl border border-line bg-white/95 shadow-sm">
      <div className="flex flex-wrap items-center gap-2.5 border-b border-line px-3 py-3 sm:px-4">
        <div role="group" aria-label="显示方式" className="inline-flex shrink-0 rounded-lg bg-slate-100 p-1">
          {([{ key: 'orders', label: '按订单', icon: List }, { key: 'machines', label: '按机器', icon: Laptop }] as const).map(({ key, label, icon: Icon }) => <button type="button" key={key} aria-pressed={view === key} onClick={() => switchView(key)} className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs font-medium sm:text-sm ${view === key ? 'bg-white text-primary shadow-sm' : 'text-ink-soft hover:text-ink-deep'}`}><Icon className="h-4 w-4" aria-hidden="true" />{label}</button>)}
        </div>
        <div className="relative order-last flex-[1_1_100%] md:order-none md:flex-[1_1_15rem]">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-soft" aria-hidden="true" />
          <input aria-label="搜索租赁记录" placeholder="搜索客户、订单号、SN 或型号" value={search} onChange={event => { setSearch(event.target.value); setPage(1); setLoading(true); }} className="field !pl-9 !pr-8" />
          {search && <button type="button" aria-label="清空搜索" onClick={() => { setSearch(''); setPage(1); setLoading(true); }} className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-ink-soft hover:bg-slate-100"><X className="h-4 w-4" /></button>}
        </div>
        <div className="ml-auto flex items-center gap-1">
          <select aria-label="租赁状态" value={status} onChange={event => { setStatus(event.target.value); setDue('all'); setPage(1); setLoading(true); }} className="field !w-auto !px-2 text-xs sm:text-sm">{statusOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
          <button type="button" aria-label="刷新租赁列表" title="刷新" disabled={loading} onClick={() => void loadData()} className="btn-ghost !p-2 text-ink-soft"><RotateCcw className={`h-4 w-4 ${loading ? 'motion-safe:animate-spin' : ''}`} /></button>
        </div>
      </div>
      {filtered && <div className="flex justify-between gap-2 border-b border-line px-4 py-2 text-xs text-ink-soft"><span>{due !== 'all' ? `到期筛选：${due === 'overdue' ? '已逾期' : due === 'today' ? '今日到期' : '未来 3 天'}` : '筛选结果'}</span><button type="button" onClick={clearFilters} className="text-primary hover:underline">清除筛选</button></div>}
      <div aria-busy={loading || detailPending} className="min-h-36">
      {loading ? <p role="status" className="p-10 text-center text-sm text-ink-soft">正在加载租赁记录…</p> : listError ? <div role="alert" className="space-y-2 p-8 text-center text-sm text-danger"><p>{listError}</p><button type="button" onClick={() => void loadData()} className="btn-secondary">重试</button></div> : !rows.length ? <div className="space-y-2 p-8 text-center text-sm"><p className="font-medium">{filtered ? '没有符合条件的租赁记录' : '暂无租赁记录'}</p><p className="text-ink-soft">{filtered ? '更换搜索词或清除筛选后再试。' : '新建租赁后，即可在这里跟进机器。'}</p></div> : <>
        <div aria-hidden="true" className={`${grid} hidden border-b border-line bg-slate-50 py-2.5 text-xs font-medium text-ink-soft md:grid`}><span>{view === 'orders' ? '客户 / 租赁单号' : '机器 / SN'}</span><span>{view === 'orders' ? '机器进度' : '客户 / 所属订单'}</span><span>状态 / 关键日期</span><span>约定租金</span><span className="text-right">操作</span></div>
        <ul className="divide-y divide-line/80">{view === 'orders' ? orders.map(order => <li key={order.key} className={`${grid} grid py-3 transition-colors hover:bg-blue-50/30`}>
          <div className="min-w-0"><p className="truncate text-sm font-semibold" title={order.customerName}>{order.customerName || '客户未记录'}</p><p className="mt-0.5 break-all font-mono text-xs text-ink-soft">{order.rentalNo}</p></div>
          <div className="col-start-1 row-start-2 text-xs text-ink-soft md:col-auto md:row-auto"><b className="text-ink-deep">共 {order.totalCount} 台</b> · {orderProgress(order)}{order.matchedCount !== order.totalCount && <p className="mt-0.5 text-primary">命中 {order.matchedCount} 台，共 {order.totalCount} 台</p>}</div>
          <div className="col-start-1 row-start-3 text-xs md:col-auto md:row-auto"><DueDate dueDate={order.nearestDueDate} returnDate={order.latestReturnDate} active={order.activeCount > 0} label="结单" /></div>
          <div className="col-start-2 row-start-1 text-right text-sm font-semibold tabular-nums md:col-auto md:row-auto md:text-left">{money(order.totalPrice)}</div>
          <button type="button" disabled={detailPending} onClick={() => void openOrder(order.key)} aria-label={`查看订单 ${order.rentalNo}`} className="col-start-2 row-start-2 justify-self-end whitespace-nowrap rounded-md px-1.5 py-2 text-xs font-medium text-primary hover:bg-blue-50 md:col-auto md:row-auto">查看订单 <ChevronRight className="inline h-3.5 w-3.5" /></button>
        </li>) : rentals.map(item => <li key={item.id} className={`${grid} grid py-3 transition-colors hover:bg-blue-50/30`}>
          <div className="min-w-0"><p className="truncate text-sm font-semibold" title={productName(item)}>{productName(item)}</p><SNButton value={item.sn} onCopy={copySN} />{item.currentInventorySn && item.currentInventorySn !== item.sn && <p className="break-all text-[11px] text-ink-soft">当前 SN：{item.currentInventorySn}</p>}</div>
          <div className="col-start-1 row-start-2 min-w-0 text-xs md:col-auto md:row-auto"><p className="truncate">{item.customerName}</p><button type="button" disabled={detailPending} onClick={() => void openOrder(orderKeyOf(item))} className="mt-0.5 break-all text-left font-mono text-primary hover:underline">{item.displayRentalNo || item.rentalNo}</button></div>
          <div className="col-start-1 row-start-3 text-xs md:col-auto md:row-auto"><p className="font-medium">{rentalStatusLabel(item.status)}</p><DueDate dueDate={item.rentalEndDate} returnDate={item.returnDate} active={item.status === 'renting'} label={item.status === 'purchased' ? '买断' : '归还'} days={item.daysUntilDue} /></div>
          <div className="col-start-2 row-start-1 text-right text-sm font-semibold tabular-nums md:col-auto md:row-auto md:text-left">{money(item.cumulativeRentalAmount ?? item.rentalTotalPrice)}</div>
          <button type="button" disabled={detailPending} onClick={() => void openRentalDetail(item)} aria-label={`查看机器 ${item.sn}`} className="col-start-2 row-start-2 justify-self-end whitespace-nowrap rounded-md px-1.5 py-2 text-xs font-medium text-primary hover:bg-blue-50 md:col-auto md:row-auto">查看机器 <ChevronRight className="inline h-3.5 w-3.5" /></button>
        </li>)}</ul>
      </>}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line bg-slate-50/80 px-3 py-2 text-xs text-ink-soft sm:px-4"><span>{loading || listError ? '租赁记录' : `共 ${listMeta.total} ${view === 'orders' ? '笔订单' : '条机器租赁记录'}`}</span><div className="flex items-center gap-2"><label className="flex items-center gap-1">每页<select aria-label="租赁每页显示条数" value={pageSize} onChange={event => { setPageSize(Number(event.target.value)); setPage(1); setLoading(true); }} className="field !w-auto !p-1.5">{[10, 20, 50].map(size => <option key={size} value={size}>{size}</option>)}</select></label><button type="button" aria-label="上一页" disabled={loading || listMeta.page <= 1} className="rounded-md p-1.5 hover:bg-white disabled:opacity-40" onClick={() => { setPage(listMeta.page - 1); setLoading(true); }}><ChevronLeft className="h-4 w-4" /></button><span>{listMeta.page} / {listMeta.totalPages}</span><button type="button" aria-label="下一页" disabled={loading || listMeta.page >= listMeta.totalPages} className="rounded-md p-1.5 hover:bg-white disabled:opacity-40" onClick={() => { setPage(listMeta.page + 1); setLoading(true); }}><ChevronRight className="h-4 w-4" /></button></div></div>
    </section>

    {openedOrder && !selectedRental && !createOpen && <ModalShell wide title={openedOrder.order.customerName || '租赁订单'} subtitle={`租赁单 ${openedOrder.order.rentalNo}`} onClose={() => { setOpenedOrder(null); setSelectedRenewalIds(new Set()); }} footer={<><button type="button" onClick={() => setOpenedOrder(null)} className="btn-ghost">关闭</button>{selectedOrderCanEditTerms && <button type="button" onClick={orderEdit} className="btn-secondary">更正条款</button>}{orderRenewalTargets.length > 0 && <button type="button" className="btn-secondary" onClick={() => { listActionRef.current = 'order'; setBackToOrder(true); beginRenewal(orderRenewalTargets); }}>续租所选 {orderRenewalTargets.length} 台</button>}{canAppend && <button type="button" onClick={() => openAppendMachines(openedOrder)} className="btn-primary">追加机器</button>}</>}>
      <div className="space-y-4"><section className="grid gap-3 rounded-xl border border-line bg-white p-4 sm:grid-cols-3"><DetailValue label="整单进度" value={`共 ${openedOrder.order.totalCount} 台 · ${orderProgress(openedOrder.order)}`} /><div><p className="mb-1 text-xs text-ink-soft">关键日期</p><DueDate dueDate={openedOrder.order.nearestDueDate} returnDate={openedOrder.order.latestReturnDate} active={openedOrder.order.activeCount > 0} label="结单" /></div><DetailValue label="整单累计约定租金" value={money(openedOrder.order.totalPrice)} /></section>
      {openedOrder.items[0] && <details className="rounded-lg border border-line bg-white p-3"><summary className="cursor-pointer text-sm font-semibold">客户与经办信息</summary><CustomerInfo item={openedOrder.items[0]} /></details>}
      <section><div className="mb-2 flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold">本单机器</h3>{orderActiveItems.length > 0 && <label className="inline-flex items-center gap-2 text-xs text-ink-soft"><input type="checkbox" checked={orderRenewalTargets.length === orderActiveItems.length} onChange={event => setSelectedRenewalIds(event.target.checked ? new Set(orderActiveItems.map(item => item.id)) : new Set())} className="accent-primary" />全选在租机器（用于续租）</label>}</div>
        <ul className="divide-y divide-line rounded-lg border border-line bg-white">{openedOrder.items.map(item => <li key={item.id} className={`grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 px-2.5 py-2.5 ${machineMatches(item, search, due) && (search.trim() || due !== 'all') ? 'bg-blue-50/70' : ''}`}><div className="w-4">{item.status === 'renting' && <input type="checkbox" checked={selectedRenewalIds.has(item.id)} onChange={() => toggleRenewalSelection(item.id)} aria-label={`选择 ${item.sn} 续租`} className="accent-primary" />}</div><div className="min-w-0"><p className="truncate text-sm font-medium">{productName(item)}</p><SNButton value={item.sn} onCopy={copySN} /><p className="text-xs text-ink-soft">{dueLabel(item) || rentalStatusLabel(item.status)} · {money(item.cumulativeRentalAmount ?? item.rentalTotalPrice)}</p></div><button type="button" onClick={() => void openRentalDetail(item, true)} aria-label={`查看机器 ${item.sn}`} className="rounded-md px-2 py-2 text-xs font-medium text-primary hover:bg-blue-50">详情 <ChevronRight className="inline h-3.5 w-3.5" /></button></li>)}</ul>
      </section></div>
    </ModalShell>}

    {createOpen && <ModalShell wide title={appendTarget ? '追加机器' : '新建租赁'} subtitle={appendTarget ? `${appendTarget.rentalNo} · ${appendTarget.customerName}` : undefined} onClose={closeCreate} footer={<>
      <span className="mr-auto basis-full self-center text-xs text-ink-soft sm:basis-auto">已选 {selectedIds.length} 台{createStep === 3 && <> · 租金 <b className="text-ink-deep">{money(totalPrice)}</b> · 押金 {money(totalDeposit)}</>}</span>
      <button type="button" onClick={createStep > 1 ? () => setCreateStep(createStep - 1) : closeCreate} disabled={submitting} className="btn-ghost">{createStep > 1 ? '上一步' : '取消'}</button>
      <button form="rental-create-form" type="submit" disabled={submitting} className="btn-primary">{submitting ? '提交中…' : createStep < 3 ? '下一步' : appendTarget ? '确认追加' : '确认租赁'}</button>
    </>}>
      <ol aria-label="录入步骤" className="mb-5 grid grid-cols-3 gap-2">{createSteps.map((label, index) => <li key={label} aria-current={createStep === index + 1 ? 'step' : undefined} className={`border-b-2 px-0.5 pb-2 text-xs font-medium sm:text-sm ${createStep === index + 1 ? 'border-primary text-primary' : 'border-line text-ink-soft'}`}>{index + 1}. {label}</li>)}</ol>
      <form id="rental-create-form" onSubmit={submitRental} className="space-y-4">
        <h3 ref={formHeading} tabIndex={-1} className="text-base font-semibold outline-none">{createSteps[createStep - 1]}</h3>
        {createStep === 1 && <>
          <MachineSearchInput<InventoryItem> value={machineSearch} onChange={setMachineSearch} endpoint="/api/inventory/lookup?context=rental" onSelect={item => { addMachine(item); setMachineSearch(''); }} onSelectMany={items => { items.forEach(addMachine); setMachineSearch(''); }} onSearch={setMachineSearch} scanEnabled batchEnabled ariaLabel="搜索可租机器" />
          {selectedMachines.length > 0 && <section className="rounded-xl border border-primary/20 bg-blue-50/50">
            <div className="flex items-center justify-between border-b border-primary/10 px-3 py-2"><h4 className="text-xs font-semibold">已选 {selectedMachines.length} 台</h4><button type="button" onClick={() => { setSelectedIds([]); setRentalTerms({}); }} className="text-xs font-medium text-primary">清空已选</button></div>
            <ul className="max-h-56 divide-y divide-line/80 overflow-y-auto">{selectedMachines.map(item => <li key={item.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm"><div className="min-w-0"><p className="truncate font-medium">{productName(item)} {validity.invalidIds.includes(item.id) && <span className="text-danger">已不可租</span>}</p><p className="break-all font-mono text-xs text-ink-soft">{item.sn}</p></div><button type="button" onClick={() => removeMachine(item.id)} aria-label={`移除 ${item.sn}`} className="rounded-md p-2 text-ink-soft hover:bg-white hover:text-danger"><X className="h-4 w-4" /></button></li>)}</ul>
          </section>}
          {(validity.error || validity.invalidIds.length > 0) && <p role="alert" className="rounded-lg bg-danger/5 p-3 text-xs text-danger">{validity.error || '部分所选机器已不可租，请移除后重试。'}</p>}
          <section><h4 className="mb-2 text-sm font-medium">可租机器</h4><div className="max-h-52 overflow-y-auto rounded-lg border border-line bg-white">{inventoryError ? <p role="alert" className="p-3 text-sm text-danger">{inventoryError}</p> : !listedInventory.length ? <p className="p-3 text-sm text-ink-soft">没有可添加的机器，请换一个关键词。</p> : listedInventory.map(item => <button type="button" key={item.id} onClick={() => addMachine(item)} className="flex w-full items-center justify-between gap-3 border-b border-line px-3 py-2.5 text-left last:border-0 hover:bg-blue-50/60"><span className="min-w-0"><span className="block truncate text-sm font-medium">{productName(item)}</span><span className="mt-0.5 block truncate font-mono text-xs text-ink-soft">{item.sn} · {configText(item)}</span></span><span className="shrink-0 text-xs font-medium text-primary">添加</span></button>)}</div></section>
        </>}
        {createStep === 2 && <>
          {appendTarget ? <section className="rounded-lg border border-line bg-white p-3"><p className="text-sm font-medium">沿用原单客户与经办信息</p><p className="mt-1 text-xs text-ink-soft">{customerName} · {customerPhone} · {handlerName || '经手人未记录'}</p><p className="mt-1 text-xs text-ink-soft">本次只为新增机器设定租期和金额。</p></section> : <>
            <section className="grid gap-3 sm:grid-cols-2">
              <label className="text-sm">客户姓名 *<input value={customerName} onChange={event => setCustomerName(event.target.value)} className="field mt-1" required /></label>
              <label className="text-sm">联系电话 *<input type="tel" value={customerPhone} onChange={event => setCustomerPhone(event.target.value)} className="field mt-1" required /></label>
              <label className="text-sm sm:col-span-2">客户地址 *<input value={customerAddress} onChange={event => setCustomerAddress(event.target.value)} className="field mt-1" required /></label>
            </section>
            <section className="space-y-3 border-t border-line pt-3"><h4 className="text-sm font-semibold">经办与订单来源</h4>
              <div className="grid gap-3 sm:grid-cols-2"><div className="text-sm">经手账号 *<div className="mt-1"><CustomSelect value={handlerUserId} onChange={setHandlerUserId} options={handlerOptions} placeholder="请选择经手账号" aria-label="经手账号" /></div>{handlerLoadError && <p role="alert" className="mt-1 text-xs text-danger">{handlerLoadError}</p>}</div><label className="text-sm">业务员 *<input value={salespersonName} onChange={event => setSalespersonName(event.target.value)} className="field mt-1" maxLength={80} required /></label></div>
              <fieldset><legend className="mb-1 text-sm">租赁来源 *</legend><div className="flex gap-4">{sourceOptions.map(option => <label key={option.value} className="flex items-center gap-2 text-sm"><input type="radio" name="rental-source" value={option.value} checked={sourceType === option.value} onChange={() => setSourceType(option.value)} className="accent-primary" required />{option.label}</label>)}</div></fieldset>
              {sourceType === 'online' && <div className="grid gap-3 sm:grid-cols-2"><label className="text-sm">线上平台 *<input value={platformName} onChange={event => setPlatformName(event.target.value)} className="field mt-1" maxLength={100} required /></label><label className="text-sm">平台订单号 *<input value={platformOrderNo} onChange={event => setPlatformOrderNo(event.target.value)} className="field mt-1" maxLength={120} required /></label></div>}
            </section>
          </>}
          <section className="grid gap-3 border-t border-line pt-3 sm:grid-cols-2">
            <label className="text-sm">起租日<input type="date" value={startDate} onChange={event => setStartDate(event.target.value)} className="field mt-1" required /></label>
            <label className="text-sm">到期日<input type="date" value={endDate} min={addRentalDays(startDate, 1) || undefined} onChange={event => setEndDate(event.target.value)} className="field mt-1" required /></label>
            {!appendTarget && <label className="text-sm sm:col-span-2">备注<input value={remark} onChange={event => setRemark(event.target.value)} className="field mt-1" placeholder="选填" /></label>}
          </section>
        </>}
        {createStep === 3 && <>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-ink-soft"><span>{startDate} 至 {endDate} · {selectedMachines.length} 台</span><button type="button" onClick={() => setCreateStep(2)} className="text-primary hover:underline">修改租期</button></div>
          <fieldset><legend className="mb-1.5 text-sm font-medium">计费方式</legend>
            {appendTarget ? <p className="text-sm">{billingLabel(rentalType)} · 沿用原单</p> : <div className="flex flex-wrap gap-2">{typeOptions.map(option => <label key={option.value} className={`inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-2 text-xs ${rentalType === option.value ? 'border-primary/40 bg-blue-50 text-primary' : 'border-line bg-white'}`}><input type="radio" name="rental-billing" value={option.value} checked={rentalType === option.value} onChange={() => setRentalType(billingOf(option.value))} className="accent-primary" />{option.label}</label>)}</div>}
            <p className="mt-2 text-xs text-ink-soft">{rentalType === 'fixed' ? '填写每台机器谈好的本期金额，租期变化不会自动重算。' : duration ? `本期计费 ${duration} ${rentalType === 'month' ? '个月' : '天'}。` : '当前租期不足一个完整计费月，请调整租期。'}</p>
          </fieldset>
          {selectedIds.length > 1 && <div className="grid grid-cols-2 gap-2 rounded-lg border border-line bg-white p-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"><label className="min-w-0 text-xs">批量填{priceHeading}<input type="number" min="0.01" step="0.01" value={rentalType === 'fixed' ? fixedPrice : unitPrice} onChange={event => rentalType === 'fixed' ? setFixedPrice(event.target.value) : setUnitPrice(event.target.value)} className="field mt-1" /></label><label className="min-w-0 text-xs">批量填押金<input type="number" min="0" step="0.01" value={deposit} onChange={event => setDeposit(event.target.value)} className="field mt-1" /></label><button type="button" onClick={applyBulkTerms} className="btn-secondary col-span-2 sm:col-auto">应用到 {selectedIds.length} 台</button></div>}
          <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-white">{selectedMachines.map(item => { const terms = rentalTerms[item.id] || BLANK_TERMS; return <li key={item.id} className="grid grid-cols-2 items-center gap-2 px-3 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(110px,.65fr)_minmax(95px,.55fr)]"><div className="col-span-2 min-w-0 sm:col-auto"><p className="truncate text-sm font-medium">{productName(item)}</p><p className="break-all font-mono text-xs text-ink-soft">{item.sn}</p></div><label className="min-w-0 text-xs">{priceHeading}<input type="number" min="0.01" step="0.01" aria-label={`${item.sn} ${priceHeading}`} value={terms[currentRentField]} onChange={event => updateRentalTerm(item.id, currentRentField, event.target.value)} className="field mt-1" required /></label><label className="min-w-0 text-xs">押金<input type="number" min="0" step="0.01" aria-label={`${item.sn} 押金`} value={terms.deposit} onChange={event => updateRentalTerm(item.id, 'deposit', event.target.value)} className="field mt-1" placeholder="0" /></label></li>; })}</ul>
        </>}
      </form>
    </ModalShell>}

    {selectedRental && <ModalShell wide title={returnOpen ? '登记归还' : rentalAction ? actionTitle(rentalAction) : productName(selectedRental)} subtitle={`${selectedRental.displayRentalNo || selectedRental.rentalNo} · ${renewalTargets.length > 1 ? `${renewalTargets.length} 台机器` : selectedRental.sn}`} onClose={closeMachine} footer={
      returnOpen ? <><button type="button" disabled={returning} onClick={exitAction} className="btn-ghost">返回详情</button><button form="rental-return-form" type="submit" disabled={returning || !returnWarehouseId} className="btn-primary">{returning ? '处理中…' : '确认归还'}</button></> :
      rentalAction ? <><button type="button" disabled={savingAction} onClick={exitAction} className="btn-ghost">取消</button><button form="rental-action-form" type="submit" disabled={savingAction} className="btn-primary">{savingAction ? '处理中…' : rentalAction === 'renew' ? `确认续租 ${renewalTargets.length} 台` : rentalAction === 'edit_terms' ? '保存租赁更正' : rentalAction === 'buyout' ? '确认买断出库' : rentalAction === 'cancel_buyout' ? '确认撤销买断' : '保存跟进'}</button></> :
      <><button type="button" onClick={closeMachine} className="btn-ghost">{backToOrder ? '返回订单' : '关闭'}</button>{selectedRental.status === 'renting' && <><button type="button" onClick={() => openRentalAction('renew')} className="btn-secondary inline-flex items-center gap-1"><CalendarPlus className="h-4 w-4" />续租</button><button type="button" onClick={() => { setRentalAction(null); setReturnDate(dateInput()); setReturnWarehouseId(''); setReturnOpen(true); }} className="btn-primary inline-flex items-center gap-1"><RotateCcw className="h-4 w-4" />归还</button></>}</>
    }>
      <div className="space-y-4">
        {!rentalAction && !returnOpen && <>
          <section className="rounded-xl border border-line bg-white p-4">
            <div className="flex flex-wrap items-center gap-2"><span className={`status-pill ${selectedRental.status === 'renting' ? 'info' : 'ok'}`}>{rentalStatusLabel(selectedRental.status)}</span>{dueLabel(selectedRental) && <span className="font-medium text-danger">{dueLabel(selectedRental)}</span>}<SNButton value={selectedRental.sn} onCopy={copySN} /></div>
            <p className="mt-2 text-sm">{selectedRental.customerName} · <span className="text-ink-soft">{selectedRental.config || '配置待补充'}</span></p>
            <dl className="mt-3 grid grid-cols-2 gap-3 border-t border-line pt-3 sm:grid-cols-3">
              <DetailValue label="租期" value={`${selectedRental.rentalStartDate} 至 ${selectedRental.rentalEndDate}`} />
              <DetailValue label="累计约定租金" value={money(selectedRental.cumulativeRentalAmount ?? selectedRental.rentalTotalPrice)} />
              {selectedRental.status === 'renting' && <DetailValue label="当前押金" value={money(selectedRental.deposit)} />}
            </dl>
            {selectedRental.status === 'returned' && <div className="mt-3 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-900"><b>实际归还 {selectedRental.returnDate || '历史未记录'}</b><p className="mt-0.5 text-xs">{selectedRental.returnType || '归还方式未记录'} · 接收仓库：{warehouses.find(item => item.id === returnedTo)?.name || returnedTo || '历史未记录'}</p>{selectedRental.currentInventorySn && <Link href={`/inventory?inventoryId=${encodeURIComponent(selectedRental.inventoryId)}`} className="mt-1 inline-block text-xs font-medium text-primary hover:underline">在库存中查看这台机器{selectedRental.currentInventorySn !== selectedRental.sn ? ` · ${selectedRental.currentInventorySn}` : ''}</Link>}</div>}
          </section>
          <details className="rounded-lg border border-line bg-white p-3"><summary className="cursor-pointer text-sm font-semibold">费用明细</summary>
            <dl className="mt-3 grid grid-cols-2 gap-3"><DetailValue label="原始计费方式" value={billingLabel(selectedRental.rentalType)} /><DetailValue label="初始约定租金" value={money(selectedRental.rentalTotalPrice)} /><DetailValue label="续租费用累计" value={money(selectedRental.renewalTotal || 0)} /><DetailValue label={selectedRental.status === 'renting' ? '当前押金' : '租赁记录押金'} value={money(selectedRental.deposit)} /></dl>
            {!!selectedRental.renewals?.length && <ol className="mt-4 space-y-3">{selectedRental.renewals.map(renewal => <li key={renewal.id} className="border-l border-primary/25 pl-3 text-xs"><p className="font-medium">{renewal.periodStartDate} 至 {renewal.newEndDate} · {money(renewal.totalAmount)}</p><p className="mt-1 text-ink-soft">{renewal.priceMode === 'custom_total' ? '约定续租金额' : `${billingLabel(renewal.billingUnit)} · 单价 ${money(renewal.unitPrice)}`} · {renewal.actorName} · {formatDisplayDateTime(renewal.createdAt)}</p>{renewal.depositDelta !== 0 && <p className="mt-1 text-ink-soft">押金 {money(renewal.depositBefore)} → {money(renewal.depositAfter)} · {renewal.depositChangeReason}</p>}{renewal.note && <p className="mt-1 whitespace-pre-wrap text-ink-soft">{renewal.note}</p>}</li>)}</ol>}
          </details>
          <details className="rounded-lg border border-line bg-white p-3"><summary className="cursor-pointer text-sm font-semibold">客户与经办信息</summary><CustomerInfo item={selectedRental} /></details>
          {(selectedRental.status === 'renting' || selectedRental.returnType === '客户买断') && <details className="rounded-lg border border-line bg-white p-3"><summary className="cursor-pointer text-sm font-semibold">更多操作</summary><div className="mt-2 flex flex-wrap gap-2">{selectedRental.status === 'renting' ? <>
            <button type="button" onClick={() => openRentalAction('buyout')} className="btn-secondary inline-flex items-center gap-1"><CircleDollarSign className="h-4 w-4" />买断</button>
            <button type="button" onClick={() => openRentalAction('exception')} className="btn-secondary inline-flex items-center gap-1"><MessageSquareText className="h-4 w-4" />异常跟进</button>
            <button type="button" onClick={() => { if (selectedOrderCanEditTerms) openRentalAction('edit_terms'); else void openOrder(orderKeyOf(selectedRental)); }} className="btn-secondary inline-flex items-center gap-1"><Pencil className="h-4 w-4" />{selectedOrderCanEditTerms ? '更正条款' : '查看所属订单'}</button>
          </> : <button type="button" onClick={() => openRentalAction('cancel_buyout')} className="btn-secondary text-danger">撤销买断</button>}</div></details>}
          {selectedRental.returnType === '客户买断' && <section className="rounded-xl border border-line bg-white p-4"><h3 className="mb-2 text-sm font-semibold">买断结算</h3><dl className="grid grid-cols-2 gap-3"><DetailValue label="买断方" value={selectedRental.buyoutBuyerName || selectedRental.customerName} /><DetailValue label="买断来源" value={selectedRental.buyoutSource || '历史未记录'} /><DetailValue label="退还押金" value={money(selectedRental.depositRefundAmount || 0)} /><DetailValue label="押金抵扣 / 留存" value={`${money(selectedRental.depositAppliedAmount || 0)} / ${money(selectedRental.depositRetainedAmount || 0)}`} /><DetailValue label="结算调整" value={money(selectedRental.settlementAdjustment || 0)} />{selectedRental.settlementNote && <DetailValue label="结算说明" value={selectedRental.settlementNote} />}</dl></section>}
        </>}
        {(rentalAction || returnOpen) && <h3 ref={formHeading} tabIndex={-1} className="text-sm font-semibold outline-none">{returnOpen ? '填写归还信息' : actionTitle(rentalAction!)} · {renewalTargets.length > 1 ? `${renewalTargets.length} 台机器` : selectedRental.sn}</h3>}
        {rentalAction === 'edit_terms' && <form id="rental-action-form" onSubmit={submitRentalAction} className="space-y-4">
          <div role="group" aria-label="更正内容" className="flex gap-2"><button type="button" aria-pressed={editScope === 'dates'} onClick={() => setEditScope('dates')} className={`btn-secondary ${editScope === 'dates' ? 'border-primary text-primary' : ''}`}>更正租期</button><button type="button" aria-pressed={editScope === 'prices'} onClick={() => setEditScope('prices')} className={`btn-secondary ${editScope === 'prices' ? 'border-primary text-primary' : ''}`}>更正租金</button></div>
          <p className="text-sm text-ink-soft">本单共 {selectedRentalOrder?.items.length || 1} 台。{editScope === 'dates' ? billingOf(selectedRental.rentalType) === 'fixed' ? '只更新租期，固定租金不变。' : '按原有单价和更正后的租期重算。' : '保留原租期，只更正租金。'}</p>
          {editScope === 'dates' && <section className="grid gap-3 sm:grid-cols-2"><label className="text-sm">新起租日<input type="date" value={editRentalStartDate} onChange={event => setEditRentalStartDate(event.target.value)} className="field mt-1" required /></label><label className="text-sm">新到期日<input type="date" value={editRentalEndDate} min={addRentalDays(editRentalStartDate, 1) || undefined} onChange={event => setEditRentalEndDate(event.target.value)} className="field mt-1" required /></label></section>}
          <ul className="divide-y divide-line rounded-lg border border-line bg-white">{selectedRentalOrder?.items.map(item => {
            const fixed = billingOf(item.rentalType) === 'fixed';
            const value = editRentalPrices[item.id] ?? '';
            const next = editScope === 'dates' ? fixed ? item.rentalTotalPrice : item.rentalUnitPrice * editRentalDuration : fixed ? Number(value) : Number(value) * item.rentalDuration;
            return <li key={item.id} className="grid items-center gap-2 p-3 sm:grid-cols-[1fr_1fr]"><div className="min-w-0"><p className="text-sm font-medium">{productName(item)}</p><p className="break-all font-mono text-xs text-ink-soft">{item.sn}</p><p className="mt-1 text-xs text-ink-soft">{editScope === 'dates' ? `${item.rentalStartDate} 至 ${item.rentalEndDate} → ${editRentalStartDate || '—'} 至 ${editRentalEndDate || '—'}` : `原租金 ${money(item.rentalTotalPrice)}`}</p></div>{editScope === 'prices' && <label className="min-w-0 text-xs">{fixed ? '本期固定租金' : billingOf(item.rentalType) === 'month' ? '每月租金' : '每日租金'}<input aria-label={`${item.sn} 新租金`} type="number" min="0.01" step="0.01" value={value} onChange={event => setEditRentalPrices(current => ({ ...current, [item.id]: event.target.value }))} className="field mt-1" required /></label>}<p className="text-xs text-ink-soft sm:col-span-2">本期金额：{money(item.rentalTotalPrice)} → {money(next)}</p></li>;
          })}</ul>
          <label className="block text-sm">更正原因<textarea value={editRentalReason} onChange={event => setEditRentalReason(event.target.value)} className="field mt-1 min-h-20 resize-y" maxLength={500} required /></label>
        </form>}
        {rentalAction === 'renew' && <form id="rental-action-form" onSubmit={submitRentalAction} className="space-y-4">
          <p className="text-sm text-ink-soft">续租从各台机器当前到期日的次日开始，原租金保留。{renewingFixed && '请填写每台机器本次另谈的金额。'}</p>
          {!renewingFixed && <fieldset><legend className="mb-1 text-sm">延长方式</legend><div className="flex gap-2"><button type="button" aria-pressed={renewalMode === 'duration'} onClick={() => setRenewalMode('duration')} className={`btn-secondary ${renewalMode === 'duration' ? 'border-primary text-primary' : ''}`}>延长时长</button><button type="button" aria-pressed={renewalMode === 'date'} onClick={() => setRenewalMode('date')} className={`btn-secondary ${renewalMode === 'date' ? 'border-primary text-primary' : ''}`}>指定到期日</button></div></fieldset>}
          {renewalMode === 'duration' ? <div className="grid grid-cols-2 gap-3"><label className="text-sm">延长数量<input type="number" min="1" step="1" value={renewalDuration} onChange={event => setRenewalDuration(event.target.value)} className="field mt-1" required /></label><label className="text-sm">时间单位<select value={renewalBillingUnit} onChange={event => { const unit = event.target.value as 'day' | 'month'; setRenewalBillingUnit(unit); if (renewalPriceMode === 'original_unit' && renewalTargets.some(item => billingOf(item.rentalType) !== unit)) setRenewalPriceMode('custom_unit'); }} className="field mt-1"><option value="day">天</option><option value="month">月</option></select></label></div> : <label className="block text-sm">新到期日<input type="date" value={newEndDate} min={addRentalDays(renewalTargets.map(item => item.rentalEndDate).sort().at(-1) || selectedRental.rentalEndDate, 1) || undefined} onChange={event => setNewEndDate(event.target.value)} className="field mt-1" required /></label>}
          {!renewingFixed && <section className="grid gap-3 sm:grid-cols-2"><label className="text-sm">本次计费方式<select value={renewalPriceMode} onChange={event => setRenewalPriceMode(event.target.value as RenewalPriceMode)} className="field mt-1">{renewalTargets.every(item => billingOf(item.rentalType) === renewalBillingUnit) && <option value="original_unit">沿用每台原单价</option>}<option value="custom_unit">自定义每台单价</option><option value="custom_total">填写每台约定金额</option></select></label>{renewalMode === 'date' && renewalPriceMode !== 'custom_total' && <label className="text-sm">计费单位<select value={renewalBillingUnit} onChange={event => { const unit = event.target.value as 'day' | 'month'; setRenewalBillingUnit(unit); if (renewalPriceMode === 'original_unit' && renewalTargets.some(item => billingOf(item.rentalType) !== unit)) setRenewalPriceMode('custom_unit'); }} className="field mt-1"><option value="day">天</option><option value="month">月</option></select></label>}</section>}
          {renewalPriceMode === 'custom_total' && renewalTargets.length > 1 && <div className="flex flex-wrap items-end gap-2 rounded-lg border border-line bg-white p-3"><label className="flex-1 text-sm">批量填每台续租金额<input type="number" min="0" step="0.01" value={bulkRenewalPrice} onChange={event => setBulkRenewalPrice(event.target.value)} className="field mt-1" /></label><button type="button" className="btn-secondary" disabled={!validMoney(bulkRenewalPrice, true)} onClick={() => setRenewalTotalPrices(Object.fromEntries(renewalTargets.map(item => [item.id, bulkRenewalPrice])))}>应用到所选</button></div>}
          <ul className="divide-y divide-line rounded-lg border border-line bg-white">{renewalTargets.map(item => <li key={item.id} className="grid grid-cols-2 items-center gap-2 p-3 sm:grid-cols-[minmax(0,1fr)_minmax(100px,.65fr)_minmax(100px,.65fr)]"><div className="col-span-2 min-w-0 sm:col-auto"><p className="text-sm font-medium">{productName(item)}</p><p className="break-all font-mono text-xs text-ink-soft">{item.sn}</p><p className="mt-1 text-xs text-ink-soft">{item.rentalEndDate} → {renewalEndFor(item) || '请选择'}</p></div>
            {renewalPriceMode === 'custom_total' ? <label className="min-w-0 text-xs">本次约定租金<input aria-label={`${item.sn} 本次续租总额`} type="number" min="0" step="0.01" value={renewalTotalPrices[item.id] ?? ''} onChange={event => setRenewalTotalPrices(current => ({ ...current, [item.id]: event.target.value }))} className="field mt-1" required /></label> : renewalPriceMode === 'custom_unit' ? <label className="min-w-0 text-xs">续租单价<input type="number" min="0" step="0.01" value={renewalUnitPrices[item.id] ?? ''} onChange={event => setRenewalUnitPrices(current => ({ ...current, [item.id]: event.target.value }))} className="field mt-1" required /></label> : <div className="text-xs">本次租金 <b>{money(renewalAmountFor(item))}</b></div>}
            <label className="min-w-0 text-xs">押金调整（+收 / −退）<input aria-label={`${item.sn} 押金调整`} type="number" step="0.01" min={-Number(item.deposit || 0)} value={renewalDepositDeltas[item.id] ?? '0'} onChange={event => setRenewalDepositDeltas(current => ({ ...current, [item.id]: event.target.value }))} className="field mt-1" /></label>
          </li>)}</ul>
          {Object.values(renewalDepositDeltas).some(value => Number(value) !== 0) && <label className="block text-sm">押金调整原因<input value={renewalDepositReason} onChange={event => setRenewalDepositReason(event.target.value)} className="field mt-1" maxLength={500} required /></label>}
          <label className="block text-sm">续租备注<textarea value={renewalNote} onChange={event => setRenewalNote(event.target.value)} className="field mt-1 min-h-20 resize-y" maxLength={1000} placeholder="填写额外约定；零元续租时必填原因" /></label>
          <p className="rounded-lg bg-blue-50 p-3 text-sm">涉及 {renewalTargets.length} 台 · 本次续租合计 <b>{customRenewalPriceMissing ? '待填写' : money(sumMoney(renewalTargets.map(renewalAmountFor)))}</b></p>
        </form>}
        {rentalAction === 'buyout' && <form id="rental-action-form" onSubmit={submitRentalAction} className="space-y-4 rounded-xl border border-primary/20 bg-primary/5 p-4"><div><h3 className="text-sm font-semibold text-ink-deep">租赁转买断</h3><p className="mt-1 text-xs text-ink-soft">买断将结束租赁并产生独立销售记录。来源不会加入常规销售渠道。</p></div><section className="grid gap-3 sm:grid-cols-2"><label className="text-xs text-ink-soft">买断日期<input type="date" value={buyoutDate} onChange={event => setBuyoutDate(event.target.value)} className="field mt-1.5" required /></label><label className="text-xs text-ink-soft">买断金额<input type="number" min="0" step="0.01" value={buyoutPrice} onChange={event => setBuyoutPrice(event.target.value)} className="field mt-1.5" placeholder="填写成交金额" required /></label><label className="text-xs text-ink-soft">买断方<input value={buyoutBuyerName} onChange={event => setBuyoutBuyerName(event.target.value)} className="field mt-1.5" maxLength={120} required /></label><label className="text-xs text-ink-soft">买断来源 / 渠道<input list="rental-buyout-sources" value={buyoutSource} onChange={event => setBuyoutSource(event.target.value)} className="field mt-1.5" placeholder="可填写个人、企业或其他" maxLength={100} required /><datalist id="rental-buyout-sources"><option value="个人"/><option value="企业"/><option value="原租赁客户"/><option value="其他"/></datalist></label><label className="text-xs text-ink-soft sm:col-span-2">销售单号<input value={buyoutOrderNo} onChange={event => setBuyoutOrderNo(event.target.value)} className="field mt-1.5" maxLength={100} placeholder="选填，留空自动生成" /></label></section>
          <section className="space-y-3 rounded-lg border border-line/70 bg-white/65 p-3"><div><h4 className="text-xs font-semibold text-ink-deep">押金结算</h4><p className="mt-1 text-[11px] text-ink-soft">当前押金 {money(Number(selectedRental.deposit || 0))}；退款、抵扣、留存三项必须分配完整。</p></div><div className="grid gap-3 sm:grid-cols-3"><label className="text-xs text-ink-soft">退还<input type="number" min="0" step="0.01" value={buyoutDepositRefund} onChange={event => setBuyoutDepositRefund(event.target.value)} className="field mt-1.5" /></label><label className="text-xs text-ink-soft">抵扣买断款<input type="number" min="0" step="0.01" value={buyoutDepositApplied} onChange={event => setBuyoutDepositApplied(event.target.value)} className="field mt-1.5" /></label><label className="text-xs text-ink-soft">留存抵其他欠款<input type="number" min="0" step="0.01" value={buyoutDepositRetained} onChange={event => setBuyoutDepositRetained(event.target.value)} className="field mt-1.5" /></label></div><label className="block text-xs text-ink-soft">其他结算调整（加收填正数，减免填负数）<input type="number" step="0.01" value={buyoutSettlementAdjustment} onChange={event => setBuyoutSettlementAdjustment(event.target.value)} className="field mt-1.5" /></label><label className="block text-xs text-ink-soft">结算说明<textarea value={buyoutSettlementNote} onChange={event => setBuyoutSettlementNote(event.target.value)} className="field mt-1.5 min-h-16 resize-y" maxLength={500} placeholder="留存押金、额外调整或零元买断时必填" /></label></section>
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-white/70 px-3 py-2 text-xs"><span className="text-ink-soft">买断价 {money(Number(buyoutPrice || 0))} + 调整 {money(Number(buyoutSettlementAdjustment || 0))} - 押金抵扣 {money(Number(buyoutDepositApplied || 0))}</span><span className="font-semibold text-ink-deep">{Number(buyoutPrice || 0) + Number(buyoutSettlementAdjustment || 0) - Number(buyoutDepositApplied || 0) >= 0 ? '买断应收' : '买断应退'} {money(Math.abs(Number(buyoutPrice || 0) + Number(buyoutSettlementAdjustment || 0) - Number(buyoutDepositApplied || 0)))} · 押金另退 {money(Number(buyoutDepositRefund || 0))}</span></div>
        </form>}
        {rentalAction === 'cancel_buyout' && <form id="rental-action-form" onSubmit={submitRentalAction} className="rounded-xl border border-danger/20 bg-danger/5 p-4"><h3 className="text-sm font-semibold text-ink-deep">撤销租赁买断</h3><p className="mt-1 text-xs text-ink-soft">只有机器尚无后续业务、销售凭证也未产生售后或退货时才能撤销。撤销会关闭买断销售记录，并将机器恢复为租赁中。</p><p className="mt-2 rounded-md bg-warning/10 p-2 text-xs text-warning">系统只恢复业务状态和销售记录；若已发生退款、收款或押金抵扣，不会自动冲正资金，请核对后另行处理。</p><label className="mt-4 block text-xs text-ink-soft">撤销原因<textarea value={buyoutCancelReason} onChange={event => setBuyoutCancelReason(event.target.value)} className="field mt-1.5 min-h-20 resize-y" maxLength={500} required /></label></form>}
        {rentalAction === 'exception' && <form id="rental-action-form" onSubmit={submitRentalAction} className="rounded-xl border border-primary/20 bg-primary/5 p-4"><h3 className="text-sm font-semibold text-ink-deep">异常跟进</h3><p className="mt-1 text-xs text-ink-soft">记录沟通、逾期说明或机器状态跟进，不会自动改变库存状态。</p><label className="mt-4 block text-xs text-ink-soft">跟进内容<textarea value={exceptionNote} onChange={event => setExceptionNote(event.target.value)} className="field mt-1.5 min-h-24 resize-y" maxLength={1000} placeholder="记录已确认的信息和下一步安排" required /></label><p className="mt-1 text-right text-[11px] text-ink-soft">{exceptionNote.length}/1000</p></form>}
        {returnOpen && <form id="rental-return-form" onSubmit={completeReturn} className="rounded-xl border border-primary/20 bg-primary/5 p-4"><h3 className="text-sm font-semibold text-ink-deep">确认机器归还</h3><p className="mt-1 text-xs text-ink-soft">确认后机器会转为在库，并出现在所选接收仓库。</p><div className="mt-4 grid gap-3 sm:grid-cols-2"><label className="text-xs text-ink-soft">归还日期<input type="date" value={returnDate} onChange={(event) => setReturnDate(event.target.value)} className="field mt-1.5" required /></label><label className="text-xs text-ink-soft">归还方式<div className="mt-1.5"><CustomSelect value={returnType} onChange={setReturnType} options={returnOptions} /></div></label><div className="text-xs text-ink-soft sm:col-span-2"><span>实际接收仓库 <span className="text-danger">*</span></span><div className="mt-1.5"><CustomSelect value={returnWarehouseId} onChange={setReturnWarehouseId} options={warehouses.map(item => ({ value: item.id, label: item.name }))} placeholder="请选择机器实际收回的仓库" /></div>{warehouseLoadError && <p role="alert" className="mt-1 text-danger">{warehouseLoadError}</p>}<p className="mt-1 text-[11px]">原归属仓库：{warehouses.find(item => item.id === selectedRental.warehouseId)?.name || selectedRental.warehouseId || '未记录'}</p></div></div></form>}
        {!rentalAction && !returnOpen && <section className="rounded-xl border border-line/70 bg-white/35 p-4"><div className="flex items-center justify-between gap-3"><h3 className="text-sm font-semibold text-ink-deep">租赁跟进记录</h3><span className="text-[11px] text-ink-soft">{selectedRental.events?.length || 0} 条</span></div>{selectedRental.events?.length ? <ol className="mt-3 space-y-3">{selectedRental.events.map((event, index) => <li key={event.id || `${event.createdAt || ''}-${index}`} className="relative border-l border-primary/20 pb-1 pl-4 last:border-0"><span className="absolute -left-[4px] top-1 h-2 w-2 rounded-full bg-primary/70" /><p className="text-xs font-medium text-ink-deep">{rentalEventLabel(event.eventType)}</p>{event.note && <p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-ink-soft">{event.note}</p>}<p className="mt-1 text-[10px] text-ink-soft">{formatDisplayDateTime(event.createdAt, '时间未记录')}{(event.actorName || event.actorId) ? ` · ${event.actorName || event.actorId}` : ''}</p></li>)}</ol> : <p className="mt-3 text-xs text-ink-soft">暂无租赁跟进记录</p>}</section>}
      </div>
    </ModalShell>}

    {toast && <div role="status" aria-live="polite" className={'fixed bottom-5 right-5 z-[120] flex max-w-[calc(100vw-2.5rem)] items-center gap-3 rounded-xl border px-4 py-3 text-sm shadow-lg backdrop-blur-xl ' + (toast.tone === 'error' ? 'border-danger/20 bg-white/95 text-danger' : 'border-success/20 bg-white/95 text-success')}><span>{toast.text}</span><button type="button" onClick={() => setToast(null)} aria-label="关闭提示"><X className="h-4 w-4" /></button></div>}
  </div>;
}

function orderProgress(order: OrderSummary) {
  return [order.activeCount ? `在租 ${order.activeCount}` : '', order.returnedCount ? `已归还 ${order.returnedCount}` : '', order.boughtOutCount ? `已买断 ${order.boughtOutCount}` : ''].filter(Boolean).join(' / ') || '已结束';
}

function rentalReturnWarehouse(item: Rental) {
  const event = item.events?.find(entry => entry.eventType === 'returned');
  if (!event?.afterData) return '';
  try {
    const data: unknown = JSON.parse(event.afterData);
    return data && typeof data === 'object' && 'warehouseId' in data && typeof data.warehouseId === 'string' ? data.warehouseId : '';
  }
  catch { return ''; }
}

function machineMatches(item: Rental, search: string, due: DueFilter) {
  const query = search.trim().toLowerCase();
  const matchesSearch = !query || [item.rentalNo, item.displayRentalNo, item.sn, item.currentInventorySn, item.brand, item.model, item.year, item.customerName, item.customerPhone, item.handlerName, item.salespersonName, item.platformName, item.platformOrderNo].some(value => String(value ?? '').toLowerCase().includes(query));
  const days = item.daysUntilDue ?? (Date.parse(item.rentalEndDate) - Date.parse(dateInput())) / 86400000;
  const matchesDue = due === 'all' || item.status === 'renting' && (due === 'overdue' ? days < 0 : due === 'today' ? days === 0 : days > 0 && days <= 3);
  return matchesSearch && matchesDue;
}

function DueDate({ dueDate, returnDate, active, label = '归还', days }: { dueDate: string | null; returnDate: string | null; active: boolean; label?: string; days?: number | null }) {
  if (!active) return <span className="text-ink-soft">{returnDate ? `${label} ${returnDate}` : '已结束 · 日期未记录'}</span>;
  const due = dueText(dueDate, days);
  return <><span className={due ? `font-semibold ${due.startsWith('已逾期') || due === '今日到期' ? 'text-danger' : 'text-amber-800'}` : 'text-ink-soft'}>{due || (dueDate ? '到期' : '到期日未记录')}</span>{dueDate && <span className="ml-1 whitespace-nowrap tabular-nums text-ink-soft">{dueDate}</span>}</>;
}

function SNButton({ value, onCopy }: { value: string; onCopy: (value: string) => void }) {
  return <button type="button" onClick={() => onCopy(value)} aria-label={`复制 SN ${value}`} title={`复制 ${value}`} className="mt-0.5 inline-flex max-w-full items-center gap-1 text-left font-mono text-xs text-ink-soft hover:text-primary"><span className="truncate">{value}</span><Copy className="h-3 w-3 shrink-0" aria-hidden="true" /></button>;
}

function CustomerInfo({ item }: { item: Rental }) {
  return <dl className="mt-3 grid gap-3 sm:grid-cols-2">
    <DetailValue label="客户" value={item.customerName || '未记录'} /><DetailValue label="联系电话" value={item.customerPhone || '未记录'} /><DetailValue label="客户地址" value={item.customerAddress || '未记录'} />
    <DetailValue label="经手账号" value={item.handlerName || '历史未记录'} /><DetailValue label="业务员" value={item.salespersonName || '历史未记录'} />
    <DetailValue label="订单来源" value={item.sourceType === 'online' ? `线上 · ${item.platformName || '平台未记录'}` : item.sourceType === 'offline' ? '线下' : '历史未记录'} />
    {item.platformOrderNo && <DetailValue label="平台订单号" value={item.platformOrderNo} />}{item.remark && <DetailValue label="备注" value={item.remark} />}
  </dl>;
}

function actionTitle(action: Exclude<RentalAction, null>) {
  return { renew: '登记续租', buyout: '租赁转买断', exception: '异常跟进', cancel_buyout: '撤销租赁买断', edit_terms: '更正租赁条款' }[action];
}

function DetailValue({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0"><dt className="text-xs text-ink-soft">{label}</dt><dd className="mt-1 break-words text-sm font-medium text-ink-deep">{value}</dd></div>;
}

function rentalEventLabel(eventType?: string) {
  const labels: Record<string, string> = {
    created: '创建租赁',
    item_added: '追加机器',
    terms_corrected: '更正租赁条款',
    renewed: '续租',
    returned: '完成归还',
    buyout: '客户买断',
    buyout_reversed: '撤销买断',
    exception_followup: '异常跟进',
  };
  return (eventType && labels[eventType]) || eventType || '租赁变更';
}

