'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, Download, FileSpreadsheet, Pencil, Pin, Plus, Search, Settings2, X } from 'lucide-react';
import BusinessDialog from '@/components/BusinessDialog';
import ConfirmDialog from '@/components/ConfirmDialog';
import CustomSelect from '@/components/CustomSelect';
import MachineSearchInput, { type MachineSuggestion } from '@/components/MachineSearchInput';
import { useWorkspace, useWorkspaceDirty } from '@/components/WorkspaceContext';
import { useMachineEligibility } from '@/components/useMachineEligibility';
import { formatProductName } from '@/lib/product-name';
import { parseMachineSNCsv } from '@/lib/machine-scan';

export interface InventoryStatusDefinition { id: string; name: string; color: string; allowStockOperations: number | boolean; isActive: number | boolean; machineCount?: number; }
export interface InventoryStatusRecord {
  id: string; reason: string; location: string; responsiblePerson: string; expectedReturnDate?: string | null;
  remark?: string | null; createdAt?: string; startedAt?: string; resultNote?: string | null;
}
export interface StatusMachine extends MachineSuggestion {
  status: string; currentStatusRecordId?: string | null; customStatusName?: string | null;
  customStatusColor?: string | null; statusRecord?: InventoryStatusRecord | null;
}
type BlockedMachine = { id: string; sn?: string; reason: string };
type ResolvedMachine = Pick<StatusMachine, 'id' | 'sn' | 'brand' | 'model' | 'year' | 'warehouseId' | 'warehouseName' | 'status'>;
type CsvPreview = { machines: ResolvedMachine[]; issues: BlockedMachine[]; duplicates: string[] };
const EMPTY_DEFINITION = { name: '', color: '#3b82f6', allowStockOperations: false };

