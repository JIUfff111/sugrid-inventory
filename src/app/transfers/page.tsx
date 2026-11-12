'use client';

import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, ArrowRightLeft, Plus, RefreshCw, X } from 'lucide-react';
import BusinessDialog from '@/components/BusinessDialog';
import CustomSelect from '@/components/CustomSelect';
import ConfirmDialog from '@/components/ConfirmDialog';
import Toast from '@/components/Toast';
import MachineSearchInput from '@/components/MachineSearchInput';
import { useWorkspace, useWorkspaceDirty } from '@/components/WorkspaceContext';
import { formatProductName } from '@/lib/product-name';

type Warehouse = { id: string; name: string; status: string };
type Machine = { id: string; sn: string; brand: string; model: string; year: number | null; warehouseId: string; warehouseName?: string };
export type TransferPrefill = { requestKey: string; machines: Machine[] };
type TransferItem = { id: string; inventoryId: string; sn: string; brand?: string; model?: string };
type Transfer = { id: string; transferNo: string; sourceWarehouseName: string; targetWarehouseName: string; status: string; itemCount: number; remark: string | null; createdAt: string; items?: TransferItem[] };
type TransferCheck = { id: string; sn: string; sourceWarehouseId: string; eligible: boolean; reason: string | null };
type TransferPreflight = { key: string; items: TransferCheck[]; checking: boolean; error: string };
const TRANSFER_MACHINE_LIMIT = 200;
const labels: Record<string, string> = { pending: '待审批', approved: '已批准', rejected: '已拒绝', in_transit: '调拨中', completed: '已完成', cancelled: '已取消' };
const actionLabels: Record<string, string> = { approve: '批准申请', reject: '拒绝申请', start_transit: '开始调拨', complete: '确认调拨完成', cancel: '取消调拨' };

