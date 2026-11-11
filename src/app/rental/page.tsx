'use client';

import { FormEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArchiveRestore, CalendarPlus, Check, ChevronDown, CircleDollarSign, Clock3, MessageSquareText, Pencil, RotateCcw, X } from 'lucide-react';
import CustomSelect, { SelectOption } from '@/components/CustomSelect';
import BusinessDialog from '@/components/BusinessDialog';
import MachineSearchInput from '@/components/MachineSearchInput';
import { useWorkspace, useWorkspaceDirty } from '@/components/WorkspaceContext';
import { useMachineEligibility } from '@/components/useMachineEligibility';
import { formatProductName } from '@/lib/product-name';
import { formatCPUDisplay } from '@/lib/sku-display';
import { groupRentalsByOrder } from '@/lib/rental-order-groups';
import { addRentalDays, addRentalMonths, calculateRentalDuration } from '@/lib/rental-duration';

type InventoryItem = { id: string; sn: string; brand: string; model: string; year: number | null; cpu: string; ram: string; storage: string; purchasePrice: number; supplierName: string };
type RentalEvent = { id?: string; eventType?: string; note?: string | null; actorName?: string | null; actorId?: string | null; createdAt?: string };
type RentalRenewal = { id: string; batchId: string; periodStartDate: string; previousEndDate: string; newEndDate: string; billingUnit: 'day' | 'month'; duration: number; priceMode: string; unitPrice: number; totalAmount: number; depositBefore: number; depositDelta: number; depositAfter: number; depositChangeReason: string | null; note: string | null; actorName: string; createdAt: string };
type Rental = { id: string; rentalOrderId: string | null; rentalNo: string; displayRentalNo?: string; orderMachineCount?: number; inventoryId: string; sn: string; brand: string; model: string; year: number | null; config: string; customerName: string; customerPhone: string; customerAddress: string; rentalStartDate: string; rentalEndDate: string; rentalType: string; rentalUnitPrice: number; rentalDuration: number; rentalTotalPrice: number; renewalTotal?: number; cumulativeRentalAmount?: number; renewals?: RentalRenewal[]; deposit: number; status: string; returnDate: string | null; returnType: string | null; remark: string | null; salesRecordId?: string | null; saleTransactionType?: string | null; buyoutBuyerName?: string | null; buyoutSource?: string | null; depositRefundAmount?: number; depositAppliedAmount?: number; depositRetainedAmount?: number; settlementAdjustment?: number; settlementNote?: string | null; events?: RentalEvent[] };
type RentalTerms = { rentalUnitPrice: string; deposit: string };
type ToastMessage = { text: string; tone: 'success' | 'error' };
type RentalAction = 'renew' | 'buyout' | 'exception' | 'cancel_buyout' | 'edit_terms' | null;
type RenewalPriceMode = 'original_unit' | 'custom_unit' | 'custom_total';
type RenewalMode = 'duration' | 'date';