export default function InventoryStatusDialog({ mode, machine, machines, pinnedStatusIds = [], onTogglePin, onClose, onChanged }: {
  mode: 'register' | 'restore' | 'manage'; machine?: StatusMachine; machines?: StatusMachine[];
  pinnedStatusIds?: string[]; onTogglePin?: (id: string) => void;
  onClose: () => void; onChanged: (inventoryIds?: string[]) => void;
}) {
  const { user } = useWorkspace();
  const initialMachines = machines?.length ? machines : machine ? [machine] : [];
  const [definitions, setDefinitions] = useState<InventoryStatusDefinition[]>([]);
  const [statusSearch, setStatusSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive'>('all');
  const selectedMachine = machine || null;
  const [selectedMachines, setSelectedMachines] = useState<ResolvedMachine[]>(initialMachines);
  const selectedMachinesRef = useRef<ResolvedMachine[]>(initialMachines);
  const [machineQuery, setMachineQuery] = useState('');
  const [machineIssues, setMachineIssues] = useState<BlockedMachine[]>([]);
  const [csvPreview, setCsvPreview] = useState<CsvPreview | null>(null);
  const csvInput = useRef<HTMLInputElement>(null);
  const [eligible, setEligible] = useState<ResolvedMachine[]>([]);
  const [blocked, setBlocked] = useState<BlockedMachine[]>([]);
  const [previewKey, setPreviewKey] = useState('');
  const [previewRevision, setPreviewRevision] = useState(0);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [selectionTouched, setSelectionTouched] = useState(false);
  const [definitionId, setDefinitionId] = useState('');
  const [form, setForm] = useState({ reason: '', location: '', responsiblePerson: user?.realName || user?.username || '', expectedReturnDate: '', remark: '' });
  const [resultNote, setResultNote] = useState('');
  const [editingId, setEditingId] = useState('');
  const [definition, setDefinition] = useState(EMPTY_DEFINITION);
  const [definitionBaseline, setDefinitionBaseline] = useState(EMPTY_DEFINITION);
  const [busy, setBusy] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState<'register' | 'restore' | 'discard' | InventoryStatusDefinition | null>(null);
  const [reload, setReload] = useState(0);
  const idsKey = JSON.stringify(selectedMachines.map(item => item.id));
  const defaultResponsiblePerson = user?.realName || user?.username || '';
  const validity = useMachineEligibility(mode === 'restore' && selectedMachine ? [selectedMachine] : [], 'status-register');
  const dirty = mode === 'manage' ? JSON.stringify(definition) !== JSON.stringify(definitionBaseline)
    : mode === 'restore' ? !!resultNote.trim()
      : selectionTouched || Boolean(definitionId || form.reason || form.location || form.expectedReturnDate || form.remark || form.responsiblePerson !== defaultResponsiblePerson);
  const currentEligible = previewKey === idsKey ? eligible : [];
  const currentBlocked = previewKey === idsKey ? blocked : [];
  const filteredDefinitions = definitions.filter(item => {
    const matchesSearch = item.name.toLocaleLowerCase().includes(statusSearch.trim().toLocaleLowerCase());
    const isActive = item.isActive === true || item.isActive === 1;
    return matchesSearch && (statusFilter === 'all' || (statusFilter === 'active' ? isActive : !isActive));
  });
  useWorkspaceDirty(dirty);

  useEffect(() => { selectedMachinesRef.current = selectedMachines; }, [selectedMachines]);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/inventory/status-definitions', { cache: 'no-store' }).then(async response => {
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error?.message || '加载库存状态失败');
      if (!cancelled) setDefinitions(payload.data?.items || []);
    }).catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : '加载库存状态失败'); });
    return () => { cancelled = true; };
  }, [reload]);

  useEffect(() => {
    if (mode !== 'register') return;
    const ids = JSON.parse(idsKey) as string[];
    if (!ids.length) {
      setEligible([]); setBlocked([]); setPreviewKey(idsKey); setPreviewing(false); setPreviewError('');
      return;
    }
    const controller = new AbortController();
    setEligible([]); setBlocked([]); setPreviewKey(''); setPreviewing(true); setPreviewError('');
    fetch('/api/inventory/status-records/batch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'preview', inventoryIds: ids }), signal: controller.signal,
    }).then(async response => {
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error?.message || '机器预检失败');
      if (!controller.signal.aborted) {
        setEligible(payload.data?.eligible || []); setBlocked(payload.data?.blocked || []); setPreviewKey(idsKey);
      }
    }).catch(e => { if (!controller.signal.aborted) setPreviewError(e instanceof Error ? e.message : '机器预检失败'); })
      .finally(() => { if (!controller.signal.aborted) setPreviewing(false); });
    return () => controller.abort();
  }, [idsKey, mode, previewRevision]);

  const requestClose = () => { if (busy || importBusy) return; if (dirty) setConfirm('discard'); else onClose(); };
  async function request(endpoint: string, method: string, body: object) {
    const response = await fetch(endpoint, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const payload = await response.json();
    if (!response.ok || !payload.success) throw new Error(payload.error?.message || '操作失败，请重试');
    return payload.data;
  }

  function addMachines(items: ResolvedMachine[], reportDuplicates = true) {
    const next = [...selectedMachinesRef.current];
    const seen = new Set(next.map(item => item.id));
    const duplicates: string[] = [];
    for (const item of items) {
      if (seen.has(item.id)) duplicates.push(item.sn);
      else { seen.add(item.id); next.push(item); }
    }
    selectedMachinesRef.current = next;
    setSelectedMachines(next);
    setSelectionTouched(true);
    if (reportDuplicates && duplicates.length) setMachineIssues(current => [...current, ...duplicates.map(sn => ({ id: sn, sn, reason: '已在待登记清单中，重复项已忽略' }))].slice(-20));
    return items.length - duplicates.length;
  }

  function removeMachine(id: string) {
    const next = selectedMachinesRef.current.filter(item => item.id !== id);
    selectedMachinesRef.current = next; setSelectedMachines(next); setSelectionTouched(true);
  }

  async function resolveSerials(serials: string[]) {
    const result = await request('/api/inventory/status-records/batch', 'POST', { action: 'resolve', serials });
    return result as { eligible: ResolvedMachine[]; blocked: BlockedMachine[] };
  }

  async function addScannedSerials(serials: string[]) {
    try {
      const result = await resolveSerials(serials);
      const known = new Set(selectedMachinesRef.current.map(item => item.id));
      const duplicates: string[] = [];
      for (const item of result.eligible) {
        if (known.has(item.id)) duplicates.push(item.sn);
        else known.add(item.id);
      }
      addMachines(result.eligible, false);
      const resolved = new Set(result.eligible.map(item => item.sn.toLocaleLowerCase()));
      setMachineIssues(current => [
        ...current.filter(item => !resolved.has((item.sn || '').toLocaleLowerCase())),
        ...duplicates.map(sn => ({ id: sn, sn, reason: '已在待登记清单中，重复项已忽略' })),
        ...result.blocked,
      ].slice(-20));
    } catch (error) {
      setMachineIssues(current => [...current, ...serials.map(sn => ({ id: sn, sn, reason: error instanceof Error ? error.message : '无法识别该 SN' }))].slice(-20));
    }
  }

  async function previewCsv(file: File) {
    setImportBusy(true); setError(''); setCsvPreview(null);
    try {
      if (file.size > 1024 * 1024) throw new Error('CSV 文件不能超过 1 MB');
      const parsed = parseMachineSNCsv(await file.text());
      const result = await resolveSerials(parsed.serials);
      setCsvPreview({ machines: result.eligible, issues: result.blocked, duplicates: parsed.duplicates });
    } catch (e) { setError(e instanceof Error ? e.message : 'CSV 文件读取失败'); }
    finally { setImportBusy(false); if (csvInput.current) csvInput.current.value = ''; }
  }

  function downloadTemplate() {
    const blob = new Blob(['\ufeffSN\r\n'], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = '库存机器SN登记模板.csv'; anchor.click();
    URL.revokeObjectURL(url);
  }

  async function saveDefinition() {
    setBusy(true); setError('');
    try {
      await request('/api/inventory/status-definitions', editingId ? 'PATCH' : 'POST', { ...(editingId ? { id: editingId } : {}), ...definition });
      setEditingId(''); setDefinition(EMPTY_DEFINITION); setDefinitionBaseline(EMPTY_DEFINITION); setReload(n => n + 1); onChanged();
    } catch (e) { setError(e instanceof Error ? e.message : '保存状态失败'); } finally { setBusy(false); }
  }

  async function toggleDefinition(item: InventoryStatusDefinition) {
    setBusy(true); setError(''); setConfirm(null);
    try { await request('/api/inventory/status-definitions', 'PATCH', { id: item.id, isActive: !item.isActive }); setReload(n => n + 1); onChanged(); }
    catch (e) { setError(e instanceof Error ? e.message : '更新状态失败'); } finally { setBusy(false); }
  }

  async function submit() {
    if (mode === 'register') {
      if (!definitionId || currentEligible.length === 0 || previewing || previewKey !== idsKey) return;
      setBusy(true); setError(''); setConfirm(null);
      try {
        const result = await request('/api/inventory/status-records/batch', 'POST', {
          action: 'register', inventoryIds: currentEligible.map(item => item.id), definitionId, ...form,
        });
        onChanged(result.inventoryIds || currentEligible.map(item => item.id)); onClose();
      } catch (e) {
        setError(e instanceof Error ? e.message : '批量登记失败');
        setPreviewRevision(value => value + 1);
      } finally { setBusy(false); }
      return;
    }
    if (!selectedMachine) return;
    setBusy(true); setError(''); setConfirm(null);
    try {
      await request('/api/inventory/status-records', 'PATCH', { inventoryId: selectedMachine.id, id: selectedMachine.currentStatusRecordId, action: 'restore', resultNote });
      onChanged(); onClose();
    } catch (e) { setError(e instanceof Error ? e.message : '保存库存状态失败'); } finally { setBusy(false); }
  }

  const chosenDefinition = definitions.find(item => item.id === definitionId && item.isActive);
  const title = mode === 'manage' ? '库存状态管理' : mode === 'restore' ? '恢复在库' : '登记机器状态';
  return <>
    <BusinessDialog title={title} description={mode === 'manage' ? '配置维修、外部保管等状态；登记和结束过程都会保留记录' : mode === 'restore' ? '结束当前状态登记并保留机器历史' : '手动选择、扫描或导入 SN，统一核对后登记；每台机器分别留存记录'} onClose={requestClose} footer={<>
      <button type="button" className="btn-ghost" onClick={requestClose} disabled={busy || importBusy}>关闭</button>
      {mode === 'manage' ? <button type="button" className="btn-primary inline-flex items-center gap-1.5" disabled={busy || !definition.name.trim()} onClick={() => void saveDefinition()}><Check className="h-4 w-4" />{busy ? '保存中…' : editingId ? '保存修改' : '添加状态'}</button>
        : mode === 'restore' ? <button type="button" className="btn-primary" disabled={busy || !selectedMachine || validity.checking || !!validity.error || validity.invalidIds.length > 0 || !resultNote.trim()} onClick={() => setConfirm('restore')}>{busy ? '保存中…' : '确认恢复在库'}</button>
          : <button type="button" className="btn-primary" disabled={busy || importBusy || previewing || previewKey !== idsKey || !chosenDefinition || currentEligible.length === 0 || selectedMachines.length > 100} onClick={() => setConfirm('register')}>{busy ? '登记中…' : `确认登记 ${currentEligible.length} 台`}</button>}
    </>}>
      {error && <p role="alert" className="mb-4 rounded-lg border border-danger/20 bg-danger/5 p-3 text-sm text-danger">{error}</p>}
      {mode === 'restore' && (validity.error || validity.invalidIds.length > 0) && <p role="alert" className="mb-4 rounded-lg border border-danger/20 bg-danger/5 p-3 text-sm text-danger">{validity.error || '所选机器状态已变化或已被调拨占用，请重新选择机器。未提交内容已保留。'}</p>}
      {mode === 'manage' ? <div className="space-y-5">
        <section className="space-y-3 rounded-xl border border-line/70 bg-white/45 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs text-ink-soft">显示在状态栏的快捷状态：{pinnedStatusIds.length}/4</p><span className="text-[11px] text-ink-soft">停用状态仍保留机器记录</span></div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[180px] flex-1"><Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-soft" aria-hidden="true" /><input className="field h-9 pl-8 text-xs" aria-label="搜索状态名称" placeholder="搜索状态名称" value={statusSearch} onChange={event => setStatusSearch(event.target.value)} /></div>
            <div className="flex items-center gap-1 rounded-lg border border-line/70 bg-white p-1" role="group" aria-label="按状态启用情况筛选"><button type="button" aria-pressed={statusFilter === 'all'} className={`rounded-md px-2.5 py-1.5 text-[11px] ${statusFilter === 'all' ? 'bg-primary text-white' : 'text-ink-soft hover:bg-primary/5'}`} onClick={() => setStatusFilter('all')}>全部 {definitions.length}</button><button type="button" aria-pressed={statusFilter === 'active'} className={`rounded-md px-2.5 py-1.5 text-[11px] ${statusFilter === 'active' ? 'bg-primary text-white' : 'text-ink-soft hover:bg-primary/5'}`} onClick={() => setStatusFilter('active')}>启用 {definitions.filter(item => item.isActive === true || item.isActive === 1).length}</button><button type="button" aria-pressed={statusFilter === 'inactive'} className={`rounded-md px-2.5 py-1.5 text-[11px] ${statusFilter === 'inactive' ? 'bg-primary text-white' : 'text-ink-soft hover:bg-primary/5'}`} onClick={() => setStatusFilter('inactive')}>停用 {definitions.filter(item => item.isActive !== true && item.isActive !== 1).length}</button></div>
          </div>
          <div className="max-h-72 space-y-2 overflow-y-auto pr-1">{definitions.length === 0 && <p className="rounded-xl bg-white/60 p-4 text-sm text-ink-soft">先创建一个状态，例如维修中或外部保管。</p>}{filteredDefinitions.map(item => {
            const isActive = item.isActive === true || item.isActive === 1;
            const isPinned = pinnedStatusIds.includes(item.id);
            const pinLimitReached = pinnedStatusIds.length >= 4;
            return <div key={item.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line/70 bg-white/65 p-3">
              <div className="min-w-0"><p className="flex items-center gap-2 text-sm font-medium"><span className="h-2.5 w-2.5 rounded-full" style={{ background: item.color }} />{item.name}{!isActive && <span className="text-xs text-ink-soft">已停用</span>}</p><p className="mt-1 text-xs text-ink-soft">{item.allowStockOperations ? '允许销售、租赁、调拨和供应商退货' : '暂停销售、租赁、调拨和供应商退货'} · {Number(item.machineCount || 0)} 台机器</p></div>
              <div className="flex flex-wrap items-center gap-1.5"><button type="button" className="btn-ghost inline-flex items-center gap-1" aria-pressed={isPinned} aria-label={isPinned ? `从状态栏移除 ${item.name}` : `显示 ${item.name} 在状态栏`} title={!isPinned && pinLimitReached ? '状态栏最多显示 4 个自定义状态' : undefined} disabled={busy || !onTogglePin || (!isPinned && (!isActive || pinLimitReached))} onClick={() => onTogglePin?.(item.id)}><Pin className="h-3.5 w-3.5" />{isPinned ? '已置顶' : '显示在状态栏'}</button><button type="button" className="btn-ghost inline-flex items-center gap-1" disabled={busy} onClick={() => { const value = { name: item.name, color: item.color, allowStockOperations: !!item.allowStockOperations }; setEditingId(item.id); setDefinition(value); setDefinitionBaseline(value); }}><Pencil className="h-3.5 w-3.5" />编辑</button><button type="button" className="btn-ghost" disabled={busy} onClick={() => setConfirm(item)}>{isActive ? '停用' : '启用'}</button></div>
            </div>;
          })}{definitions.length > 0 && filteredDefinitions.length === 0 && <p className="rounded-xl bg-white/60 p-5 text-center text-sm text-ink-soft">没有匹配的库存状态</p>}</div>
        </section>
        <section className="rounded-xl border border-line/70 p-4"><div className="mb-3 flex items-center justify-between"><h3 className="flex items-center gap-2 text-sm font-medium"><Settings2 className="h-4 w-4 text-primary" />{editingId ? '编辑状态' : '新建状态'}</h3>{editingId && <button type="button" className="btn-ghost inline-flex items-center gap-1" onClick={() => { setEditingId(''); setDefinition(EMPTY_DEFINITION); setDefinitionBaseline(EMPTY_DEFINITION); }}><Plus className="h-3.5 w-3.5" />新建</button>}</div>
          <div className="grid gap-3 sm:grid-cols-[1fr_auto]"><label className="text-xs text-ink-soft">状态名称 *<input className="field mt-1.5" aria-label="状态名称" value={definition.name} maxLength={30} onChange={e => setDefinition(v => ({ ...v, name: e.target.value }))} placeholder="例如：维修中" /></label><label className="text-xs text-ink-soft">标识颜色<input type="color" aria-label="状态颜色" className="mt-1.5 block h-[40px] w-16 cursor-pointer rounded-lg border border-line bg-white p-1" value={definition.color} onChange={e => setDefinition(v => ({ ...v, color: e.target.value }))} /></label></div>
          <label className="mt-4 flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={definition.allowStockOperations} onChange={e => setDefinition(v => ({ ...v, allowStockOperations: e.target.checked }))} /><span>允许参与在库业务<span className="mt-1 block text-xs text-ink-soft">开启后可销售、租赁、调拨、供应商退货及换机出库，保存后立即生效。</span></span></label>
        </section>
      </div> : mode === 'restore' ? <div className="space-y-4">
        {selectedMachine && <div className="rounded-xl border border-primary/15 bg-primary/5 p-3"><p className="text-sm font-medium">{formatProductName(selectedMachine)}</p><p className="mt-1 break-all font-mono text-xs">SN {selectedMachine.sn}</p><p className="mt-1 text-xs text-ink-soft">{selectedMachine.warehouseName || '原仓库'}{selectedMachine.customStatusName ? ` · ${selectedMachine.customStatusName}` : ''}</p></div>}
        <p className="text-sm text-ink-soft">结束当前登记，机器恢复普通在库。此前的状态和处理信息保留在机器生命周期中。</p>
        <label className="block text-xs text-ink-soft">处理结果 *<textarea aria-label="处理结果" className="field mt-1.5" rows={3} value={resultNote} onChange={e => setResultNote(e.target.value)} placeholder="例如：维修完成，已收回总仓" /></label>
      </div> : <div className="space-y-4">
        <section className="rounded-xl border border-line/70 bg-white/50 p-3">
          <div className="mb-3 flex flex-wrap gap-2">
            <button type="button" className="btn-ghost inline-flex items-center gap-1.5" onClick={downloadTemplate}><Download className="h-4 w-4" />下载 SN 模板</button>
            <button type="button" className="btn-ghost inline-flex items-center gap-1.5" onClick={() => csvInput.current?.click()} disabled={importBusy}><FileSpreadsheet className="h-4 w-4" />{importBusy ? '正在核对…' : '上传 SN 表格'}</button>
            <input ref={csvInput} type="file" accept=".csv,text/csv" className="hidden" aria-label="上传 SN CSV 模板" onChange={event => { const file = event.target.files?.[0]; if (file) void previewCsv(file); }} />
          </div>
          <label className="block text-xs text-ink-soft">选择机器<div className="mt-1.5"><MachineSearchInput<StatusMachine> value={machineQuery} onChange={setMachineQuery} endpoint="/api/inventory/lookup?context=status-register" onSelect={item => { addMachines([item]); setMachineQuery(''); }} onScanTokens={addScannedSerials} scanEnabled batchEnabled placeholder="搜索 SN 或型号" ariaLabel="选择或扫描登记机器" /></div></label>
        </section>

        {csvPreview && <section className="rounded-lg border border-primary/15 bg-primary/5 p-3" role="status">
          <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm font-medium text-ink-deep">表格预检：可加入 {csvPreview.machines.length} 台 · 不符合 {csvPreview.issues.length} 条 · 文件重复 {csvPreview.duplicates.length} 条</p>{csvPreview.machines.length > 0 && <button type="button" className="btn-secondary" disabled={selectedMachines.length + csvPreview.machines.length > 100} onClick={() => { addMachines(csvPreview.machines); setCsvPreview(null); }}>加入待登记清单</button>}</div>
          {(csvPreview.issues.length > 0 || csvPreview.duplicates.length > 0) && <ul className="mt-2 max-h-24 space-y-1 overflow-y-auto text-xs text-warning">{csvPreview.issues.slice(0, 10).map((item, index) => <li key={`${item.id}:${index}`}>{item.sn || item.id}：{item.reason}</li>)}{csvPreview.duplicates.slice(0, 10).map((sn, index) => <li key={`duplicate:${sn}:${index}`}>{sn}：文件中重复，已忽略</li>)}</ul>}
        </section>}

        {machineIssues.length > 0 && <section className="rounded-lg border border-warning/20 bg-warning/5 p-3"><div className="flex items-center justify-between gap-2"><p className="text-xs font-medium text-warning">扫描结果需要处理</p><button type="button" className="btn-ghost p-1" onClick={() => setMachineIssues([])} aria-label="清除扫描提示"><X className="h-3.5 w-3.5" /></button></div><ul className="mt-1 max-h-20 space-y-1 overflow-y-auto text-xs text-warning">{machineIssues.slice(-8).map((item, index) => <li key={`${item.id}:${index}`}>{item.sn || item.id}：{item.reason}</li>)}</ul></section>}

        <section className="rounded-xl border border-line/70 bg-white/45 p-3">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2"><p className="text-[13px] font-medium text-ink-deep">待登记机器 {selectedMachines.length} 台</p>
            {previewing ? <p role="status" className="text-xs text-ink-soft">正在核对机器状态…</p> : previewKey === idsKey && <p role="status" className={`text-xs ${currentBlocked.length ? 'text-warning' : 'text-success'}`}>可登记 {currentEligible.length} 台 · 暂不可登记 {currentBlocked.length} 台</p>}
          </div>
          {previewError && <div role="alert" className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-danger/20 bg-danger/5 p-2 text-xs text-danger"><span>{previewError}</span><button type="button" className="btn-ghost px-2 py-1" disabled={previewing} onClick={() => setPreviewRevision(value => value + 1)}>重新核对</button></div>}
          {selectedMachines.length > 100 && <p role="alert" className="mb-2 text-xs text-danger">最多登记 100 台，请移除多余机器。</p>}
          <div className="max-h-48 space-y-1.5 overflow-y-auto pr-1">
            {selectedMachines.map(item => {
              const issue = currentBlocked.find(row => row.id === item.id);
              const canRegister = currentEligible.some(row => row.id === item.id);
              return <div key={item.id} className={`flex items-center gap-2 rounded-md border px-2.5 py-2 ${issue ? 'border-warning/20 bg-warning/5' : 'border-line/60 bg-white/70'}`}>
                <div className="min-w-0 flex-1"><p className="truncate text-xs font-medium text-ink-deep">{formatProductName(item)}</p><p className="mt-0.5 break-all font-mono text-[10px] text-ink-soft">{item.sn} · {item.warehouseName || '原仓库'}</p>{(issue || canRegister) && <p className={`mt-0.5 text-[10px] ${issue ? 'text-warning' : 'text-success'}`}>{issue?.reason || '可登记'}</p>}</div>
                <button type="button" title="从待登记清单移除" aria-label={`移除 ${item.sn}`} className="rounded p-1 text-ink-soft transition hover:bg-white hover:text-ink-deep active:scale-95" onClick={() => removeMachine(item.id)}><X className="h-3.5 w-3.5" /></button>
              </div>;
            })}
            {selectedMachines.length === 0 && <p className="py-4 text-center text-xs text-ink-soft">请搜索、扫码或上传 SN 表格添加机器</p>}
          </div>
        </section>

        <label className="block text-xs text-ink-soft">机器状态 *<div className="mt-1.5"><CustomSelect value={definitionId} onChange={setDefinitionId} options={definitions.filter(item => item.isActive).map(item => ({ value: item.id, label: item.name }))} placeholder="请选择状态" /></div></label>
        {definitions.length === 0 && <p className="text-xs text-ink-soft">请先在库存工具栏的“状态管理”中创建状态。</p>}
        {chosenDefinition && <p className="rounded-lg bg-white/65 p-2 text-xs text-ink-soft">{chosenDefinition.allowStockOperations ? '此状态允许参与在库业务，业务完成后自动结束登记。' : '登记后暂停参与销售、租赁、调拨和供应商退货。'}</p>}
        <div className="grid gap-3 sm:grid-cols-2">{(['reason', 'location', 'responsiblePerson', 'expectedReturnDate'] as const).map(key => <label className="block text-xs text-ink-soft" key={key}>{({ reason: '登记原因', location: '当前地点', responsiblePerson: '负责人', expectedReturnDate: '预计归还日' })[key]}<input className="field mt-1.5" aria-label={key === 'reason' ? '登记原因' : key === 'location' ? '当前地点' : key === 'responsiblePerson' ? '负责人' : '预计归还日'} type={key === 'expectedReturnDate' ? 'date' : 'text'} value={form[key]} onChange={e => setForm(v => ({ ...v, [key]: e.target.value }))} /></label>)}</div>
        <label className="block text-xs text-ink-soft">备注<textarea className="field mt-1.5" rows={3} value={form.remark} onChange={e => setForm(v => ({ ...v, remark: e.target.value }))} /></label>
      </div>}
    </BusinessDialog>
    <ConfirmDialog isOpen={!!confirm} title={confirm === 'register' ? '确认批量登记' : confirm === 'restore' ? '确认恢复在库' : confirm === 'discard' ? '放弃未保存的内容？' : `${typeof confirm === 'object' && confirm?.isActive ? '停用' : '启用'}库存状态`} message={confirm === 'register' ? `将为 ${currentEligible.length} 台机器登记“${chosenDefinition?.name || ''}”。${currentBlocked.length ? `另有 ${currentBlocked.length} 台暂不可登记，不会修改。` : ''}提交后每台机器会分别生成状态和移动记录。` : confirm === 'restore' ? '确认机器已完成处理，可以恢复普通在库？' : confirm === 'discard' ? '关闭后，本次未保存的内容将被清除。' : '此操作不会删除既有状态登记和机器历史。'} confirmText={confirm === 'register' ? '确认登记' : confirm === 'discard' ? '关闭并放弃' : '确认'} cancelText={confirm === 'discard' ? '继续编辑' : '取消'} danger={confirm === 'discard'} onCancel={() => setConfirm(null)} onConfirm={() => { if (confirm === 'discard') onClose(); else if (confirm === 'register' || confirm === 'restore') void submit(); else if (confirm) void toggleDefinition(confirm); }} />
  </>;
}
