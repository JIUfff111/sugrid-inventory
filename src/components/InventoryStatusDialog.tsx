'use client';

import { useEffect, useState } from 'react';
import { Check, Pencil, Plus, Settings2 } from 'lucide-react';
import BusinessDialog from '@/components/BusinessDialog';
import ConfirmDialog from '@/components/ConfirmDialog';
import CustomSelect from '@/components/CustomSelect';
import MachineSearchInput, { type MachineSuggestion } from '@/components/MachineSearchInput';
import { useWorkspace, useWorkspaceDirty } from '@/components/WorkspaceContext';
import { useMachineEligibility } from '@/components/useMachineEligibility';
import { formatProductName } from '@/lib/product-name';

export interface InventoryStatusDefinition { id: string; name: string; color: string; allowStockOperations: number | boolean; isActive: number | boolean; }
export interface InventoryStatusRecord {
  id: string; reason: string; location: string; responsiblePerson: string; expectedReturnDate?: string | null;
  remark?: string | null; createdAt?: string; startedAt?: string; resultNote?: string | null;
}
export interface StatusMachine extends MachineSuggestion {
  status: string; currentStatusRecordId?: string | null; customStatusName?: string | null;
  customStatusColor?: string | null; statusRecord?: InventoryStatusRecord | null;
}
const EMPTY_DEFINITION = { name: '', color: '#3b82f6', allowStockOperations: false };