function dateInput(offset = 0) {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function dueLabel(rental: Rental) { if (rental.status !== 'renting') return ''; const days = Math.ceil((new Date(rental.rentalEndDate + 'T00:00:00').getTime() - new Date(dateInput() + 'T00:00:00').getTime()) / 86400000); return days < 0 ? '已逾期 ' + (-days) + ' 天' : days === 0 ? '今日到期' : days <= 3 ? days + ' 天内到期' : ''; }
function rentalStatusLabel(status: string) { return status === 'renting' ? '租赁中' : status === 'returned' ? '已归还' : status === 'purchased' ? '已买断出库' : '已结束'; }

function money(value: number) { return '¥' + Number(value || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function configText(item: Pick<InventoryItem, 'cpu' | 'ram' | 'storage'>) { return [formatCPUDisplay(item.cpu), item.ram, item.storage].filter(Boolean).join(' · ') || '配置待补充'; }
function productName(item: { brand: string; model: string; year?: number | null }) { return formatProductName(item); }

function ModalShell({ title, subtitle, onClose, children, footer }: { title: string; subtitle?: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  return <BusinessDialog title={title} description={subtitle} onClose={onClose} footer={footer}>{children}</BusinessDialog>;
}

export default function RentalPage() {
  const { active } = useWorkspace();
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [rentals, setRentals] = useState<Rental[]>([]);
  const [summaryRentals, setSummaryRentals] = useState<Rental[]>([]);
  const [search, setSearch] = useState('');
  const [machineSearch, setMachineSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [rentalTerms, setRentalTerms] = useState<Record<string, RentalTerms>>({});
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [customerAddress, setCustomerAddress] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [rentalType, setRentalType] = useState('day');
  const [unitPrice, setUnitPrice] = useState('');
  const [deposit, setDeposit] = useState('');
  const [remark, setRemark] = useState('');
  const [returnDate, setReturnDate] = useState('');
  const [returnType, setReturnType] = useState('正常归还');
  const [expandedOrders, setExpandedOrders] = useState<Set<string>>(() => new Set());
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
  const [createOpen, setCreateOpen] = useState(false);
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
  const selectedIdsRef = useRef<string[]>([]);
  useEffect(() => { selectedIdsRef.current = selectedIds; }, [selectedIds]);
  const loadData = useCallback(async () => {
    loadController.current?.abort(); const controller = new AbortController(); loadController.current = controller;
    setLoading(true);
    try {
      const inventoryUrl = '/api/inventory/lookup?context=rental&q=' + encodeURIComponent(machineSearch) + '&limit=100';
      const recordUrl = '/api/rentals?status=' + encodeURIComponent(status) + '&search=' + encodeURIComponent(search) + '&pageSize=100';
      const summaryUrl = '/api/rentals?status=all&pageSize=100';
      const [inventoryResponse, rentalsResponse, summaryResponse] = await Promise.all([
        fetch(inventoryUrl, { cache: 'no-store', signal: controller.signal }),
        fetch(recordUrl, { cache: 'no-store', signal: controller.signal }),
        fetch(summaryUrl, { cache: 'no-store', signal: controller.signal }),
      ]);
      const inventoryPayload = await inventoryResponse.json();
      const rentalsPayload = await rentalsResponse.json();
      const summaryPayload = await summaryResponse.json();
      if (!inventoryResponse.ok || !inventoryPayload.success) throw new Error(inventoryPayload.error?.message || '加载可租机器失败');
      if (!rentalsResponse.ok || !rentalsPayload.success) throw new Error(rentalsPayload.error?.message || '加载租赁记录失败');
      if (!summaryResponse.ok || !summaryPayload.success) throw new Error(summaryPayload.error?.message || '加载租赁统计失败');
      const summaryPageCount = Number(summaryPayload.data?.totalPages || 1);
      const summaryPageResponses = await Promise.all(Array.from({ length: Math.max(0, summaryPageCount - 1) }, (_, index) => fetch('/api/rentals?status=all&pageSize=100&page=' + (index + 2), { cache: 'no-store', signal: controller.signal })));
      const summaryPagePayloads = await Promise.all(summaryPageResponses.map((response) => response.json()));
      const failedSummaryPage = summaryPageResponses.findIndex((response, index) => !response.ok || !summaryPagePayloads[index]?.success);
      if (failedSummaryPage !== -1) throw new Error(summaryPagePayloads[failedSummaryPage]?.error?.message || '加载租赁统计失败');
      const recordPageCount = Number(rentalsPayload.data?.totalPages || 1);
      const recordPageResponses = await Promise.all(Array.from({ length: Math.max(0, recordPageCount - 1) }, (_, index) => fetch(recordUrl + '&page=' + (index + 2), { cache: 'no-store', signal: controller.signal })));
      const recordPagePayloads = await Promise.all(recordPageResponses.map((response) => response.json()));
      const failedRecordPage = recordPageResponses.findIndex((response, index) => !response.ok || !recordPagePayloads[index]?.success);
      if (failedRecordPage !== -1) throw new Error(recordPagePayloads[failedRecordPage]?.error?.message || '加载租赁记录失败');
      setInventory(current => { const next: InventoryItem[] = inventoryPayload.data?.items || []; return [...next, ...current.filter(item => selectedIdsRef.current.includes(item.id) && !next.some(row => row.id === item.id))]; });
      const nextRentals: Rental[] = [...(rentalsPayload.data?.items || []), ...recordPagePayloads.flatMap((payload) => payload.data?.items || [])];
      setRentals(nextRentals);
      setSummaryRentals([...(summaryPayload.data?.items || []), ...summaryPagePayloads.flatMap((payload) => payload.data?.items || [])]);
      return nextRentals;
    } catch (loadError) {
      if (!controller.signal.aborted) notify(loadError instanceof Error ? loadError.message : '加载租赁数据失败', 'error');
    } finally { if (!controller.signal.aborted) setLoading(false); }
  }, [machineSearch, search, status]);

  useEffect(() => {
    if (!active) return;
    const timer = window.setTimeout(() => { void loadData(); }, 250);
    return () => { window.clearTimeout(timer); loadController.current?.abort(); };
  }, [active, loadData]);

  useEffect(() => {
    if (!active || (!createOpen && !selectedRental)) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setCreateOpen(false); setSelectedRental(null); setReturnOpen(false); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [active, createOpen, selectedRental]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 3800);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const selectedMachines = useMemo(() => inventory.filter(item => selectedIds.includes(item.id)), [inventory, selectedIds]);
  const rentalOrders = useMemo(() => {
    return groupRentalsByOrder(rentals).map(({ key, items }) => {
      const orderedItems = [...items].sort((left, right) => left.sn.localeCompare(right.sn));
      const first = orderedItems[0];
      return {
        key,
        items: orderedItems,
        rentalNo: first.displayRentalNo || first.rentalNo,
        customerName: first.customerName,
        customerPhone: first.customerPhone,
        startDate: orderedItems.map(item => item.rentalStartDate).sort()[0],
        endDate: orderedItems.map(item => item.rentalEndDate).sort().at(-1) || first.rentalEndDate,
        activeCount: orderedItems.filter(item => item.status === 'renting').length,
        returnedCount: orderedItems.filter(item => item.status === 'returned').length,
        boughtOutCount: orderedItems.filter(item => item.status === 'purchased').length,
        totalPrice: orderedItems.reduce((sum, item) => sum + Number(item.cumulativeRentalAmount ?? item.rentalTotalPrice ?? 0), 0),
        activeDeposit: orderedItems.filter(item => item.status === 'renting').reduce((sum, item) => sum + Number(item.deposit || 0), 0),
        dueItems: orderedItems.filter(item => item.status === 'renting' && dueLabel(item)),
      };
    });
  }, [rentals]);
  const selectedRentalOrder = selectedRental
    ? rentalOrders.find(order => order.items.some(item => item.id === selectedRental.id))
    : undefined;
  const selectedOrderCanEditTerms = Boolean(selectedRentalOrder?.items.length && selectedRentalOrder.items.every(item => item.status === 'renting' && !(item.renewals?.length)));
  const validity = useMachineEligibility(selectedMachines.map(({ id, sn }) => ({ id, sn })), 'rental');
  useWorkspaceDirty(Boolean((createOpen && (selectedIds.length || customerName || customerPhone || customerAddress || remark || rentalType !== 'day')) || returnOpen || rentalAction));
  const duration = useMemo(() => {
    return calculateRentalDuration(startDate, endDate, rentalType === 'month' ? 'month' : 'day');
  }, [startDate, endDate, rentalType]);
  const totalPrice = duration * selectedIds.reduce((sum, id) => sum + (Number(rentalTerms[id]?.rentalUnitPrice) || 0), 0);
  const rentingCount = summaryRentals.filter((rental) => rental.status === 'renting').length;
  const returnedCount = summaryRentals.filter((rental) => rental.status === 'returned').length;
  const activeDeposit = summaryRentals.filter((rental) => rental.status === 'renting').reduce((sum, rental) => sum + Number(rental.deposit || 0), 0);
  const activeRent = summaryRentals.filter((rental) => rental.status === 'renting').reduce((sum, rental) => sum + Number(rental.cumulativeRentalAmount ?? rental.rentalTotalPrice ?? 0), 0);
  const renewalEndFor = (rental: Rental) => renewalMode === 'duration'
    ? renewalBillingUnit === 'month'
      ? addRentalMonths(rental.rentalEndDate, Math.max(1, Number(renewalDuration) || 1)) || ''
      : addRentalDays(rental.rentalEndDate, Math.max(1, Number(renewalDuration) || 1)) || ''
    : newEndDate;
  const renewalDurationFor = (rental: Rental) => calculateRentalDuration(rental.rentalEndDate, renewalEndFor(rental), renewalBillingUnit);
  const editRentalDuration = calculateRentalDuration(editRentalStartDate, editRentalEndDate, selectedRental?.rentalType === 'month' ? 'month' : 'day');
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
    setSelectedIds([]); setRentalTerms({}); setCustomerName(''); setCustomerPhone(''); setCustomerAddress(''); setStartDate(dateInput()); setEndDate(dateInput(1)); setRentalType('day'); setUnitPrice(''); setDeposit(''); setRemark(''); setMachineSearch('');
  };

  const addMachine = (item: InventoryItem) => {
    setInventory(current => [item, ...current.filter(row => row.id !== item.id)]);
    setSelectedIds(current => current.includes(item.id) ? current : [...current, item.id]);
    setRentalTerms(current => current[item.id] ? current : { ...current, [item.id]: { rentalUnitPrice: unitPrice, deposit } });
  };

  const updateRentalTerm = (id: string, key: keyof RentalTerms, value: string) => {
    setRentalTerms(current => ({ ...current, [id]: { ...(current[id] || { rentalUnitPrice: '', deposit: '' }), [key]: value } }));
  };

  const submitRental = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedIds.length) { notify('请至少选择一台可租机器', 'error'); return; }
    if (selectedIds.some(id => !(Number(rentalTerms[id]?.rentalUnitPrice) > 0) || !(Number(rentalTerms[id]?.deposit || 0) >= 0))) { notify('请检查每台机器的租赁单价和押金', 'error'); return; }
    if (validity.checking || validity.error || validity.invalidIds.length) { notify(validity.error || '所选机器已不可租赁，请移除失效机器后重试', 'error'); return; }
    setSubmitting(true);
    try {
      const response = await fetch('/api/rentals', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: selectedIds.map(inventoryId => ({ inventoryId, rentalUnitPrice: Number(rentalTerms[inventoryId]?.rentalUnitPrice), deposit: Number(rentalTerms[inventoryId]?.deposit || 0) })), customerName, customerPhone, customerAddress, rentalStartDate: startDate, rentalEndDate: endDate, rentalType, remark }) });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error?.message || '创建租赁记录失败');
      setCreateOpen(false); resetCreateForm(); notify('租赁单 ' + payload.data.rentalNo + ' 已创建，共 ' + payload.data.count + ' 台');
      await loadData();
    } catch (submitError) { notify(submitError instanceof Error ? submitError.message : '创建租赁记录失败', 'error'); } finally { setSubmitting(false); }
  };

  const completeReturn = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedRental) return;
    setReturning(true);
    try {
      const response = await fetch('/api/rentals', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: selectedRental.id, action: 'return', returnDate, returnType }) });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error?.message || '归还失败');
      const rentalNo = selectedRental.rentalNo;
      setSelectedRental(null); setReturnOpen(false); notify('租赁单 ' + rentalNo + ' 已归还');
      await loadData();
    } catch (returnError) { notify(returnError instanceof Error ? returnError.message : '归还失败', 'error'); } finally { setReturning(false); }
  };

  const beginRenewal = (targets: Rental[]) => {
    if (!targets.length || targets.some(item => item.status !== 'renting')) return;
    const first = targets[0];
    setSelectedRental(first); setRenewalTargets(targets); setRentalAction('renew'); setReturnOpen(false);
    setRenewalMode('duration'); setRenewalBillingUnit(first.rentalType === 'month' ? 'month' : 'day'); setRenewalDuration('1');
    setNewEndDate(addRentalDays(first.rentalEndDate, 1) || ''); setRenewalPriceMode('original_unit');
    setRenewalUnitPrices(Object.fromEntries(targets.map(item => [item.id, String(item.rentalUnitPrice || 0)])));
    setRenewalTotalPrices(Object.fromEntries(targets.map(item => [item.id, ''])));
    setRenewalDepositDeltas(Object.fromEntries(targets.map(item => [item.id, '0'])));
    setRenewalDepositReason(''); setRenewalNote('');
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
      setEditRentalPrices(Object.fromEntries(selectedRentalOrder.items.map(item => [item.id, String(item.rentalUnitPrice)])));
      setEditRentalReason(''); setRentalAction(action); return;
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
        return { id: rental.id, newEndDate: endDate, billingUnit: renewalBillingUnit, priceMode: renewalPriceMode, unitPrice: unit, totalAmount: total, depositDelta: Number(renewalDepositDeltas[rental.id] || 0), depositChangeReason: renewalDepositReason.trim(), note: renewalNote.trim() };
      });
      const invalidDate = renewalTargets.find(rental => !renewalEndFor(rental) || renewalEndFor(rental) <= rental.rentalEndDate);
      if (invalidDate) { notify(`SN ${invalidDate.sn} 的新到期日必须晚于当前到期日`, 'error'); return; }
      if (renewalPriceMode === 'custom_unit' && renewalTargets.some(rental => !(renewalUnitPrices[rental.id] ?? '').trim())) { notify('请填写每台机器的续租单价', 'error'); return; }
      if (renewalPriceMode === 'custom_unit' && items.some(item => !Number.isFinite(item.unitPrice) || Number(item.unitPrice) < 0)) { notify('请填写每台机器有效的续租单价', 'error'); return; }
      if (renewalPriceMode === 'custom_total' && renewalTargets.some(rental => !(renewalTotalPrices[rental.id] ?? '').trim())) { notify('请填写每台机器的本次续租总额', 'error'); return; }
      if (renewalPriceMode === 'custom_total' && items.some(item => !Number.isFinite(item.totalAmount) || Number(item.totalAmount) < 0)) { notify('请填写每台机器有效的本次租金', 'error'); return; }
      if (renewalTargets.some(rental => renewalAmountFor(rental) === 0) && !renewalNote.trim()) { notify('续租金额为 0 时，请填写原因', 'error'); return; }
      if (items.some(item => !Number.isFinite(item.depositDelta) || Number(item.depositDelta) + Number(renewalTargets.find(target => target.id === item.id)?.deposit || 0) < 0)) { notify('押金退还金额不能超过当前押金', 'error'); return; }
      if (items.some(item => item.depositDelta !== 0) && !renewalDepositReason.trim()) { notify('请填写押金调整原因', 'error'); return; }
      body = items.length === 1 ? { action: 'renew', ...items[0] } : { action: 'renew_batch', items };
    } else if (rentalAction === 'edit_terms') {
      const orderItems = selectedRentalOrder?.items || [];
      if (!orderItems.length || !selectedOrderCanEditTerms) { notify('订单已有续租记录或已结束，不能覆盖原租赁条款', 'error'); return; }
      if (!editRentalReason.trim()) { notify('请填写条款更正原因', 'error'); return; }
      if (!editRentalDuration) { notify('结束日期必须晚于开始日期，并且至少达到一个完整计费单位', 'error'); return; }
      if (orderItems.some(item => !(Number(editRentalPrices[item.id]) > 0) || !Number.isFinite(Number(editRentalPrices[item.id])))) { notify('请为每台机器填写大于 0 的有效租金', 'error'); return; }
      body = {
        id: selectedRental.id, action: 'edit_terms', rentalStartDate: editRentalStartDate,
        rentalEndDate: editRentalEndDate, reason: editRentalReason.trim(),
        items: orderItems.map(item => ({ id: item.id, rentalUnitPrice: Number(editRentalPrices[item.id]) })),
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
      const actionLabel = rentalAction === 'renew' ? `续租已登记 ${renewalTargets.length} 台` : rentalAction === 'buyout' ? '买断出库已完成' : rentalAction === 'cancel_buyout' ? '买断已撤销，机器恢复租赁中' : rentalAction === 'edit_terms' ? `已更正整单条款，重新计算 ${payload.data.count} 台机器租金` : '异常跟进已记录';
      setRentalAction(null);
      setRenewalTargets([]); setSelectedRenewalIds(new Set());
      notify(actionLabel);
      const refreshed = await loadData();
      if (refreshed) {
        const latestRental = refreshed.find(item => item.id === selectedRental.id);
        if (latestRental) setSelectedRental(latestRental);
      }
    } catch (error) { notify(error instanceof Error ? error.message : '处理失败', 'error'); }
    finally { setSavingAction(false); }
  };

  const toggleOrder = (key: string) => setExpandedOrders(current => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const openRentalDetail = (rental: Rental) => {
    setSelectedRental(rental); setRenewalTargets([]); setReturnOpen(false); setRentalAction(null);
  };

  const toggleRenewalSelection = (id: string) => setSelectedRenewalIds(current => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const statusOptions: SelectOption[] = [
    { value: 'all', label: '全部状态' }, { value: 'renting', label: '租赁中' }, { value: 'returned', label: '已归还' }, { value: 'purchased', label: '已买断出库' },
  ];
  const typeOptions: SelectOption[] = [
    { value: 'day', label: '按日计费' }, { value: 'month', label: '按月计费' },
  ];
  const returnOptions: SelectOption[] = [
    { value: '正常归还', label: '正常归还' }, { value: '维修归还', label: '维修归还' }, { value: '其他', label: '其他' },
  ];
  return <div className="mx-auto max-w-[1400px] space-y-5 pb-8">
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div><p className="mb-1 text-[12px] font-medium uppercase tracking-[0.12em] text-primary">库存业务</p><h1 className="text-xl font-bold text-ink-deep">租赁管理</h1><p className="mt-2 text-[13px] text-ink-soft">跟进续租条款、买断结算与机器归还</p></div>
      <button type="button" onClick={() => { resetCreateForm(); setCreateOpen(true); }} className="btn-primary inline-flex items-center gap-2"><Check className="h-4 w-4" />新建租赁</button>
    </header>

    <section aria-label="租赁统计" className="grid grid-cols-2 gap-3 xl:grid-cols-4">
      {[
        { label: '租赁中', value: rentingCount + ' 台', icon: Clock3, color: 'text-amber-600 bg-amber-500/10' },
        { label: '已归还', value: returnedCount + ' 台', icon: RotateCcw, color: 'text-emerald-600 bg-emerald-500/10' },
        { label: '在租押金', value: money(activeDeposit), icon: ArchiveRestore, color: 'text-primary bg-primary/10' },
        { label: '累计约定租金', value: money(activeRent), icon: Check, color: 'text-indigo-600 bg-indigo-500/10' },
      ].map((item) => <div key={item.label} className="glass flex items-center justify-between gap-3 px-4 py-4 sm:px-5"><div><p className="text-xs text-ink-soft">{item.label}</p><p className="mt-1 text-lg font-semibold text-ink-deep">{item.value}</p></div><span className={'rounded-xl p-2.5 ' + item.color}><item.icon className="h-5 w-5" /></span></div>)}
    </section>

    <section className="glass overflow-hidden">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-line/70 px-4 py-4 sm:px-5">
        <div><h2 className="text-base font-semibold text-ink-deep">租赁订单</h2><p className="mt-1 text-xs text-ink-soft">{rentalOrders.length} 笔订单 · {rentals.length} 台机器，展开订单查看单台状态和处理记录</p></div>
        <button type="button" onClick={() => void loadData()} disabled={loading} className="btn-ghost inline-flex items-center gap-2 py-2 text-xs" title="刷新"><RotateCcw className={'h-4 w-4 ' + (loading ? 'animate-spin' : '')} />刷新</button>
      </div>
      <div className="grid gap-3 border-b border-line/70 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_200px] sm:px-5">
        <MachineSearchInput value={search} onChange={setSearch} endpoint="/api/inventory/lookup?context=inventory" onSelect={item => setSearch(item.sn)} onSearch={setSearch} placeholder="搜索租赁单号、SN 后四位、型号或客户" ariaLabel="搜索租赁记录" />
        <CustomSelect value={status} onChange={setStatus} options={statusOptions} placeholder="全部状态" />
      </div>
      {loading && rentals.length === 0 ? <div className="px-5 py-14 text-center text-sm text-ink-soft">正在加载租赁记录...</div> : rentalOrders.length === 0 ? <div className="px-5 py-14 text-center"><p className="text-sm font-medium text-ink-deep">{search || status !== 'all' ? '没有符合条件的租赁记录' : '暂无租赁记录'}</p><p className="mt-1 text-xs text-ink-soft">{search || status !== 'all' ? '调整关键词或状态后重试' : '创建租赁后，机器和归还状态会在这里跟踪'}</p></div> : <div className="divide-y divide-line/70">
        {rentalOrders.map((order) => {
          const expanded = expandedOrders.has(order.key);
          const statusLabel = order.activeCount ? `租赁中 ${order.activeCount} 台` : order.boughtOutCount && order.returnedCount ? '已结束' : order.boughtOutCount ? '已买断出库' : '已全部归还';
          const urgentDueItems = order.dueItems.filter(item => dueLabel(item).startsWith('已逾期') || dueLabel(item) === '今日到期');
          return <div key={order.key}>
            <button type="button" aria-expanded={expanded} onClick={() => toggleOrder(order.key)} className="grid w-full gap-3 px-4 py-4 text-left transition-colors hover:bg-white/45 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-center sm:px-5">
              <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><ChevronDown className={'h-4 w-4 shrink-0 text-primary transition-transform ' + (expanded ? 'rotate-180' : '')} /><span className="font-mono text-sm font-semibold text-ink-deep">{order.rentalNo}</span><span className="status-pill info">{order.items.length} 台</span><span className={'status-pill ' + (order.activeCount ? 'warn' : 'ok')}>{statusLabel}</span>{order.returnedCount > 0 && order.activeCount > 0 && <span className="status-pill ok">已归还 {order.returnedCount} 台</span>}{order.boughtOutCount > 0 && <span className="status-pill info">已买断 {order.boughtOutCount} 台</span>}{urgentDueItems.length > 0 && <span className="status-pill danger">{urgentDueItems.length} 台需关注</span>}{order.dueItems.length > urgentDueItems.length && <span className="status-pill warn">{order.dueItems.length - urgentDueItems.length} 台即将到期</span>}</div><p className="mt-1 truncate pl-6 text-[13px] text-ink-deep">{order.customerName} · {order.customerPhone}</p></div>
              <div className="text-xs text-ink-soft"><p>{order.startDate} 至最晚到期 {order.endDate}</p><p className="mt-1">租赁中 {order.activeCount} 台 · 已归还 {order.returnedCount} 台</p></div>
              <div className="text-xs"><p className="font-medium text-ink-deep">累计约定租金 {money(order.totalPrice)}</p><p className="mt-1 text-ink-soft">在租押金 {money(order.activeDeposit)}</p></div>
              <span className="hidden text-xs text-primary sm:block">{expanded ? '收起机器' : '展开机器'}</span>
            </button>
            {expanded && <div className="space-y-2 border-t border-line/50 bg-white/25 px-4 py-3 sm:px-6">
              {order.activeCount > 0 && <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line/70 bg-white/55 px-3 py-2"><label className="inline-flex items-center gap-2 text-xs text-ink-deep"><input type="checkbox" checked={order.items.filter(item => item.status === 'renting').every(item => selectedRenewalIds.has(item.id))} onChange={event => setSelectedRenewalIds(current => { const next = new Set(current); for (const item of order.items.filter(row => row.status === 'renting')) { if (event.target.checked) next.add(item.id); else next.delete(item.id); } return next; })} />选择本单全部在租机器</label><button type="button" disabled={!order.items.some(item => item.status === 'renting' && selectedRenewalIds.has(item.id))} onClick={() => beginRenewal(order.items.filter(item => item.status === 'renting' && selectedRenewalIds.has(item.id)))} className="btn-secondary py-1.5 text-xs disabled:opacity-45">批量续租 {order.items.filter(item => item.status === 'renting' && selectedRenewalIds.has(item.id)).length || ''} 台</button></div>}
              {order.items.map(rental => <div key={rental.id} className="grid gap-3 rounded-xl border border-line/60 bg-white/55 p-3 sm:grid-cols-[24px_minmax(0,1.4fr)_minmax(150px,.8fr)_minmax(150px,.7fr)_auto] sm:items-center">
                <div className="flex items-center">{rental.status === 'renting' && <input type="checkbox" aria-label={`选择 ${rental.sn} 续租`} checked={selectedRenewalIds.has(rental.id)} onChange={() => toggleRenewalSelection(rental.id)} />}</div>
                <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="truncate text-xs font-semibold text-ink-deep">{productName(rental)}</span><span className={'status-pill ' + (rental.status === 'renting' ? 'warn' : rental.status === 'purchased' ? 'info' : 'ok')}>{rentalStatusLabel(rental.status)}</span>{dueLabel(rental) && <span className={'status-pill ' + (dueLabel(rental).startsWith('已逾期') || dueLabel(rental) === '今日到期' ? 'danger' : 'warn')}>{dueLabel(rental)}</span>}</div><p className="mt-1 truncate font-mono text-[11px] text-ink-soft">{rental.sn} · {rental.config || '配置待补充'}</p></div>
                <div className="text-xs text-ink-soft"><p>{rental.rentalStartDate} 至 {rental.rentalEndDate}</p><p className="mt-1">当前到期 · {rental.rentalType === 'month' ? '原始按月计费' : '原始按日计费'}</p></div>
                <div className="text-xs"><p className="font-medium text-ink-deep">累计租金 {money(rental.cumulativeRentalAmount ?? rental.rentalTotalPrice)}</p><p className="mt-1 text-ink-soft">原租金 {money(rental.rentalTotalPrice)} · 续租 {money(rental.renewalTotal || 0)}</p><p className="mt-1 text-ink-soft">押金余额 {money(rental.deposit)}</p></div>
                <button type="button" onClick={() => openRentalDetail(rental)} className="btn-secondary py-1.5 text-xs">机器详情与处理</button>
              </div>)}
            </div>}
          </div>;
        })}
      </div>}
    </section>

    {createOpen && <ModalShell title="新建租赁" subtitle="可一次选择多台机器，同单共用客户和租期，租金与押金逐台登记" onClose={() => setCreateOpen(false)} footer={<><span className="mr-auto self-center text-xs text-ink-soft">已选择 {selectedIds.length} 台</span><button type="button" onClick={() => setCreateOpen(false)} className="btn-ghost">取消</button><button form="rental-create-form" type="submit" disabled={submitting || !selectedIds.length || !duration || validity.checking || !!validity.error || validity.invalidIds.length > 0} className="btn-primary inline-flex items-center gap-2 disabled:opacity-60"><Check className="h-4 w-4" />{submitting ? '提交中...' : `开始租赁 ${selectedIds.length || ''}`}</button></>}>
      <form id="rental-create-form" onSubmit={submitRental} className="space-y-5">
        <section><div className="mb-2"><h3 className="text-sm font-semibold text-ink-deep">选择在库机器 <span className="text-danger">*</span></h3><p className="mt-1 text-xs text-ink-soft">输入 SN 后四位或型号搜索，选中后可继续添加其他机器</p></div>
          <MachineSearchInput<InventoryItem> value={machineSearch} onChange={setMachineSearch} endpoint="/api/inventory/lookup?context=rental" onSelect={item => { addMachine(item); setMachineSearch(''); }} onSelectMany={items => { items.forEach(addMachine); setMachineSearch(''); }} onSearch={setMachineSearch} scanEnabled batchEnabled ariaLabel="搜索可租机器" />
          <div className="mt-2 grid gap-2 rounded-xl border border-line/70 bg-white/40 p-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"><label className="text-[10px] text-ink-soft">批量单价<input type="number" min="0.01" step="0.01" value={unitPrice} onChange={event => setUnitPrice(event.target.value)} className="field mt-1 !px-2 !py-1.5 text-xs" placeholder="应用到新选机器" /></label><label className="text-[10px] text-ink-soft">批量押金<input type="number" min="0" step="0.01" value={deposit} onChange={event => setDeposit(event.target.value)} className="field mt-1 !px-2 !py-1.5 text-xs" placeholder="选填，默认 0" /></label><button type="button" className="btn-secondary py-1.5 text-xs" disabled={!selectedIds.length} onClick={() => setRentalTerms(Object.fromEntries(selectedIds.map(id => [id, { rentalUnitPrice: unitPrice, deposit }])))}>应用到已选</button></div>
          {selectedMachines.length > 0 && <div className="mt-3 overflow-hidden rounded-xl border border-primary/20 bg-primary/5"><div className="flex items-center justify-between border-b border-primary/10 px-3 py-2"><span className="text-xs font-semibold text-ink-deep">已选 {selectedMachines.length} 台</span><button type="button" className="text-xs text-primary" onClick={() => { setSelectedIds([]); setRentalTerms({}); }}>清空</button></div><div className="max-h-64 divide-y divide-line/70 overflow-y-auto">{selectedMachines.map(item => { const invalid = validity.invalidIds.includes(item.id); const terms = rentalTerms[item.id] || { rentalUnitPrice: '', deposit: '' }; return <div key={item.id} className="grid gap-2 p-3 sm:grid-cols-[minmax(0,1fr)_105px_105px_auto] sm:items-center"><div className="min-w-0"><p className="truncate text-xs font-medium text-ink-deep">{productName(item)}{invalid && <span className="ml-2 text-danger">已不可租</span>}</p><p className="mt-0.5 truncate font-mono text-[11px] text-ink-soft">{item.sn} · {configText(item)}</p></div><label className="text-[10px] text-ink-soft">单价<input type="number" min="0.01" step="0.01" value={terms.rentalUnitPrice} onChange={event => updateRentalTerm(item.id, 'rentalUnitPrice', event.target.value)} className="field mt-1 !px-2 !py-1.5 text-xs" required /></label><label className="text-[10px] text-ink-soft">押金<input type="number" min="0" step="0.01" value={terms.deposit} onChange={event => updateRentalTerm(item.id, 'deposit', event.target.value)} className="field mt-1 !px-2 !py-1.5 text-xs" /></label><button type="button" onClick={() => { setSelectedIds(ids => ids.filter(id => id !== item.id)); setRentalTerms(current => { const next = { ...current }; delete next[item.id]; return next; }); }} className="btn-ghost justify-self-end p-2 text-ink-soft hover:text-danger" aria-label={`移除 ${item.sn}`}><X className="h-4 w-4" /></button></div>; })}</div></div>}
          <div className="mt-2 max-h-40 overflow-y-auto rounded-xl border border-line/80 bg-white/55">{inventory.length === 0 ? <p className="p-4 text-center text-xs text-ink-soft">输入 SN 后四位或型号查找可租机器</p> : inventory.map((item) => { const chosen = selectedIds.includes(item.id); return <button type="button" key={item.id} disabled={chosen} onClick={() => addMachine(item)} className={'flex w-full items-center justify-between gap-3 border-b border-line/70 px-3 py-2.5 text-left last:border-0 ' + (chosen ? 'bg-primary/5 opacity-60' : 'hover:bg-white/70')}><span className="min-w-0"><span className="block truncate text-xs font-medium text-ink-deep">{productName(item)}</span><span className="mt-0.5 block truncate font-mono text-[10px] text-ink-soft">{item.sn} · {configText(item)}</span></span><span className="shrink-0 text-xs font-medium text-primary">{chosen ? '已添加' : '添加'}</span></button>; })}</div>
        </section>
        {(validity.error || validity.invalidIds.length > 0) && <p role="alert" className="rounded-xl bg-danger/5 p-3 text-xs text-danger">{validity.error || '部分所选机器状态已变化，请移除不可租机器后重试。'}</p>}
        <section className="grid gap-3 sm:grid-cols-2">
          <label className="text-xs text-ink-soft">客户姓名 <span className="text-danger">*</span><input value={customerName} onChange={(event) => setCustomerName(event.target.value)} className="field mt-1.5" required /></label>
          <label className="text-xs text-ink-soft">联系电话 <span className="text-danger">*</span><input type="tel" value={customerPhone} onChange={(event) => setCustomerPhone(event.target.value)} className="field mt-1.5" required /></label>
          <label className="text-xs text-ink-soft sm:col-span-2">客户地址 <span className="text-danger">*</span><input value={customerAddress} onChange={(event) => setCustomerAddress(event.target.value)} className="field mt-1.5" required /></label>
          <label className="text-xs text-ink-soft">开始日期<input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} className="field mt-1.5" required /></label>
          <label className="text-xs text-ink-soft">结束日期<input type="date" value={endDate} min={startDate} onChange={(event) => setEndDate(event.target.value)} className="field mt-1.5" required /></label>
          <label className="text-xs text-ink-soft">计费方式<div className="mt-1.5"><CustomSelect value={rentalType} onChange={setRentalType} options={typeOptions} /></div></label>
          <label className="text-xs text-ink-soft">备注<input value={remark} onChange={(event) => setRemark(event.target.value)} className="field mt-1.5" /></label>
        </section>
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-primary/5 px-4 py-3"><div><p className="text-xs text-ink-soft">预计 {duration || '-'} 个{rentalType === 'month' ? '月' : '日'}计费单位 · {selectedMachines.length} 台</p><p className="mt-1 text-[11px] text-ink-soft">租期按起租日加计费时长计算，到期日不重复计费。</p></div><span className="text-xs text-ink-soft">本单预计租金 <b className="ml-1 font-mono text-sm text-ink-deep">{money(totalPrice)}</b></span></div>
      </form>
    </ModalShell>}

    {selectedRental && <ModalShell title={selectedRental.displayRentalNo || selectedRental.rentalNo} subtitle={rentalAction === 'renew' && renewalTargets.length > 1 ? `批量续租 · ${renewalTargets.length} 台机器` : rentalAction === 'edit_terms' ? `更正整张订单 · ${selectedRental.orderMachineCount || selectedRentalOrder?.items.length || 1} 台机器` : `机器租赁详情 · SN ${selectedRental.sn}`} onClose={() => { setSelectedRental(null); setRenewalTargets([]); setReturnOpen(false); setRentalAction(null); }} footer={returnOpen ? <><button type="button" onClick={() => setReturnOpen(false)} className="btn-ghost">返回详情</button><button form="rental-return-form" type="submit" disabled={returning} className="btn-primary inline-flex items-center gap-2 disabled:opacity-60"><Check className="h-4 w-4" />{returning ? '处理中...' : '确认归还'}</button></> : rentalAction ? <><button type="button" onClick={() => setRentalAction(null)} className="btn-ghost">取消</button><button form="rental-action-form" type="submit" disabled={savingAction} className="btn-primary inline-flex items-center gap-2 disabled:opacity-60"><Check className="h-4 w-4" />{savingAction ? '处理中...' : rentalAction === 'renew' ? `确认续租 ${renewalTargets.length} 台` : rentalAction === 'edit_terms' ? '保存租赁更正' : rentalAction === 'buyout' ? '确认买断出库' : rentalAction === 'cancel_buyout' ? '确认撤销买断' : '保存跟进'}</button></> : <><button type="button" onClick={() => setSelectedRental(null)} className="btn-ghost">关闭</button>{selectedRental.status === 'renting' && <>{selectedOrderCanEditTerms && <button type="button" onClick={() => openRentalAction('edit_terms')} className="btn-secondary inline-flex items-center gap-1.5 py-2 text-xs"><Pencil className="h-4 w-4" />更正租赁条款</button>}<button type="button" onClick={() => openRentalAction('renew')} className="btn-secondary inline-flex items-center gap-1.5 py-2 text-xs"><CalendarPlus className="h-4 w-4" />续租</button><button type="button" onClick={() => openRentalAction('buyout')} className="btn-secondary inline-flex items-center gap-1.5 py-2 text-xs"><CircleDollarSign className="h-4 w-4" />买断</button><button type="button" onClick={() => openRentalAction('exception')} className="btn-secondary inline-flex items-center gap-1.5 py-2 text-xs"><MessageSquareText className="h-4 w-4" />异常跟进</button><button type="button" onClick={() => { setRentalAction(null); setReturnDate(dateInput()); setReturnOpen(true); }} className="btn-primary inline-flex items-center gap-1.5 py-2 text-xs"><RotateCcw className="h-4 w-4" />归还</button></>}{selectedRental.status === 'purchased' && selectedRental.returnType === '客户买断' && <button type="button" onClick={() => openRentalAction('cancel_buyout')} className="btn-secondary inline-flex items-center gap-1.5 py-2 text-xs text-danger"><RotateCcw className="h-4 w-4" />撤销买断</button>}</>}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2"><span className={'status-pill ' + (selectedRental.status === 'renting' ? 'warn' : selectedRental.status === 'purchased' ? 'info' : 'ok')}>{rentalStatusLabel(selectedRental.status)}</span>{dueLabel(selectedRental) && <span className={'status-pill ' + (dueLabel(selectedRental).startsWith('已逾期') || dueLabel(selectedRental) === '今日到期' ? 'danger' : 'warn')}>{dueLabel(selectedRental)}</span>}<span className="font-mono text-xs text-ink-soft">机器 SN：{selectedRental.sn}</span></div>
        <section className="rounded-xl border border-line/80 bg-white/45 p-4"><h3 className="text-sm font-semibold text-ink-deep">机器信息</h3><p className="mt-2 text-sm text-ink-deep">{productName(selectedRental)}</p><p className="mt-1 text-xs text-ink-soft">{selectedRental.config || '配置待补充'}</p></section>
        <section className="grid gap-3 sm:grid-cols-2"><DetailValue label="客户" value={selectedRental.customerName + ' · ' + selectedRental.customerPhone} /><DetailValue label="地址" value={selectedRental.customerAddress || '未填写'} /><DetailValue label="租赁开始 / 当前到期" value={selectedRental.rentalStartDate + ' 至 ' + selectedRental.rentalEndDate} /><DetailValue label="原始计费方式" value={(selectedRental.rentalType === 'month' ? '按月' : '按日') + ' · ' + selectedRental.rentalDuration + ' 个单位'} /><DetailValue label="原租金" value={money(selectedRental.rentalTotalPrice)} /><DetailValue label="续租费用累计" value={money(selectedRental.renewalTotal || 0)} /><DetailValue label="累计约定租金" value={money(selectedRental.cumulativeRentalAmount ?? selectedRental.rentalTotalPrice)} /><DetailValue label={selectedRental.status === 'purchased' && selectedRental.returnType === '客户买断' ? '买断前押金' : '当前押金余额'} value={money(selectedRental.deposit)} />{selectedRental.status === 'purchased' && selectedRental.returnType === '客户买断' && <DetailValue label="押金结算状态" value="已按买断结算拆分完成" />}<DetailValue label="备注" value={selectedRental.remark || '无'} /></section>
        {selectedRental.returnType === '客户买断' && <section className="rounded-xl border border-primary/15 bg-primary/5 p-4"><h3 className="text-sm font-semibold text-ink-deep">买断结算</h3><dl className="mt-3 grid gap-3 text-xs sm:grid-cols-2"><DetailValue label="买断方" value={selectedRental.buyoutBuyerName || selectedRental.customerName} /><DetailValue label="买断来源/渠道" value={selectedRental.buyoutSource || '未记录'} /><DetailValue label="押金退还 / 抵扣 / 留存" value={`${money(selectedRental.depositRefundAmount || 0)} / ${money(selectedRental.depositAppliedAmount || 0)} / ${money(selectedRental.depositRetainedAmount || 0)}`} /><DetailValue label="其他结算调整" value={money(selectedRental.settlementAdjustment || 0)} /></dl>{selectedRental.settlementNote && <p className="mt-3 whitespace-pre-wrap text-xs text-ink-soft">说明：{selectedRental.settlementNote}</p>}</section>}
        {selectedRental.status === 'returned' && <section className="rounded-xl border border-success/15 bg-success/5 p-4"><h3 className="text-sm font-semibold text-ink-deep">归还信息</h3><p className="mt-2 text-xs text-ink-soft">{selectedRental.returnDate || '日期未记录'} · {selectedRental.returnType || '归还方式未记录'}</p></section>}
        {!!selectedRental.renewals?.length && <section className="rounded-xl border border-line/70 bg-white/35 p-4"><div className="flex items-center justify-between gap-3"><h3 className="text-sm font-semibold text-ink-deep">续租费用与押金调整</h3><span className="text-[11px] text-ink-soft">{selectedRental.renewals.length} 次</span></div><ol className="mt-3 space-y-3">{selectedRental.renewals.map(renewal => <li key={renewal.id} className="border-l border-primary/20 pl-3 text-xs"><p className="font-medium text-ink-deep">{renewal.periodStartDate} 至 {renewal.newEndDate} · {money(renewal.totalAmount)}</p><p className="mt-1 text-ink-soft">{renewal.billingUnit === 'month' ? '按月' : '按日'} {renewal.duration} 个单位 · 单价 {money(renewal.unitPrice)} · {renewal.actorName} · {renewal.createdAt}</p>{renewal.depositDelta !== 0 && <p className="mt-1 text-ink-soft">押金 {money(renewal.depositBefore)} → {money(renewal.depositAfter)} · {renewal.depositChangeReason}</p>}{renewal.note && <p className="mt-1 whitespace-pre-wrap text-ink-soft">{renewal.note}</p>}</li>)}</ol></section>}
        {rentalAction === 'edit_terms' && <form id="rental-action-form" onSubmit={submitRentalAction} className="space-y-4 rounded-xl border border-primary/20 bg-primary/5 p-4">
          <div><h3 className="text-sm font-semibold text-ink-deep">更正租赁条款</h3><p className="mt-1 text-xs text-ink-soft">起止日期应用于整张订单；只更新下方列出的机器租金，未列出的机器保留原租金。提交后按新租期重新计算总额并记录更正前后内容。</p></div>
          <section className="grid gap-3 sm:grid-cols-2"><label className="text-xs text-ink-soft">租赁开始日期<input type="date" value={editRentalStartDate} onChange={event => setEditRentalStartDate(event.target.value)} className="field mt-1.5" required /></label><label className="text-xs text-ink-soft">租赁到期日期<input type="date" value={editRentalEndDate} min={editRentalStartDate || undefined} onChange={event => setEditRentalEndDate(event.target.value)} className="field mt-1.5" required /></label></section>
          <div className="overflow-x-auto rounded-lg border border-line/70 bg-white/70"><table className="w-full min-w-[420px] text-left text-xs"><thead className="bg-white/60 text-ink-soft"><tr><th className="px-3 py-2">机器 / SN</th><th className="px-3 py-2">每{selectedRental.rentalType === 'month' ? '月' : '日'}租金</th><th className="px-3 py-2">当前总额 / 新计算</th></tr></thead><tbody className="divide-y divide-line/60">{selectedRentalOrder?.items.map(item => { const itemPrice = Number(editRentalPrices[item.id] || 0); return <tr key={item.id}><td className="px-3 py-2"><p className="font-medium text-ink-deep">{productName(item)}</p><p className="mt-0.5 font-mono text-[10px] text-ink-soft">{item.sn}</p></td><td className="px-3 py-2"><input aria-label={`${item.sn} 每${selectedRental.rentalType === 'month' ? '月' : '日'}租金`} type="number" min="0.01" step="0.01" value={editRentalPrices[item.id] ?? ''} onChange={event => setEditRentalPrices(current => ({ ...current, [item.id]: event.target.value }))} className="field w-32 !px-2 !py-1" /></td><td className="px-3 py-2"><p className="text-ink-soft">{money(item.rentalTotalPrice)}</p><p className="mt-1 font-medium text-ink-deep">{editRentalDuration ? money(itemPrice * editRentalDuration) : '请完善日期'}</p></td></tr>; })}</tbody></table></div>
          <p className="rounded-md bg-white/70 px-3 py-2 text-xs text-ink-soft">新租期：{editRentalDuration || '无效'} 个{selectedRental.rentalType === 'month' ? '月' : '日'} · 本单 {selectedRental.orderMachineCount || selectedRentalOrder?.items.length || 1} 台 · 本次更新 {selectedRentalOrder?.items.length || 1} 台租金</p>
          <label className="block text-xs text-ink-soft">更正原因<textarea value={editRentalReason} onChange={event => setEditRentalReason(event.target.value)} className="field mt-1.5 min-h-20 resize-y" maxLength={500} required placeholder="例如：录入时租期选择错误，经客户确认改为……" /></label>
        </form>}
        {rentalAction === 'renew' && <form id="rental-action-form" onSubmit={submitRentalAction} className="space-y-4 rounded-xl border border-primary/20 bg-primary/5 p-4">
          <div><h3 className="text-sm font-semibold text-ink-deep">续租条款</h3><p className="mt-1 text-xs text-ink-soft">续租从各台机器当前到期日的次日开始，原租金保留；本次费用逐台记录。</p></div>
          <section className="grid gap-3 sm:grid-cols-2">
            <div><p className="mb-1.5 text-xs text-ink-soft">延长方式</p><div className="inline-flex rounded-lg border border-line bg-white p-1"><button type="button" onClick={() => setRenewalMode('duration')} className={'rounded-md px-3 py-1.5 text-xs ' + (renewalMode === 'duration' ? 'bg-primary text-white' : 'text-ink-soft')}>延长时长</button><button type="button" onClick={() => setRenewalMode('date')} className={'rounded-md px-3 py-1.5 text-xs ' + (renewalMode === 'date' ? 'bg-primary text-white' : 'text-ink-soft')}>指定新到期日</button></div></div>
            {renewalMode === 'duration' ? <div className="grid grid-cols-[1fr_120px] gap-2"><label className="text-xs text-ink-soft">延长单位数<input type="number" min="1" step="1" value={renewalDuration} onChange={event => setRenewalDuration(event.target.value)} className="field mt-1.5" required /></label><label className="text-xs text-ink-soft">计费单位<select value={renewalBillingUnit} onChange={event => setRenewalBillingUnit(event.target.value as 'day' | 'month')} className="field mt-1.5"><option value="day">天</option><option value="month">月</option></select></label></div> : <label className="text-xs text-ink-soft">新到期日<input type="date" value={newEndDate} min={addRentalDays(renewalTargets.reduce((latest, item) => item.rentalEndDate > latest ? item.rentalEndDate : latest, selectedRental.rentalEndDate), 1) || undefined} onChange={event => setNewEndDate(event.target.value)} className="field mt-1.5" required /></label>}
          </section>
          <div><p className="mb-1.5 text-xs text-ink-soft">本次租金算法</p><div className="flex flex-wrap gap-2"><button type="button" onClick={() => setRenewalPriceMode('original_unit')} className={'btn-secondary py-1.5 text-xs ' + (renewalPriceMode === 'original_unit' ? 'border-primary text-primary' : '')}>沿用每台原单价</button><button type="button" onClick={() => setRenewalPriceMode('custom_unit')} className={'btn-secondary py-1.5 text-xs ' + (renewalPriceMode === 'custom_unit' ? 'border-primary text-primary' : '')}>自定义每台单价</button><button type="button" onClick={() => { setRenewalPriceMode('custom_total'); setRenewalTotalPrices(current => ({ ...Object.fromEntries(renewalTargets.map(item => [item.id, String(Math.round(Number(item.rentalUnitPrice || 0) * renewalDurationFor(item) * 100) / 100)])), ...current })); }} className={'btn-secondary py-1.5 text-xs ' + (renewalPriceMode === 'custom_total' ? 'border-primary text-primary' : '')}>逐台填写本次总额</button></div></div>
          <div className="overflow-x-auto rounded-lg border border-line/70 bg-white/70"><table className="w-full min-w-[680px] text-left text-xs"><thead className="bg-white/60 text-ink-soft"><tr><th className="px-3 py-2">机器 / SN</th><th className="px-3 py-2">当前到期 → 新到期</th><th className="px-3 py-2">续租单位</th><th className="px-3 py-2">本次租金</th><th className="px-3 py-2">押金调整(+收 / -退)</th></tr></thead><tbody className="divide-y divide-line/60">{renewalTargets.map(item => <tr key={item.id}><td className="px-3 py-2"><p className="font-medium text-ink-deep">{productName(item)}</p><p className="mt-0.5 font-mono text-[10px] text-ink-soft">{item.sn}</p></td><td className="px-3 py-2 text-ink-soft">{item.rentalEndDate} → {renewalEndFor(item) || '请选择'}</td><td className="px-3 py-2 text-ink-soft">{renewalDurationFor(item)} {renewalBillingUnit === 'month' ? '月' : '天'}</td><td className="px-3 py-2">{renewalPriceMode === 'custom_unit' ? <input aria-label={`${item.sn} 续租单价`} type="number" min="0" step="0.01" value={renewalUnitPrices[item.id] ?? String(item.rentalUnitPrice)} onChange={event => setRenewalUnitPrices(current => ({ ...current, [item.id]: event.target.value }))} className="field w-28 !px-2 !py-1" /> : renewalPriceMode === 'custom_total' ? <input aria-label={`${item.sn} 本次续租总额`} type="number" min="0" step="0.01" value={renewalTotalPrices[item.id] ?? ''} onChange={event => setRenewalTotalPrices(current => ({ ...current, [item.id]: event.target.value }))} className="field w-28 !px-2 !py-1" /> : <span>{money(renewalAmountFor(item))}</span>}</td><td className="px-3 py-2"><input aria-label={`${item.sn} 押金调整`} type="number" step="0.01" min={-Number(item.deposit || 0)} value={renewalDepositDeltas[item.id] ?? '0'} onChange={event => setRenewalDepositDeltas(current => ({ ...current, [item.id]: event.target.value }))} className="field w-28 !px-2 !py-1" /></td></tr>)}</tbody></table></div>
          {renewalDepositDeltas && Object.values(renewalDepositDeltas).some(value => Number(value) !== 0) && <label className="block text-xs text-ink-soft">押金调整原因<input value={renewalDepositReason} onChange={event => setRenewalDepositReason(event.target.value)} className="field mt-1.5" maxLength={500} required /></label>}
          <label className="block text-xs text-ink-soft">续租约定 / 备注<textarea value={renewalNote} onChange={event => setRenewalNote(event.target.value)} className="field mt-1.5 min-h-20 resize-y" maxLength={1000} placeholder="可记录优惠、特殊要求或沟通结果" /></label>
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-white/70 px-3 py-2 text-xs"><span className="text-ink-soft">涉及 {renewalTargets.length} 台 · 原租金不会被覆盖</span><span className="font-semibold text-ink-deep">本次续租合计 {customRenewalPriceMissing ? '待填写' : money(renewalTargets.reduce((sum, item) => sum + renewalAmountFor(item), 0))}</span></div>
        </form>}
        {rentalAction === 'buyout' && <form id="rental-action-form" onSubmit={submitRentalAction} className="space-y-4 rounded-xl border border-primary/20 bg-primary/5 p-4"><div><h3 className="text-sm font-semibold text-ink-deep">租赁转买断</h3><p className="mt-1 text-xs text-ink-soft">买断将结束租赁并产生独立销售记录。来源不会加入常规销售渠道。</p></div><section className="grid gap-3 sm:grid-cols-2"><label className="text-xs text-ink-soft">买断日期<input type="date" value={buyoutDate} onChange={event => setBuyoutDate(event.target.value)} className="field mt-1.5" required /></label><label className="text-xs text-ink-soft">买断金额<input type="number" min="0" step="0.01" value={buyoutPrice} onChange={event => setBuyoutPrice(event.target.value)} className="field mt-1.5" placeholder="填写成交金额" required /></label><label className="text-xs text-ink-soft">买断方<input value={buyoutBuyerName} onChange={event => setBuyoutBuyerName(event.target.value)} className="field mt-1.5" maxLength={120} required /></label><label className="text-xs text-ink-soft">买断来源 / 渠道<input list="rental-buyout-sources" value={buyoutSource} onChange={event => setBuyoutSource(event.target.value)} className="field mt-1.5" placeholder="可填写个人、企业或其他" maxLength={100} required /><datalist id="rental-buyout-sources"><option value="个人"/><option value="企业"/><option value="原租赁客户"/><option value="其他"/></datalist></label><label className="text-xs text-ink-soft sm:col-span-2">销售单号<input value={buyoutOrderNo} onChange={event => setBuyoutOrderNo(event.target.value)} className="field mt-1.5" maxLength={100} placeholder="选填，留空自动生成" /></label></section>
          <section className="space-y-3 rounded-lg border border-line/70 bg-white/65 p-3"><div><h4 className="text-xs font-semibold text-ink-deep">押金结算</h4><p className="mt-1 text-[11px] text-ink-soft">当前押金 {money(Number(selectedRental.deposit || 0))}；退款、抵扣、留存三项必须分配完整。</p></div><div className="grid gap-3 sm:grid-cols-3"><label className="text-xs text-ink-soft">退还<input type="number" min="0" step="0.01" value={buyoutDepositRefund} onChange={event => setBuyoutDepositRefund(event.target.value)} className="field mt-1.5" /></label><label className="text-xs text-ink-soft">抵扣买断款<input type="number" min="0" step="0.01" value={buyoutDepositApplied} onChange={event => setBuyoutDepositApplied(event.target.value)} className="field mt-1.5" /></label><label className="text-xs text-ink-soft">留存抵其他欠款<input type="number" min="0" step="0.01" value={buyoutDepositRetained} onChange={event => setBuyoutDepositRetained(event.target.value)} className="field mt-1.5" /></label></div><label className="block text-xs text-ink-soft">其他结算调整（加收填正数，减免填负数）<input type="number" step="0.01" value={buyoutSettlementAdjustment} onChange={event => setBuyoutSettlementAdjustment(event.target.value)} className="field mt-1.5" /></label><label className="block text-xs text-ink-soft">结算说明<textarea value={buyoutSettlementNote} onChange={event => setBuyoutSettlementNote(event.target.value)} className="field mt-1.5 min-h-16 resize-y" maxLength={500} placeholder="留存押金、额外调整或零元买断时必填" /></label></section>
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-white/70 px-3 py-2 text-xs"><span className="text-ink-soft">买断价 {money(Number(buyoutPrice || 0))} + 调整 {money(Number(buyoutSettlementAdjustment || 0))} - 押金抵扣 {money(Number(buyoutDepositApplied || 0))}</span><span className="font-semibold text-ink-deep">{Number(buyoutPrice || 0) + Number(buyoutSettlementAdjustment || 0) - Number(buyoutDepositApplied || 0) >= 0 ? '买断应收' : '买断应退'} {money(Math.abs(Number(buyoutPrice || 0) + Number(buyoutSettlementAdjustment || 0) - Number(buyoutDepositApplied || 0)))} · 押金另退 {money(Number(buyoutDepositRefund || 0))}</span></div>
        </form>}
        {rentalAction === 'cancel_buyout' && <form id="rental-action-form" onSubmit={submitRentalAction} className="rounded-xl border border-danger/20 bg-danger/5 p-4"><h3 className="text-sm font-semibold text-ink-deep">撤销租赁买断</h3><p className="mt-1 text-xs text-ink-soft">只有机器尚无后续业务、销售凭证也未产生售后或退货时才能撤销。撤销会关闭买断销售记录，并将机器恢复为租赁中。</p><p className="mt-2 rounded-md bg-warning/10 p-2 text-xs text-warning">系统只恢复业务状态和销售记录；若已发生退款、收款或押金抵扣，不会自动冲正资金，请核对后另行处理。</p><label className="mt-4 block text-xs text-ink-soft">撤销原因<textarea value={buyoutCancelReason} onChange={event => setBuyoutCancelReason(event.target.value)} className="field mt-1.5 min-h-20 resize-y" maxLength={500} required /></label></form>}
        {rentalAction === 'exception' && <form id="rental-action-form" onSubmit={submitRentalAction} className="rounded-xl border border-primary/20 bg-primary/5 p-4"><h3 className="text-sm font-semibold text-ink-deep">异常跟进</h3><p className="mt-1 text-xs text-ink-soft">记录沟通、逾期说明或机器状态跟进，不会自动改变库存状态。</p><label className="mt-4 block text-xs text-ink-soft">跟进内容<textarea value={exceptionNote} onChange={event => setExceptionNote(event.target.value)} className="field mt-1.5 min-h-24 resize-y" maxLength={1000} placeholder="记录已确认的信息和下一步安排" required /></label><p className="mt-1 text-right text-[11px] text-ink-soft">{exceptionNote.length}/1000</p></form>}
        {returnOpen && <form id="rental-return-form" onSubmit={completeReturn} className="rounded-xl border border-primary/20 bg-primary/5 p-4"><h3 className="text-sm font-semibold text-ink-deep">确认机器归还</h3><p className="mt-1 text-xs text-ink-soft">确认后机器将恢复为在库状态。</p><div className="mt-4 grid gap-3 sm:grid-cols-2"><label className="text-xs text-ink-soft">归还日期<input type="date" value={returnDate} onChange={(event) => setReturnDate(event.target.value)} className="field mt-1.5" required /></label><label className="text-xs text-ink-soft">归还方式<div className="mt-1.5"><CustomSelect value={returnType} onChange={setReturnType} options={returnOptions} /></div></label></div></form>}
        <section className="rounded-xl border border-line/70 bg-white/35 p-4"><div className="flex items-center justify-between gap-3"><h3 className="text-sm font-semibold text-ink-deep">租赁跟进记录</h3><span className="text-[11px] text-ink-soft">{selectedRental.events?.length || 0} 条</span></div>{selectedRental.events?.length ? <ol className="mt-3 space-y-3">{selectedRental.events.map((event, index) => <li key={event.id || `${event.createdAt || ''}-${index}`} className="relative border-l border-primary/20 pb-1 pl-4 last:border-0"><span className="absolute -left-[4px] top-1 h-2 w-2 rounded-full bg-primary/70" /><p className="text-xs font-medium text-ink-deep">{rentalEventLabel(event.eventType)}</p>{event.note && <p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-ink-soft">{event.note}</p>}<p className="mt-1 text-[10px] text-ink-soft">{event.createdAt || '时间未记录'}{(event.actorName || event.actorId) ? ` · ${event.actorName || event.actorId}` : ''}</p></li>)}</ol> : <p className="mt-3 text-xs text-ink-soft">暂无租赁跟进记录</p>}</section>
      </div>
    </ModalShell>}

    {toast && <div role="status" aria-live="polite" className={'fixed bottom-5 right-5 z-[120] flex max-w-[calc(100vw-2.5rem)] items-center gap-3 rounded-xl border px-4 py-3 text-sm shadow-lg backdrop-blur-xl ' + (toast.tone === 'error' ? 'border-danger/20 bg-white/95 text-danger' : 'border-success/20 bg-white/95 text-success')}><span>{toast.text}</span><button type="button" onClick={() => setToast(null)} aria-label="关闭提示"><X className="h-4 w-4" /></button></div>}
  </div>;
}

function DetailValue({ label, value }: { label: string; value: string }) {
  return <div className="rounded-xl border border-line/70 bg-white/35 px-3 py-2.5"><p className="text-[11px] text-ink-soft">{label}</p><p className="mt-1 break-words text-[13px] text-ink-deep">{value}</p></div>;
}

function rentalEventLabel(eventType?: string) {
  const labels: Record<string, string> = {
    created: '创建租赁',
    terms_corrected: '更正租赁条款',
    renewed: '续租',
    returned: '完成归还',
    buyout: '客户买断',
    buyout_reversed: '撤销买断',
    exception_followup: '异常跟进',
  };
  return (eventType && labels[eventType]) || eventType || '租赁变更';
}