export function TransfersWorkspace({ prefill = null }: { prefill?: TransferPrefill | null }) {
  const { active } = useWorkspace();
  const [rows, setRows] = useState<Transfer[]>([]); const [warehouses, setWarehouses] = useState<Warehouse[]>([]); const [targets, setTargets] = useState<Warehouse[]>([]); const [admin, setAdmin] = useState(false);
  const [status, setStatus] = useState('all'); const [search, setSearch] = useState(''); const [loading, setLoading] = useState(true); const [saving, setSaving] = useState(false);
  const [createOpen, setCreateOpen] = useState(false); const [prefillMode, setPrefillMode] = useState(false); const [detail, setDetail] = useState<Transfer | null>(null); const [source, setSource] = useState(''); const [target, setTarget] = useState(''); const [remark, setRemark] = useState(''); const [machines, setMachines] = useState<Machine[]>([]); const [selected, setSelected] = useState<string[]>([]); const [machineSearch, setMachineSearch] = useState(''); const [direct, setDirect] = useState(false);
  const [confirm, setConfirm] = useState<{ row: Transfer; action: string } | null>(null); const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [preflight, setPreflight] = useState<TransferPreflight>({ key: '', items: [], checking: false, error: '' });
  const lastPrefillKey = useRef('');
  const selectedRef = useRef(selected);
  useEffect(() => { selectedRef.current = selected; }, [selected]);
  const selectedMachines = machines.filter(item => selected.includes(item.id));
  const selectedGroups = [...selectedMachines.reduce((groups, item) => {
    const key = item.warehouseId || '';
    const group = groups.get(key) || { sourceWarehouseId: key, sourceWarehouseName: item.warehouseName || warehouses.find(warehouse => warehouse.id === key)?.name || '来源仓未知', machines: [] as Machine[] };
    group.machines.push(item);
    groups.set(key, group);
    return groups;
  }, new Map<string, { sourceWarehouseId: string; sourceWarehouseName: string; machines: Machine[] }>()).values()];
  const preflightKey = JSON.stringify(selectedGroups.map(group => ({ sourceWarehouseId: group.sourceWarehouseId, inventoryIds: group.machines.map(item => item.id) })));
  const currentPreflight = preflight.key === preflightKey ? preflight : null;
  const transferLimitExceeded = selected.length > TRANSFER_MACHINE_LIMIT;
  const transferChecking = selected.length > 0 && !transferLimitExceeded && selectedGroups.every(group => group.sourceWarehouseId) && (!currentPreflight || currentPreflight.checking);
  const transferError = currentPreflight?.error || '';
  const checksById = new Map((currentPreflight?.items || []).map(item => [item.id, item]));
  const invalidMachines = currentPreflight && !currentPreflight.checking && !currentPreflight.error
    ? selectedMachines.filter(item => checksById.has(item.id) && !checksById.get(item.id)?.eligible)
    : [];
  const invalidIds = invalidMachines.map(item => item.id);
  const groupValidity = Object.fromEntries(selectedGroups.map(group => [group.sourceWarehouseId, {
    invalidIds: group.machines.filter(item => !checksById.get(item.id)?.eligible).map(item => item.id),
    checking: transferChecking,
    error: transferError,
  }]));
  const sameAsTarget = selectedGroups.some(group => group.sourceWarehouseId === target);
  useWorkspaceDirty(Boolean(createOpen && (selected.length || target || remark || direct)));
  const load = useCallback(async () => { setLoading(true); try { const response = await fetch('/api/transfers?status=' + status, { cache: 'no-store' }); const result = await response.json(); if (!response.ok || !result.success) throw new Error(result.error?.message || '获取调拨失败'); setRows(result.data || []); } catch (error) { setToast({ message: error instanceof Error ? error.message : '加载失败', type: 'error' }); } finally { setLoading(false); } }, [status]);
  useEffect(() => { if (active) void load(); }, [active, load]);
  useEffect(() => { if (!active) return; void Promise.all([fetch('/api/warehouses').then(r => r.json()), fetch('/api/warehouses?resource=transfer-targets').then(r => r.json()), fetch('/api/auth/me').then(r => r.json())]).then(([a, b, c]) => { setWarehouses((a.data || []).filter((w: Warehouse) => w.status === 'active')); setTargets((b.data || []).filter((w: Warehouse) => w.status === 'active')); setAdmin(c.data?.user?.role === 'admin'); }).catch(() => setToast({ message: '加载仓库失败，请刷新重试', type: 'error' })); }, [active]);
  useEffect(() => {
    if (!prefill || !prefill.requestKey || prefill.requestKey === lastPrefillKey.current) return;
    lastPrefillKey.current = prefill.requestKey;
    const uniqueMachines = [...new Map(prefill.machines.map(item => [item.id, item])).values()];
    setPrefillMode(true); setCreateOpen(true); setMachines(uniqueMachines); setSelected(uniqueMachines.map(item => item.id));
    setSource(uniqueMachines[0]?.warehouseId || ''); setTarget(''); setRemark(''); setMachineSearch(''); setDirect(false); setPreflight({ key: '', items: [], checking: false, error: '' });
  }, [prefill]);
  useEffect(() => { if (!active || !createOpen || prefillMode || !source) return; const controller = new AbortController(); const timer = window.setTimeout(() => { void fetch('/api/inventory/lookup?context=transfer&warehouseId=' + encodeURIComponent(source) + '&q=' + encodeURIComponent(machineSearch) + '&limit=100', { cache: 'no-store', signal: controller.signal }).then(async response => { const payload = await response.json(); if (!response.ok || !payload.success) throw new Error(payload.error?.message || '查询机器失败'); if (!controller.signal.aborted) setMachines(current => { const next: Machine[] = payload.data?.items || []; return [...next, ...current.filter(item => selectedRef.current.includes(item.id) && !next.some(row => row.id === item.id))]; }); }).catch(error => { if (!controller.signal.aborted) setToast({ message: error instanceof Error ? error.message : '查询机器失败', type: 'error' }); }); }, 250); return () => { controller.abort(); window.clearTimeout(timer); }; }, [active, source, machineSearch, createOpen, prefillMode]);
  useEffect(() => {
    if (!active || !createOpen) return;
    if (!selected.length || transferLimitExceeded || selectedGroups.some(group => !group.sourceWarehouseId)) {
      setPreflight({ key: preflightKey, items: [], checking: false, error: '' });
      return;
    }
    const controller = new AbortController();
    const batches = JSON.parse(preflightKey) as Array<{ sourceWarehouseId: string; inventoryIds: string[] }>;
    setPreflight({ key: preflightKey, items: [], checking: true, error: '' });
    void fetch('/api/transfers', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'preview', batches }), signal: controller.signal,
    }).then(async response => {
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error?.message || '无法校验所选机器');
      if (!controller.signal.aborted) setPreflight({ key: preflightKey, items: result.data?.items || [], checking: false, error: '' });
    }).catch(error => {
      if (!controller.signal.aborted) setPreflight({ key: preflightKey, items: [], checking: false, error: error instanceof Error ? error.message : '无法校验所选机器' });
    });
    return () => controller.abort();
  }, [active, createOpen, preflightKey, selected.length, transferLimitExceeded]);
  const filtered = rows.filter(row => !search || [row.transferNo, row.sourceWarehouseName, row.targetWarehouseName, row.remark, ...(row.items || []).map(item => item.sn)].some(value => value?.toLowerCase().includes(search.toLowerCase())));
  function openCreate() { setPrefillMode(false); setSource(warehouses[0]?.id || ''); setTarget(''); setRemark(''); setSelected([]); setMachines([]); setMachineSearch(''); setDirect(false); setPreflight({ key: '', items: [], checking: false, error: '' }); setCreateOpen(true); }
  function addMachinesToSelection(items: Machine[]) {
    const known = new Set(selected);
    const additions = [...new Map(items.filter(item => !known.has(item.id)).map(item => [item.id, item])).values()];
    const accepted = additions.slice(0, Math.max(0, TRANSFER_MACHINE_LIMIT - selected.length));
    setMachines(current => [...items.filter(item => !current.some(row => row.id === item.id)), ...current]);
    if (accepted.length) setSelected(current => [...new Set([...current, ...accepted.map(item => item.id)])]);
    if (accepted.length < additions.length) setToast({ message: `一次最多选择 ${TRANSFER_MACHINE_LIMIT} 台机器，超出部分未加入`, type: 'error' });
  }
  function toggleMachine(id: string) {
    if (!selected.includes(id) && selected.length >= TRANSFER_MACHINE_LIMIT) {
      setToast({ message: `一次最多选择 ${TRANSFER_MACHINE_LIMIT} 台机器`, type: 'error' });
      return;
    }
    setSelected(current => current.includes(id) ? current.filter(value => value !== id) : [...current, id]);
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving || !selected.length || !target || !selectedGroups.length || selectedGroups.some(group => !group.sourceWarehouseId || group.sourceWarehouseId === target)) return;
    if (transferLimitExceeded) { setToast({ message: `一次最多调拨 ${TRANSFER_MACHINE_LIMIT} 台机器，请移除多余机器`, type: 'error' }); return; }
    if (transferChecking || transferError || invalidMachines.length) { setToast({ message: transferError || '请先处理清单中标明原因的机器', type: 'error' }); return; }
    setSaving(true);
    try {
      const response = await fetch('/api/transfers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetWarehouseId: target, batches: selectedGroups.map(group => ({ sourceWarehouseId: group.sourceWarehouseId, inventoryIds: group.machines.map(item => item.id) })), remark, action: admin && direct ? 'complete' : undefined }) });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error?.message || '创建调拨失败');
      const transferCount = Array.isArray(result.data?.transfers) ? result.data.transfers.length : 1;
      setCreateOpen(false); setPrefillMode(false); setSelected([]); setMachines([]); setRemark(''); setTarget('');
      setToast({ message: direct ? `已完成 ${transferCount} 张调拨单，共 ${selected.length} 台机器` : `已提交 ${transferCount} 张调拨单，共 ${selected.length} 台机器`, type: 'success' });
      await load();
    } catch (error) { setToast({ message: error instanceof Error ? error.message : '提交失败', type: 'error' }); }
    finally { setSaving(false); }
  }
  async function act() { if (!confirm || saving) return; setSaving(true); try { const response = await fetch('/api/transfers', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: confirm.row.id, action: confirm.action }) }); const result = await response.json(); if (!response.ok || !result.success) throw new Error(result.error?.message || '调拨操作失败'); setConfirm(null); setDetail(null); setToast({ message: '调拨状态已更新', type: 'success' }); await load(); } catch (error) { setToast({ message: error instanceof Error ? error.message : '操作失败', type: 'error' }); } finally { setSaving(false); } }
  async function openDetail(row: Transfer) { setDetail(row); try { const response = await fetch('/api/transfers?id=' + encodeURIComponent(row.id)); const result = await response.json(); if (response.ok && result.success) { const value = Array.isArray(result.data) ? result.data.find((r: Transfer) => r.id === row.id) : result.data; if (value) setDetail(value); } } catch { /* 已有列表记录仍可查看 */ } }
  return <div className="mx-auto max-w-[1400px] space-y-5 pb-8"><header className="flex flex-wrap items-end justify-between gap-3"><div><h1 className="text-xl font-bold text-ink-deep">库存调拨</h1><p className="mt-2 text-sm text-ink-soft">{admin ? '审批调拨申请，跟踪机器在仓库之间的移动' : '选择授权仓内机器，向目标仓提交调拨申请'}</p></div><button type="button" onClick={openCreate} className="btn-primary inline-flex items-center gap-2"><Plus className="h-4 w-4" />{admin ? '新建调拨' : '申请调拨'}</button></header>
    <div className="grid gap-3 sm:grid-cols-3">{[['待审批', rows.filter(r => r.status === 'pending').length], ['调拨中', rows.filter(r => ['approved', 'in_transit'].includes(r.status)).length], ['已完成', rows.filter(r => r.status === 'completed').length]].map(([label, value]) => <div className="glass p-4" key={label}><p className="text-xs text-ink-soft">{label}</p><p className="mt-1 text-xl font-semibold text-ink-deep">{value}</p></div>)}</div>
    <section className="glass overflow-hidden"><div className="flex flex-wrap gap-3 border-b border-line/70 p-4"><MachineSearchInput value={search} onChange={setSearch} endpoint="/api/inventory/lookup?context=inventory" onSelect={item => setSearch(item.sn)} onSearch={setSearch} placeholder="搜索调拨单号、SN 后四位、仓库或备注" ariaLabel="搜索调拨记录" className="min-w-48 flex-1" /><div className="w-40"><CustomSelect value={status} onChange={setStatus} options={[{ value: 'all', label: '全部状态' }, ...Object.entries(labels).map(([value, label]) => ({ value, label }))]} /></div><button type="button" className="btn-ghost" disabled={loading} onClick={() => void load()} aria-label="刷新调拨"><RefreshCw className={'h-4 w-4 ' + (loading ? 'animate-spin' : '')} /></button></div><div className="divide-y divide-line/70">{filtered.map(row => <button type="button" key={row.id} onClick={() => void openDetail(row)} className="grid w-full gap-3 p-4 text-left transition hover:bg-white/50 sm:grid-cols-[1fr_1.2fr_auto] sm:items-center"><div><p className="font-mono text-sm font-medium text-ink-deep">{row.transferNo}</p><p className="mt-1 text-xs text-ink-soft">{row.createdAt.replace('T', ' ').slice(0, 16)} · {row.itemCount} 台</p></div><p className="flex items-center gap-2 text-sm text-ink-deep">{row.sourceWarehouseName}<ArrowRight className="h-4 w-4 text-primary" />{row.targetWarehouseName}</p><span className={'status-pill ' + (row.status === 'completed' ? 'ok' : ['pending', 'in_transit'].includes(row.status) ? 'warn' : '')}>{labels[row.status] || row.status}</span></button>)}{!filtered.length && <p className="p-14 text-center text-sm text-ink-soft">{loading ? '正在加载调拨记录...' : '暂无符合条件的调拨记录'}</p>}</div></section>
    {createOpen && <BusinessDialog title={admin ? '新建调拨' : '申请调拨'} description={prefillMode ? '已选机器按来源仓分组；每个来源仓分别生成一张调拨单。提交前会再次校验机器资格。' : '仅能调拨正式在库机器，完成后保留出入仓移动记录'} onClose={() => { if (!saving) { setCreateOpen(false); setPrefillMode(false); } }} footer={<><span className="mr-auto self-center text-xs text-ink-soft">已选择 {selected.length} / {TRANSFER_MACHINE_LIMIT} 台 · 将生成 {selectedGroups.length} 张调拨单</span><button type="button" className="btn-ghost" onClick={() => { setCreateOpen(false); setPrefillMode(false); }} disabled={saving}>取消</button><button form="transfer-create" type="submit" className="btn-primary" disabled={saving || !selected.length || transferLimitExceeded || !target || !selectedGroups.length || selectedGroups.some(group => !group.sourceWarehouseId || group.sourceWarehouseId === target) || transferChecking || !!transferError || invalidIds.length > 0}>{saving ? '提交中...' : direct && admin ? `确认并完成 ${selectedGroups.length} 张调拨单` : `提交 ${selectedGroups.length} 张申请`}</button></>}><form id="transfer-create" onSubmit={submit} className="space-y-4"><div className="grid gap-3 sm:grid-cols-2">{!prefillMode && <label className="text-xs text-ink-soft">来源仓 *<div className="mt-1.5"><CustomSelect value={source} onChange={value => { setSource(value); setSelected([]); setMachines([]); }} options={warehouses.map(w => ({ value: w.id, label: w.name }))} /></div></label>}<label className="text-xs text-ink-soft">目标仓 *<div className="mt-1.5"><CustomSelect value={target} onChange={setTarget} options={targets.filter(w => !selectedGroups.some(group => group.sourceWarehouseId === w.id)).map(w => ({ value: w.id, label: w.name }))} placeholder="选择目标仓" /></div></label></div>
      {!prefillMode && <div><label className="mb-1.5 block text-xs text-ink-soft">选择机器</label><MachineSearchInput<Machine> value={machineSearch} onChange={setMachineSearch} endpoint={"/api/inventory/lookup?context=transfer&warehouseId=" + encodeURIComponent(source)} disabled={!source} onSelect={item => { addMachinesToSelection([item]); setMachineSearch(item.sn); }} onSelectMany={items => { addMachinesToSelection(items); setMachineSearch(''); return ''; }} onSearch={setMachineSearch} scanEnabled batchEnabled placeholder="搜索 SN 或型号" ariaLabel="搜索调拨机器" /></div>}
      {transferLimitExceeded && <p role="alert" className="rounded-lg border border-danger/20 bg-danger/5 p-3 text-xs text-danger">每批最多调拨 {TRANSFER_MACHINE_LIMIT} 台，请从清单移除 {selected.length - TRANSFER_MACHINE_LIMIT} 台。</p>}
      {invalidMachines.length > 0 && <section role="alert" className="space-y-2 rounded-lg border border-warning/25 bg-warning/5 p-3"><p className="text-xs font-medium text-ink-deep">以下机器暂不可调拨</p>{invalidMachines.map(machine => <p key={machine.id} className="break-words text-xs text-ink-soft"><span className="font-mono">{machine.sn}</span> · {checksById.get(machine.id)?.reason || '校验未通过'}</p>)}</section>}
      {prefillMode && selectedGroups.length > 0 && <section className="space-y-3 rounded-xl border border-line/70 bg-white/45 p-3"><div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm font-medium text-ink-deep">机器与来源仓</p><p className="text-xs text-ink-soft">{transferChecking ? '正在核对…' : invalidIds.length ? `${invalidIds.length} 台需要处理` : '所选机器均可调拨'}</p></div>{transferError && <p role="alert" className="rounded-lg bg-danger/5 p-2.5 text-xs text-danger">{transferError}</p>}{selectedGroups.some(group => !group.sourceWarehouseId) && <p role="alert" className="rounded-lg bg-danger/5 p-2.5 text-xs text-danger">部分机器缺少来源仓信息，请返回库存清单重新选择。</p>}{sameAsTarget && <p role="alert" className="rounded-lg bg-warning/10 p-2.5 text-xs text-warning">目标仓与部分机器的来源仓相同，请移除这些机器或选择其他目标仓。</p>}{selectedGroups.map(group => <div key={group.sourceWarehouseId || 'missing-source'} className="rounded-lg border border-line/70 bg-white/65 p-2.5"><p className="mb-2 flex items-center justify-between gap-2 text-xs font-medium text-ink-deep"><span>{group.sourceWarehouseName}</span><span>{group.machines.length} 台 · 1 张调拨单</span></p><div className="space-y-1.5">{group.machines.map(machine => { const invalid = groupValidity[group.sourceWarehouseId]?.invalidIds.includes(machine.id); return <div key={machine.id} className={`flex min-w-0 items-center gap-2 rounded-md border px-2.5 py-2 ${invalid ? 'border-warning/30 bg-warning/5' : 'border-line/60 bg-white/70'}`}><div className="min-w-0 flex-1"><p className="truncate text-xs font-medium text-ink-deep">{formatProductName(machine)}</p><p className="mt-0.5 break-all font-mono text-[10px] text-ink-soft">{machine.sn}</p>{invalid && <p className="mt-0.5 text-[10px] text-warning">不可调拨或来源仓已变化</p>}</div><button type="button" title="从调拨清单移除" aria-label={`移除 ${machine.sn}`} className="rounded p-1 text-ink-soft transition hover:bg-white hover:text-ink-deep active:scale-95" disabled={saving} onClick={() => setSelected(current => current.filter(id => id !== machine.id))}><X className="h-3.5 w-3.5" /></button></div>; })}</div></div>)}</section>}
      {!prefillMode && (transferError || invalidIds.length > 0) && <p role="alert" className="rounded-xl bg-danger/5 p-3 text-xs text-danger">{transferError || '部分所选机器已不可调拨，请移除后再提交。'}</p>}
      {!prefillMode && <div className="max-h-60 divide-y divide-line/70 overflow-y-auto rounded-xl border border-line/80 bg-white/50">{machines.map(m => { const check = checksById.get(m.id); const invalid = Boolean(check && !check.eligible); return <label key={m.id} className={`flex cursor-pointer items-center gap-3 p-3 transition hover:bg-primary/5 ${invalid ? 'bg-warning/5' : ''}`}><input type="checkbox" className="h-4 w-4 accent-blue-600" checked={selected.includes(m.id)} onChange={() => toggleMachine(m.id)} /><span><span className="block text-sm text-ink-deep">{formatProductName(m)}</span><span className="font-mono text-xs text-ink-soft">{m.sn}</span>{invalid && <span className="mt-1 block text-[10px] text-warning">{check?.reason}</span>}</span></label>; })}{!machines.length && <p className="p-6 text-center text-xs text-ink-soft">暂无符合条件的在库机器</p>}</div>}
      {prefillMode && !selected.length && <p className="rounded-lg border border-line/70 bg-white/50 p-6 text-center text-xs text-ink-soft">没有待调拨的机器</p>}
      <label className="block text-xs text-ink-soft">调拨备注<textarea className="field mt-1.5" value={remark} onChange={e => setRemark(e.target.value)} rows={2} /></label>{admin && <label className="flex items-center gap-2 text-sm text-ink-deep"><input type="checkbox" checked={direct} onChange={e => setDirect(e.target.checked)} className="accent-blue-600" />管理员直接完成调拨</label>}</form></BusinessDialog>}
    {detail && <BusinessDialog title={detail.transferNo} description="调拨单详情" onClose={() => setDetail(null)} footer={<>{admin && detail.status === 'pending' && <><button type="button" className="btn-ghost text-danger" onClick={() => setConfirm({ row: detail, action: 'reject' })}>拒绝申请</button><button type="button" className="btn-primary" onClick={() => setConfirm({ row: detail, action: 'approve' })}>批准申请</button></>}{admin && detail.status === 'approved' && <button type="button" className="btn-ghost" onClick={() => setConfirm({ row: detail, action: 'start_transit' })}>开始调拨</button>}{admin && ['approved', 'in_transit'].includes(detail.status) && <button type="button" className="btn-primary" onClick={() => setConfirm({ row: detail, action: 'complete' })}>确认调拨完成</button>}{admin && ['pending', 'approved'].includes(detail.status) && <button type="button" className="btn-ghost text-danger" onClick={() => setConfirm({ row: detail, action: 'cancel' })}>取消调拨</button>}<button type="button" className="btn-ghost" onClick={() => setDetail(null)}>关闭</button></>}><div className="space-y-4"><div className="flex flex-wrap items-center gap-3 rounded-xl bg-primary/5 p-4 text-sm text-ink-deep"><ArrowRightLeft className="h-5 w-5 text-primary" />{detail.sourceWarehouseName}<ArrowRight className="h-4 w-4" />{detail.targetWarehouseName}<span className="status-pill ml-auto">{labels[detail.status]}</span></div><p className="text-xs text-ink-soft">创建时间 {detail.createdAt.replace('T', ' ').slice(0, 16)}<br />备注：{detail.remark || '无'}</p><h3 className="text-sm font-semibold text-ink-deep">机器明细 · {detail.itemCount} 台</h3>{detail.items?.map(item => <div key={item.id} className="rounded-xl border border-line/70 bg-white/50 p-3"><p className="font-mono text-sm text-ink-deep">{item.sn}</p>{item.model && <p className="mt-1 text-xs text-ink-soft">{formatProductName(item)}</p>}</div>)}{!detail.items?.length && <p className="text-xs text-ink-soft">没有可显示的明细</p>}</div></BusinessDialog>}
    <ConfirmDialog isOpen={!!confirm} title={actionLabels[confirm?.action || ''] || '确认调拨操作'} message={`确认对调拨单 ${confirm?.row.transferNo || ''} 执行“${actionLabels[confirm?.action || '']}”？${confirm?.action === 'complete' ? '完成后机器将进入目标仓，并记录完整移动信息。' : ''}`} confirmText={saving ? '处理中...' : '确认'} cancelText="取消" danger={['cancel', 'reject'].includes(confirm?.action || '')} onConfirm={() => void act()} onCancel={() => setConfirm(null)} />
    <Toast isOpen={!!toast} type={toast?.type || 'success'} message={toast?.message || ''} onClose={() => setToast(null)} />
  </div>;
}

export default function TransfersPage() {
  const router = useRouter();
  useEffect(() => { router.replace('/inventory?view=transfers'); }, [router]);
  return <div className="p-8 text-sm text-ink-soft">正在打开库存工作台…</div>;
}