export default function InventoryStatusDialog({ mode, machine, onClose, onChanged }: {
  mode: 'register' | 'restore' | 'manage'; machine?: StatusMachine; onClose: () => void; onChanged: () => void;
}) {
  const { user } = useWorkspace();
  const [definitions, setDefinitions] = useState<InventoryStatusDefinition[]>([]);
  const [selectedMachine, setSelectedMachine] = useState<StatusMachine | null>(machine || null);
  const [query, setQuery] = useState(machine?.sn || '');
  const [definitionId, setDefinitionId] = useState('');
  const [form, setForm] = useState({ reason: '', location: '', responsiblePerson: user?.realName || user?.username || '', expectedReturnDate: '', remark: '' });
  const [resultNote, setResultNote] = useState('');
  const [editingId, setEditingId] = useState('');
  const [definition, setDefinition] = useState(EMPTY_DEFINITION);
  const [definitionBaseline, setDefinitionBaseline] = useState(EMPTY_DEFINITION);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState<'restore' | 'discard' | InventoryStatusDefinition | null>(null);
  const [reload, setReload] = useState(0);
  const validity = useMachineEligibility(mode === 'register' && selectedMachine ? [selectedMachine] : [], 'status-register');
  const dirty = mode === 'manage' ? JSON.stringify(definition) !== JSON.stringify(definitionBaseline)
    : mode === 'restore' ? !!resultNote.trim() : !!(definitionId || form.reason || form.location || form.expectedReturnDate || form.remark || (!machine && selectedMachine));
  useWorkspaceDirty(dirty);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/inventory/status-definitions', { cache: 'no-store' }).then(async response => {
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error?.message || '加载库存状态失败');
      if (!cancelled) setDefinitions(payload.data?.items || []);
    }).catch(e => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [reload]);

  const requestClose = () => { if (busy) return; if (dirty) setConfirm('discard'); else onClose(); };
  async function request(endpoint: string, method: string, body: object) {
    const response = await fetch(endpoint, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const payload = await response.json();
    if (!response.ok || !payload.success) throw new Error(payload.error?.message || '操作失败，请重试');
    return payload.data;
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
    if (!selectedMachine) return;
    setBusy(true); setError(''); setConfirm(null);
    try {
      await request('/api/inventory/status-records', mode === 'restore' ? 'PATCH' : 'POST', mode === 'restore'
        ? { inventoryId: selectedMachine.id, id: selectedMachine.currentStatusRecordId, action: 'restore', resultNote }
        : { inventoryId: selectedMachine.id, definitionId, ...form });
      onChanged(); onClose();
    } catch (e) { setError(e instanceof Error ? e.message : '保存库存状态失败'); } finally { setBusy(false); }
  }
  const chosenDefinition = definitions.find(item => item.id === definitionId);
  const title = mode === 'manage' ? '库存状态管理' : mode === 'restore' ? '恢复在库' : '登记机器状态';
  return <>
    <BusinessDialog title={title} description={mode === 'manage' ? '配置维修、外部保管等状态；登记和结束过程都会保留记录' : '状态登记保留原仓库、成本和 SN'} onClose={requestClose} footer={<>
      <button type="button" className="btn-ghost" onClick={requestClose} disabled={busy}>关闭</button>
      {mode === 'manage' ? <button type="button" className="btn-primary inline-flex items-center gap-1.5" disabled={busy || !definition.name.trim()} onClick={() => void saveDefinition()}><Check className="h-4 w-4" />{busy ? '保存中…' : editingId ? '保存修改' : '添加状态'}</button>
        : <button type="button" className="btn-primary" disabled={busy || !selectedMachine || validity.checking || !!validity.error || validity.invalidIds.length > 0 || (mode === 'restore' ? !resultNote.trim() : !definitionId)} onClick={() => mode === 'restore' ? setConfirm('restore') : void submit()}>{busy ? '保存中…' : mode === 'restore' ? '确认恢复在库' : '确认登记'}</button>}
    </>}>
      {error && <p role="alert" className="mb-4 rounded-lg border border-danger/20 bg-danger/5 p-3 text-sm text-danger">{error}</p>}
      {(validity.error || validity.invalidIds.length > 0) && <p role="alert" className="mb-4 rounded-lg border border-danger/20 bg-danger/5 p-3 text-sm text-danger">{validity.error || '所选机器状态已变化或已被调拨占用，请重新选择机器。未提交内容已保留。'}</p>}
      {mode === 'manage' ? <div className="space-y-5">
        <div className="space-y-2">{definitions.length === 0 && <p className="rounded-xl bg-white/60 p-4 text-sm text-ink-soft">先创建一个状态，例如维修中或外部保管。</p>}{definitions.map(item => <div key={item.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line/70 bg-white/65 p-3">
          <div className="min-w-0"><p className="flex items-center gap-2 text-sm font-medium"><span className="h-2.5 w-2.5 rounded-full" style={{ background: item.color }} />{item.name}{!item.isActive && <span className="text-xs text-ink-soft">已停用</span>}</p><p className="mt-1 text-xs text-ink-soft">{item.allowStockOperations ? '允许销售、租赁、调拨和供应商退货' : '暂停销售、租赁、调拨和供应商退货'}</p></div>
          <div className="flex gap-2"><button type="button" className="btn-ghost inline-flex items-center gap-1" disabled={busy} onClick={() => { const value = { name: item.name, color: item.color, allowStockOperations: !!item.allowStockOperations }; setEditingId(item.id); setDefinition(value); setDefinitionBaseline(value); }}><Pencil className="h-3.5 w-3.5" />编辑</button><button type="button" className="btn-ghost" disabled={busy} onClick={() => setConfirm(item)}>{item.isActive ? '停用' : '启用'}</button></div>
        </div>)}</div>
        <section className="rounded-xl border border-line/70 p-4"><div className="mb-3 flex items-center justify-between"><h3 className="flex items-center gap-2 text-sm font-medium"><Settings2 className="h-4 w-4 text-primary" />{editingId ? '编辑状态' : '新建状态'}</h3>{editingId && <button type="button" className="btn-ghost inline-flex items-center gap-1" onClick={() => { setEditingId(''); setDefinition(EMPTY_DEFINITION); setDefinitionBaseline(EMPTY_DEFINITION); }}><Plus className="h-3.5 w-3.5" />新建</button>}</div>
          <div className="grid gap-3 sm:grid-cols-[1fr_auto]"><label className="text-xs text-ink-soft">状态名称 *<input className="field mt-1.5" aria-label="状态名称" value={definition.name} maxLength={30} onChange={e => setDefinition(v => ({ ...v, name: e.target.value }))} placeholder="例如：维修中" /></label><label className="text-xs text-ink-soft">标识颜色<input type="color" aria-label="状态颜色" className="mt-1.5 block h-[40px] w-16 cursor-pointer rounded-lg border border-line bg-white p-1" value={definition.color} onChange={e => setDefinition(v => ({ ...v, color: e.target.value }))} /></label></div>
          <label className="mt-4 flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={definition.allowStockOperations} onChange={e => setDefinition(v => ({ ...v, allowStockOperations: e.target.checked }))} /><span>允许参与在库业务<span className="mt-1 block text-xs text-ink-soft">开启后可销售、租赁、调拨、供应商退货及换机出库，保存后立即生效。</span></span></label>
        </section>
      </div> : <div className="space-y-4">
        {!machine && <label className="block text-xs text-ink-soft">选择机器 *<div className="mt-1.5"><MachineSearchInput<StatusMachine> value={query} onChange={value => { setQuery(value); setSelectedMachine(null); }} endpoint="/api/inventory/lookup?context=status-register" onSelect={item => { setSelectedMachine(item); setQuery(item.sn); }} placeholder="输入 SN 后四位或品牌型号" /></div></label>}
        {selectedMachine && <div className="rounded-xl border border-primary/15 bg-primary/5 p-3"><p className="text-sm font-medium">{formatProductName(selectedMachine)}</p><p className="mt-1 font-mono text-xs">SN {selectedMachine.sn}</p><p className="mt-1 text-xs text-ink-soft">{selectedMachine.warehouseName || '原仓库'}{selectedMachine.customStatusName ? ` · ${selectedMachine.customStatusName}` : ''}</p></div>}
        {mode === 'restore' ? <><p className="text-sm text-ink-soft">结束当前登记，机器恢复普通在库。此前的状态和处理信息保留在机器生命周期中。</p><label className="block text-xs text-ink-soft">处理结果 *<textarea aria-label="处理结果" className="field mt-1.5" rows={3} value={resultNote} onChange={e => setResultNote(e.target.value)} placeholder="例如：维修完成，已收回总仓" /></label></> : <>
          <label className="block text-xs text-ink-soft">机器状态 *<div className="mt-1.5"><CustomSelect value={definitionId} onChange={setDefinitionId} options={definitions.filter(item => item.isActive).map(item => ({ value: item.id, label: item.name }))} placeholder="请选择状态" /></div></label>
          {definitions.length === 0 && <p className="text-xs text-ink-soft">请先在库存工具栏的“状态管理”中创建状态。</p>}
          {chosenDefinition && <p className="rounded-lg bg-white/65 p-2 text-xs text-ink-soft">{chosenDefinition.allowStockOperations ? '此状态允许参与在库业务，业务完成后自动结束登记。' : '登记后暂停参与销售、租赁、调拨和供应商退货。'}</p>}
          <div className="grid gap-3 sm:grid-cols-2">{(['reason', 'location', 'responsiblePerson', 'expectedReturnDate'] as const).map(key => <label className="block text-xs text-ink-soft" key={key}>{({ reason: '登记原因', location: '当前地点', responsiblePerson: '负责人', expectedReturnDate: '预计归还日' })[key]}<input className="field mt-1.5" aria-label={key === 'reason' ? '登记原因' : key === 'location' ? '当前地点' : key === 'responsiblePerson' ? '负责人' : '预计归还日'} type={key === 'expectedReturnDate' ? 'date' : 'text'} value={form[key]} onChange={e => setForm(v => ({ ...v, [key]: e.target.value }))} /></label>)}</div>
          <label className="block text-xs text-ink-soft">备注<textarea className="field mt-1.5" rows={3} value={form.remark} onChange={e => setForm(v => ({ ...v, remark: e.target.value }))} /></label>
        </>}
      </div>}
    </BusinessDialog>
    <ConfirmDialog isOpen={!!confirm} title={confirm === 'restore' ? '确认恢复在库' : confirm === 'discard' ? '放弃未保存的内容？' : `${typeof confirm === 'object' && confirm?.isActive ? '停用' : '启用'}库存状态`} message={confirm === 'restore' ? '确认机器已完成处理，可以恢复普通在库？' : confirm === 'discard' ? '关闭后，本次未保存的内容将被清除。' : '此操作不会删除既有状态登记和机器历史。'} confirmText={confirm === 'discard' ? '关闭并放弃' : '确认'} cancelText={confirm === 'discard' ? '继续编辑' : '取消'} onCancel={() => setConfirm(null)} onConfirm={() => { if (confirm === 'discard') onClose(); else if (confirm === 'restore') void submit(); else if (confirm) void toggleDefinition(confirm); }} />
  </>;
}
