'use client';

import { DragEvent, KeyboardEvent, useEffect, useRef, useState } from 'react';
import { GripVertical, RotateCcw } from 'lucide-react';
import BusinessDialog from '@/components/BusinessDialog';
import {
  createDefaultInventoryTablePreferences,
  INVENTORY_TABLE_COLUMN_DEFINITIONS,
  INVENTORY_TABLE_MAX_FROZEN_COLUMNS,
  clampInventoryTableColumnWidth,
  normalizeInventoryTablePreferences,
  setInventoryTableColumnVisibility,
  type InventoryTableColumnKey,
  type InventoryTableColumnPreference,
  type InventoryTableDensity,
  type InventoryTablePreferences,
} from '@/lib/inventory-table-preferences';

const DENSITIES: Array<{ value: InventoryTableDensity; label: string }> = [
  { value: 'compact', label: '紧凑' },
  { value: 'normal', label: '适中' },
  { value: 'comfortable', label: '宽松' },
];

export default function InventoryColumnSettingsDialog({
  initialValue,
  onClose,
  onSave,
}: {
  initialValue: InventoryTablePreferences;
  onClose: () => void;
  onSave: (preferences: InventoryTablePreferences) => boolean;
}) {
  const [draft, setDraft] = useState(() => normalizeInventoryTablePreferences(initialValue));
  const [widthValues, setWidthValues] = useState<Record<InventoryTableColumnKey, string>>(() => Object.fromEntries(initialValue.columns.map((column) => [column.key, String(column.width)])) as Record<InventoryTableColumnKey, string>);
  const [draggedKey, setDraggedKey] = useState<InventoryTableColumnKey | null>(null);
  const [message, setMessage] = useState('');
  const selectAllRef = useRef<HTMLInputElement>(null);
  const visibleCount = draft.columns.filter((column) => column.visible).length;
  const frozenCount = draft.columns.filter((column) => column.visible && column.freeze !== 'none').length;

  useEffect(() => {
    setDraft(normalizeInventoryTablePreferences(initialValue));
    setWidthValues(Object.fromEntries(initialValue.columns.map((column) => [column.key, String(column.width)])) as Record<InventoryTableColumnKey, string>);
  }, [initialValue]);

  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = visibleCount > 0 && visibleCount < draft.columns.length;
  }, [visibleCount, draft.columns.length]);

  const updateColumn = (key: InventoryTableColumnKey, update: Partial<InventoryTableColumnPreference>) => {
    setDraft((current) => normalizeInventoryTablePreferences({
      ...current,
      columns: current.columns.map((column) => column.key === key ? { ...column, ...update } : column),
    }));
  };

  const reorder = (fromKey: InventoryTableColumnKey, toKey: InventoryTableColumnKey) => {
    if (fromKey === toKey) return;
    setDraft((current) => {
      const columns = [...current.columns];
      const fromIndex = columns.findIndex((column) => column.key === fromKey);
      const toIndex = columns.findIndex((column) => column.key === toKey);
      if (fromIndex < 0 || toIndex < 0) return current;
      const [moved] = columns.splice(fromIndex, 1);
      columns.splice(toIndex, 0, moved);
      return { ...current, columns };
    });
  };

  const toggleColumn = (column: InventoryTableColumnPreference) => {
    if (column.visible && visibleCount === 1) {
      setMessage('至少保留一列可见');
      return;
    }
    setMessage('');
    setDraft((current) => setInventoryTableColumnVisibility(current, column.key, !column.visible));
  };

  const setFreeze = (column: InventoryTableColumnPreference, freeze: InventoryTableColumnPreference['freeze']) => {
    if (freeze !== 'none' && column.freeze === 'none' && frozenCount >= INVENTORY_TABLE_MAX_FROZEN_COLUMNS) {
      setMessage('最多冻结 4 列');
      return;
    }
    setMessage('');
    updateColumn(column.key, { freeze });
  };

  const moveWithKeyboard = (event: KeyboardEvent<HTMLButtonElement>, key: InventoryTableColumnKey) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    const index = draft.columns.findIndex((column) => column.key === key);
    const target = event.key === 'ArrowUp' ? index - 1 : index + 1;
    const neighbor = draft.columns[target];
    if (neighbor) reorder(key, neighbor.key);
  };

  const beginDrag = (event: DragEvent<HTMLButtonElement>, key: InventoryTableColumnKey) => {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', key);
    setDraggedKey(key);
  };

  const dropOn = (event: DragEvent<HTMLTableRowElement>, key: InventoryTableColumnKey) => {
    event.preventDefault();
    const source = event.dataTransfer.getData('text/plain') as InventoryTableColumnKey;
    if (source) reorder(source, key);
    setDraggedKey(null);
  };

  const reset = () => {
    const defaults = createDefaultInventoryTablePreferences();
    setDraft(defaults);
    setWidthValues(Object.fromEntries(defaults.columns.map((column) => [column.key, String(column.width)])) as Record<InventoryTableColumnKey, string>);
    setMessage('');
  };

  return (
    <BusinessDialog
      title="库存列设置"
      description="调整库存清单列的显示、顺序、宽度、冻结位置和行间距。冻结列会完整换行显示，其他列保持紧凑。"
      size="wide"
      onClose={onClose}
      footer={<>
        <button type="button" onClick={reset} className="btn-ghost mr-auto inline-flex items-center gap-1.5"><RotateCcw className="h-4 w-4" />恢复默认</button>
        <button type="button" onClick={onClose} className="btn-ghost">取消</button>
        <button type="button" onClick={() => { if (!onSave(normalizeInventoryTablePreferences(draft))) setMessage('浏览器暂不允许保存，请检查本地存储设置后重试'); }} className="btn-primary">保存设置</button>
      </>}
    >
      <fieldset className="mb-5 flex flex-wrap items-center gap-2 border-b border-line/70 pb-4">
        <legend className="mr-2 text-xs font-medium text-ink-deep">行间距</legend>
        <div className="inline-flex rounded-lg border border-line/70 bg-white/65 p-1" role="group" aria-label="库存表格行间距">
          {DENSITIES.map((density) => <button key={density.value} type="button" aria-pressed={draft.density === density.value} onClick={() => setDraft((current) => ({ ...current, density: density.value }))} className={`rounded-md px-3 py-1.5 text-xs transition ${draft.density === density.value ? 'bg-primary text-white shadow-sm' : 'text-ink-soft hover:bg-white'}`}>{density.label}</button>)}
        </div>
      </fieldset>

      <div className="overflow-x-auto rounded-lg border border-line/70">
        <table className="w-full min-w-[800px] border-collapse text-left text-xs">
          <thead className="bg-white/75 text-ink-soft">
            <tr>
              <th className="w-14 border-b border-line/70 px-3 py-3 text-center">
                <input ref={selectAllRef} type="checkbox" checked={visibleCount === draft.columns.length} onChange={(event) => { setDraft((current) => normalizeInventoryTablePreferences({ ...current, columns: current.columns.map((column, index) => ({ ...column, visible: event.target.checked || index === 0 })) })); setMessage(event.target.checked ? '' : '至少保留一列可见'); }} aria-label="显示全部列" title="显示全部列" />
              </th>
              <th className="border-b border-line/70 px-3 py-3 font-medium">列标题</th>
              <th className="w-40 border-b border-line/70 px-3 py-3 font-medium">列宽（像素）</th>
              <th className="w-[330px] border-b border-line/70 px-3 py-3 font-medium">冻结列（最多 4 列）</th>
            </tr>
          </thead>
          <tbody>
            {draft.columns.map((column) => {
              const definition = INVENTORY_TABLE_COLUMN_DEFINITIONS.find((entry) => entry.key === column.key)!;
              const freezeOptions: Array<{ value: InventoryTableColumnPreference['freeze']; label: string }> = [
                { value: 'left', label: '左侧' },
                { value: 'none', label: '不设置' },
                { value: 'right', label: '右侧' },
              ];
              return <tr key={column.key} onDragOver={(event) => event.preventDefault()} onDrop={(event) => dropOn(event, column.key)} className={`border-b border-line/60 last:border-0 transition-colors hover:bg-primary/5 ${draggedKey === column.key ? 'opacity-45' : ''}`}>
                <td className="px-3 py-2 text-center"><input type="checkbox" checked={column.visible} onChange={() => toggleColumn(column)} aria-label={`显示${definition.label}列`} /></td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <button type="button" draggable onDragStart={(event) => beginDrag(event, column.key)} onDragEnd={() => setDraggedKey(null)} onKeyDown={(event) => moveWithKeyboard(event, column.key)} aria-label={`调整${definition.label}列顺序`} title="拖动排序；聚焦后按上下方向键调整" className="cursor-grab touch-none rounded p-1 text-ink-soft hover:bg-white hover:text-primary active:cursor-grabbing"><GripVertical className="h-4 w-4" /></button>
                    <span className="font-medium text-ink-deep">{definition.label}</span>
                  </div>
                </td>
                <td className="px-3 py-2"><input type="number" min={75} max={600} step={5} value={widthValues[column.key] ?? String(column.width)} onChange={(event) => setWidthValues((current) => ({ ...current, [column.key]: event.target.value }))} onBlur={() => { const parsed = Number(widthValues[column.key]); const width = widthValues[column.key]?.trim() && Number.isFinite(parsed) ? clampInventoryTableColumnWidth(parsed, definition.defaultWidth) : definition.defaultWidth; updateColumn(column.key, { width }); setWidthValues((current) => ({ ...current, [column.key]: String(width) })); }} aria-label={`${definition.label}列宽`} className="field h-9 w-full px-2.5 text-sm" /></td>
                <td className="px-3 py-2"><div className="inline-flex w-full max-w-[310px] rounded-lg border border-line/70 bg-white/65 p-0.5" role="group" aria-label={`${definition.label}冻结位置`}>{freezeOptions.map((option) => { const disabled = option.value !== 'none' && column.freeze === 'none' && frozenCount >= INVENTORY_TABLE_MAX_FROZEN_COLUMNS; return <button key={option.value} type="button" aria-pressed={column.freeze === option.value} disabled={disabled} onClick={() => setFreeze(column, option.value)} className={`flex-1 rounded-md px-2 py-1.5 text-[11px] transition ${column.freeze === option.value ? 'bg-primary text-white shadow-sm' : 'text-ink-soft hover:bg-white'} disabled:cursor-not-allowed disabled:opacity-45`}>{option.label}</button>; })}</div></td>
              </tr>;
            })}
          </tbody>
        </table>
      </div>
      <div className="mt-3 flex min-h-5 items-center justify-between gap-3 text-[11px] text-ink-soft">
        <span>{visibleCount} / {draft.columns.length} 列显示 · 已冻结 {frozenCount} 列</span>
        {message && <span role="status" className="text-warning">{message}</span>}
      </div>
    </BusinessDialog>
  );
}
