'use client';

import { useEffect, useMemo, useState } from 'react';
import BusinessDialog from '@/components/BusinessDialog';
import { useWorkspaceDirty } from '@/components/WorkspaceContext';
import { formatProductName } from '@/lib/product-name';

type PurgeMachine = {
  id: string;
  sn: string;
  brand: string;
  model: string;
  year: string | null;
  status: string;
  warehouseName?: string;
  purchaseNo?: string | null;
  supplierName?: string;
};

type PurgePreview = {
  candidate: { id: string; sn: string; status: string; purchaseNo: string | null; supplierName: string };
  references: Record<string, number>;
  reasons: string[];
  canDelete: boolean;
};

export default function InventoryPurgeDialog({ machine, onClose, onDeleted }: {
  machine: PurgeMachine;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [preview, setPreview] = useState<PurgePreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [password, setPassword] = useState('');
  const [confirmText, setConfirmText] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dirty = Boolean(password || confirmText || reason);
  useWorkspaceDirty(dirty);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/inventory/purge-preview?id=${encodeURIComponent(machine.id)}`, { cache: 'no-store' })
      .then(response => response.json().then(result => ({ response, result })))
      .then(({ response, result }) => {
        if (cancelled) return;
        if (!response.ok || !result.success) throw new Error(result.error?.message || '无法获取删除预览');
        setPreview(result.data as PurgePreview);
      })
      .catch(fetchError => { if (!cancelled) setError(fetchError instanceof Error ? fetchError.message : '无法获取删除预览'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [machine.id]);

  const product = useMemo(() => formatProductName(machine), [machine]);
  const canSubmit = Boolean(preview?.canDelete && confirmText.trim() === '永久删除' && password && !busy);

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`/api/inventory?id=${encodeURIComponent(machine.id)}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, confirmText: confirmText.trim(), reason: reason.trim() }),
      });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error?.message || '永久删除失败');
      onDeleted();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : '永久删除失败');
    } finally {
      setBusy(false);
    }
  };

  return <BusinessDialog
    title="永久删除库存机器"
    description="该操作不可在系统内撤销，删除前会自动备份当前数据库。"
    onClose={() => { if (!busy) onClose(); }}
    footer={<>
      <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>取消</button>
      <button type="button" className="rounded-lg bg-danger px-4 py-2 text-[13px] font-medium text-white shadow-sm transition hover:bg-danger-hover disabled:cursor-not-allowed disabled:opacity-50" onClick={() => void submit()} disabled={!canSubmit}>{busy ? '删除中...' : '永久删除'}</button>
    </>}
  >
    <div className="rounded-xl border border-danger/20 bg-danger/5 p-4 text-sm">
      <p className="font-medium text-ink-deep">{product}</p>
      <p className="mt-1 font-mono text-xs text-ink-soft">SN {machine.sn}</p>
      <p className="mt-1 text-xs text-ink-soft">仓库：{machine.warehouseName || '-'}　采购单：{machine.purchaseNo || '-'}</p>
    </div>

    {loading ? <p className="mt-4 text-sm text-ink-soft">正在检查机器关联记录...</p> : preview && (
      <div className="mt-4 space-y-3">
        {preview.canDelete ? <p className="rounded-lg bg-success/8 px-3 py-2 text-xs text-success">确认通过：机器为普通在库，未发现销售、租赁、售后、退货或调拨关联。</p> : <div className="rounded-lg bg-danger/8 px-3 py-2 text-xs text-danger"><p className="font-medium">当前不能删除</p><ul className="mt-1 list-disc space-y-1 pl-4">{preview.reasons.map(reasonItem => <li key={reasonItem}>{reasonItem}</li>)}</ul></div>}
        {preview.references.movementRecords > 0 && <p className="text-xs text-ink-soft">将清理 {preview.references.movementRecords} 条机器生命周期记录；采购单和采购明细保留。</p>}
      </div>
    )}

    {preview?.canDelete && <div className="mt-5 grid gap-4">
      <label className="block text-xs font-medium text-ink-deep">当前密码
        <input type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" className="field mt-1.5" placeholder="验证内置账号密码" />
      </label>
      <label className="block text-xs font-medium text-ink-deep">确认文字
        <span className="mt-1 block font-normal text-ink-soft">请输入：永久删除</span>
        <input type="text" value={confirmText} onChange={event => setConfirmText(event.target.value)} autoComplete="off" className="field mt-1.5" placeholder="永久删除" />
      </label>
      <label className="block text-xs font-medium text-ink-deep">删除原因（可选）
        <textarea value={reason} onChange={event => setReason(event.target.value)} maxLength={200} rows={2} className="field mt-1.5 resize-y" placeholder="例如：重复录入测试机器" />
      </label>
    </div>}
    {error && <p role="alert" className="mt-4 rounded-lg border border-danger/20 bg-danger/5 p-3 text-xs text-danger">{error}</p>}
  </BusinessDialog>;
}

