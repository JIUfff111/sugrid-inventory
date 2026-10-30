'use client';

import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useWorkspaceDirty } from '@/components/WorkspaceContext';
import { useRouter } from 'next/navigation';
import {
  Barcode,
  Copy,
  FilePlus2,
  LayoutTemplate,
  Minus,
  MousePointer2,
  MoveDown,
  MoveUp,
  Printer,
  Save,
  Star,
  Trash2,
  X,
} from 'lucide-react';
import CustomSelect from '@/components/CustomSelect';
import LabelCanvas, { labelDimensions as dimensions, labelFieldBox } from '@/components/LabelCanvas';
import { formatProductName } from '@/lib/product-name';
import { createPrintJobId } from '@/lib/print-job-id';
import { formatCPUDisplay, formatGPUDisplay } from '@/lib/sku-display';

type FieldKey = 'product' | 'config' | 'sn' | 'purchasePrice' | 'supplier' | 'inboundDate';
type LabelField = {
  key: FieldKey;
  visible: boolean;
  order: number;
  fontSize: number;
  align: 'left' | 'center' | 'right';
  x?: number;
  y?: number;
};
type LabelElementType = 'line' | 'barcode';
type LabelElementStyle = {
  stroke?: string;
  strokeWidth?: number;
  lineStyle?: 'solid' | 'dashed' | 'dotted';
  foreground?: string;
  background?: string;
  showText?: boolean;
  fontSize?: number;
};
type LabelElement = {
  id: string;
  type: LabelElementType;
  x: number;
  y: number;
  width: number;
  height: number;
  contentKey?: FieldKey;
  style: LabelElementStyle;
};
type LabelTemplate = {
  id: string;
  templateName: string;
  templateType: string;
  width: 60 | 80;
  height: 40 | 50;
  orientation: 'portrait' | 'landscape';
  fieldGap: number;
  layoutMode: 'flow' | 'free';
  fields: LabelField[];
  elements: LabelElement[];
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
};
type InventoryItem = {
  id: string;
  sn: string;
  productType: string;
  brand: string;
  model: string;
  year: number | null;
  cpu: string;
  ram: string;
  gpu: string | null;
  storage: string;
  screen: string;
  touchScreen: number | null;
  purchasePrice: number;
  supplierName: string;
  inboundDate: string;
};

const FIELD_META: Record<FieldKey, { label: string; describe: (item: InventoryItem) => string }> = {
  product: { label: '品牌型号', describe: (item) => formatProductName(item, item.productType || '商品名称') },
  config: { label: '配置摘要', describe: (item) => [formatCPUDisplay(item.cpu), item.ram, formatGPUDisplay(item.gpu), item.storage, item.screen, item.touchScreen ? '触屏' : ''].filter(Boolean).join(' · ') || '配置未补充' },
  sn: { label: 'SN / IMEI', describe: (item) => item.sn || 'SN / IMEI' },
  purchasePrice: { label: '采购价', describe: (item) => `¥${Number(item.purchasePrice || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2 })}` },
  supplier: { label: '供应商', describe: (item) => item.supplierName || '供应商' },
  inboundDate: { label: '入库日期', describe: (item) => formatDate(item.inboundDate) },
};

const FIELD_KEYS = Object.keys(FIELD_META) as FieldKey[];

function defaultFields(): LabelField[] {
  return [
    { key: 'product', visible: true, order: 0, fontSize: 14, align: 'left', x: 3, y: 4 },
    { key: 'config', visible: true, order: 1, fontSize: 13, align: 'left', x: 5, y: 22 },
    { key: 'sn', visible: false, order: 2, fontSize: 8, align: 'left', x: 4, y: 34 },
    { key: 'purchasePrice', visible: false, order: 3, fontSize: 8, align: 'left', x: 4, y: 49 },
    { key: 'supplier', visible: false, order: 4, fontSize: 8, align: 'left', x: 4, y: 64 },
    { key: 'inboundDate', visible: true, order: 5, fontSize: 12, align: 'left', x: 3, y: 82 },
  ];
}

function defaultElements(): LabelElement[] {
  return [
    { id: 'reference-divider', type: 'line', x: 2, y: 16, width: 96, height: 1, style: { stroke: '#111111', strokeWidth: 1.25, lineStyle: 'solid' } },
    { id: 'reference-barcode', type: 'barcode', x: 8, y: 42, width: 84, height: 31, contentKey: 'sn', style: { foreground: '#000000', background: '#ffffff', showText: true, fontSize: 9 } },
  ];
}

function withPositions(fields: LabelField[]): LabelField[] {
  return fields.map((field, index) => ({
    ...field,
    x: typeof field.x === 'number' ? field.x : 4,
    y: typeof field.y === 'number' ? field.y : Math.min(92, 4 + index * 15),
  }));
}

function formatDate(value: string | null | undefined) {
  if (!value) return '-';
  const parsed = new Date(value.replace(' ', 'T'));
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

function responseError(result: { error?: { message?: string } }, fallback: string) {
  return result.error?.message || fallback;
}

export default function PrintLabelsPage() {
  const router = useRouter();
  const [templates, setTemplates] = useState<LabelTemplate[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [draft, setDraft] = useState<LabelTemplate | null>(null);
  const [sample, setSample] = useState<InventoryItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [createMode, setCreateMode] = useState<'new' | 'copy' | null>(null);
  const [newName, setNewName] = useState('');
  const [deleteOpen, setDeleteOpen] = useState(false);
  const dragOffsets = useRef<Record<string, { x: number; y: number }>>({});
  const initialized = useRef(false);

  const selectedTemplate = templates.find((template) => template.id === selectedId) || null;
  useWorkspaceDirty(Boolean(draft && selectedTemplate && JSON.stringify(draft) !== JSON.stringify(selectedTemplate)) || Boolean(newName.trim()));
  const orderedFields = useMemo(() => [...(draft?.fields || [])].sort((a, b) => a.order - b.order), [draft?.fields]);
  const previewSize = draft ? dimensions(draft) : { width: 60, height: 40 };
  const previewValues = useMemo(() => Object.fromEntries(FIELD_KEYS.map((key) => [
    key, sample ? FIELD_META[key].describe(sample) : key === 'sn' ? 'SN-IMEI' : FIELD_META[key].label,
  ])) as Record<FieldKey, string>, [sample]);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      if (!initialized.current) setLoading(true);
      try {
        const [templateResponse, inventoryResponse] = await Promise.all([
          fetch('/api/label-templates', { cache: 'no-store', signal: controller.signal }),
          fetch('/api/inventory?page=1&pageSize=1&status=in_stock', { cache: 'no-store', signal: controller.signal }),
        ]);
        const [templateResult, inventoryResult] = await Promise.all([templateResponse.json(), inventoryResponse.json()]);
        if (!templateResponse.ok || !templateResult.success) throw new Error(responseError(templateResult, '加载标签模板失败'));
        if (!inventoryResponse.ok || !inventoryResult.success) throw new Error(responseError(inventoryResult, '读取库存样例失败'));
        const nextTemplates = Array.isArray(templateResult.data) ? templateResult.data as LabelTemplate[] : [];
        if (controller.signal.aborted) return;
        setTemplates(nextTemplates);
        const preferred = nextTemplates.find((template) => template.isDefault) || nextTemplates[0];
        if (preferred && !initialized.current) {
          setSelectedId(preferred.id);
          setDraft(structuredClone(preferred));
        }
        initialized.current = true;
        setSample(inventoryResult.data?.items?.[0] || null);
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setMessage(error instanceof Error ? error.message : '加载标签设计器失败');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, []);

  const chooseTemplate = (template: LabelTemplate) => {
    setSelectedId(template.id);
    setDraft(structuredClone(template));
    setMessage('');
  };

  const updateDraft = (update: Partial<LabelTemplate>) => {
    setDraft((current) => current ? { ...current, ...update } : current);
  };

  const updateField = (key: FieldKey, update: Partial<LabelField>) => {
    setDraft((current) => current ? {
      ...current,
      fields: current.fields.map((field) => field.key === key ? { ...field, ...update } : field),
    } : current);
  };

  const updateElement = (id: string, update: Partial<LabelElement>) => {
    setDraft((current) => current ? {
      ...current,
      elements: (current.elements || []).map((element) => element.id === id ? { ...element, ...update } : element),
    } : current);
  };

  const updateElementStyle = (id: string, update: Partial<LabelElementStyle>) => {
    setDraft((current) => current ? {
      ...current,
      elements: (current.elements || []).map((element) => element.id === id
        ? { ...element, style: { ...element.style, ...update } }
        : element),
    } : current);
  };

  const addElement = (type: LabelElementType) => {
    if (!draft) return;
    const id = `${type}-${Date.now()}`;
    const element: LabelElement = type === 'line'
      ? {
        id,
        type,
        x: 6,
        y: 70,
        width: 88,
        height: 1,
        style: { stroke: '#1e232c', strokeWidth: 1, lineStyle: 'solid' },
      }
      : {
        id,
        type,
        x: 8,
        y: 73,
        width: 84,
        height: 18,
        contentKey: 'sn',
        style: { foreground: '#111827', background: '#ffffff', showText: true, fontSize: 7 },
      };
    updateDraft({
      layoutMode: 'free',
      fields: draft.layoutMode === 'free' ? draft.fields : withPositions(draft.fields),
      elements: [...(draft.elements || []), element],
    });
    setMessage(type === 'line' ? '已添加直线，可在预览中拖动' : '已添加条码，可在预览中拖动');
  };

  const removeElement = (id: string) => {
    updateDraft({ elements: (draft?.elements || []).filter((element) => element.id !== id) });
  };

  const moveField = (key: FieldKey, delta: -1 | 1) => {
    if (!draft) return;
    const fields = [...orderedFields];
    const index = fields.findIndex((field) => field.key === key);
    const targetIndex = index + delta;
    if (index < 0 || targetIndex < 0 || targetIndex >= fields.length) return;
    [fields[index], fields[targetIndex]] = [fields[targetIndex], fields[index]];
    updateDraft({ fields: fields.map((field, order) => ({ ...field, order })) });
  };

  const setLayoutMode = (layoutMode: LabelTemplate['layoutMode']) => {
    if (!draft) return;
    updateDraft({
      layoutMode,
      fields: layoutMode === 'free' ? withPositions(draft.fields) : draft.fields,
    });
  };

  const updateDraggedField = (event: ReactPointerEvent<HTMLDivElement>, key: FieldKey) => {
    if (!draft || draft.layoutMode !== 'free' || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const canvas = event.currentTarget.parentElement;
    if (!canvas) return;
    const bounds = canvas.getBoundingClientRect();
    const offset = dragOffsets.current[key] || { x: 0, y: 0 };
    const field = draft.fields.find((item) => item.key === key);
    if (!field) return;
    const paperHeightPx = previewSize.height * 96 / 25.4;
    const maxY = Math.max(0, 98 - field.fontSize * 1.2 / paperHeightPx * 100);
    const x = Math.max(0, Math.min(90, ((event.clientX - bounds.left) / bounds.width) * 100 - offset.x));
    const y = Math.max(0, Math.min(maxY, ((event.clientY - bounds.top) / bounds.height) * 100 - offset.y));
    updateField(key, { x: Number(x.toFixed(2)), y: Number(y.toFixed(2)) });
  };

  const updateDraggedElement = (event: ReactPointerEvent<HTMLDivElement>, id: string) => {
    if (!draft || draft.layoutMode !== 'free' || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const canvas = event.currentTarget.parentElement;
    if (!canvas) return;
    const bounds = canvas.getBoundingClientRect();
    const element = draft.elements.find((item) => item.id === id);
    if (!element) return;
    const offset = dragOffsets.current[id] || { x: 0, y: 0 };
    const x = Math.max(0, Math.min(100 - element.width, ((event.clientX - bounds.left) / bounds.width) * 100 - offset.x));
    const y = Math.max(0, Math.min(100 - element.height, ((event.clientY - bounds.top) / bounds.height) * 100 - offset.y));
    updateElement(id, { x: Number(x.toFixed(2)), y: Number(y.toFixed(2)) });
  };

  const startDraggingElement = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!draft || draft.layoutMode !== 'free') return;
    event.preventDefault();
    const id = event.currentTarget.dataset.elementId;
    const canvas = event.currentTarget.parentElement;
    const element = id ? draft.elements.find((item) => item.id === id) : null;
    if (id && canvas && element) {
      const bounds = canvas.getBoundingClientRect();
      dragOffsets.current[id] = {
        x: ((event.clientX - bounds.left) / bounds.width) * 100 - element.x,
        y: ((event.clientY - bounds.top) / bounds.height) * 100 - element.y,
      };
    }
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const startDraggingField = (event: ReactPointerEvent<HTMLDivElement>, field: LabelField, index: number) => {
    if (!draft || draft.layoutMode !== 'free') return;
    event.preventDefault();
    const target = event.currentTarget;
    const canvas = target.parentElement;
    if (canvas) {
      const bounds = canvas.getBoundingClientRect();
      const box = labelFieldBox(field, draft);
      dragOffsets.current[field.key] = {
        x: ((event.clientX - bounds.left) / bounds.width) * 100 - box.x,
        y: ((event.clientY - bounds.top) / bounds.height) * 100 - box.y,
      };
    }
    target.setPointerCapture(event.pointerId);
    if (typeof field.x !== 'number' || typeof field.y !== 'number') {
      const position = withPositions([field])[0];
      updateField(field.key, { x: position.x, y: position.y });
    }
    if (index === 0) setMessage('拖动标签字段调整位置，保存后用于打印');
  };

  const saveDraft = async (): Promise<LabelTemplate | null> => {
    if (!draft) return null;
    setSaving(true);
    setMessage('');
    const payload: LabelTemplate = draft.layoutMode === 'free'
      ? { ...draft, fields: withPositions(draft.fields) }
      : draft;
    try {
      const response = await fetch('/api/label-templates', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(responseError(result, '保存模板失败'));
      const saved = result.data as LabelTemplate;
      setTemplates((current) => current.map((template) => template.id === saved.id ? saved : template));
      setDraft(structuredClone(saved));
      setMessage('模板已保存');
      return saved;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '保存模板失败');
      return null;
    } finally {
      setSaving(false);
    }
  };

  const saveAndPreview = async () => {
    if (!sample) {
      setMessage('当前没有在库样例，无法测试打印');
      return;
    }
    const saved = await saveDraft();
    if (!saved) return;
    const params = new URLSearchParams({ ids: sample.id, templateId: saved.id, autoPrint: '1', printJob: createPrintJobId() });
    router.push(`/settings/print/preview?${params.toString()}`);
  };

  const createTemplate = async () => {
    const name = newName.trim();
    if (!name) {
      setMessage('请填写模板名称');
      return;
    }
    const source = createMode === 'copy' && draft ? draft : null;
    const payload = source
      ? { ...source, id: undefined, templateName: name, isDefault: false }
      : { templateName: name, width: 60, height: 40, orientation: 'landscape', fieldGap: 1, layoutMode: 'free', fields: defaultFields(), elements: defaultElements(), isDefault: false };
    try {
      const response = await fetch('/api/label-templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(responseError(result, '创建模板失败'));
      const created = result.data as LabelTemplate;
      setTemplates((current) => [created, ...current]);
      chooseTemplate(created);
      setCreateMode(null);
      setNewName('');
      setMessage('模板已创建');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '创建模板失败');
    }
  };

  const setDefault = async (template: LabelTemplate) => {
    try {
      const response = await fetch('/api/label-templates', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: template.id, action: 'setDefault' }),
      });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(responseError(result, '设置默认模板失败'));
      const saved = result.data as LabelTemplate;
      setTemplates((current) => current.map((item) => ({ ...item, isDefault: item.id === saved.id })));
      setDraft((current) => current ? { ...current, isDefault: current.id === saved.id } : current);
      setMessage('已设为默认模板');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '设置默认模板失败');
    }
  };

  const deleteTemplate = async () => {
    if (!selectedTemplate || selectedTemplate.isDefault) return;
    try {
      const response = await fetch(`/api/label-templates?id=${encodeURIComponent(selectedTemplate.id)}`, { method: 'DELETE' });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(responseError(result, '删除模板失败'));
      const remaining = templates.filter((template) => template.id !== selectedTemplate.id);
      setTemplates(remaining);
      setDeleteOpen(false);
      if (remaining[0]) chooseTemplate(remaining[0]);
      setMessage('模板已删除');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '删除模板失败');
    }
  };

  return (
    <div className="mx-auto max-w-[1500px] page-transition-enter">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="mb-2 text-xl font-bold tracking-wide text-ink-deep">标签设计</h1>
          <p className="text-[13px] text-ink-soft">编辑库存标签模板与打印样式</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <a href="/inventory" className="btn-ghost inline-flex items-center gap-2">返回库存</a>
          <button type="button" onClick={() => void saveAndPreview()} disabled={saving || !sample} title={sample ? '保存当前模板并用库存样例测试打印' : '暂无在库样例'} className="btn-ghost inline-flex items-center gap-2 disabled:cursor-not-allowed disabled:opacity-50">
            <Printer className="h-4 w-4" />测试打印
          </button>
          <button type="button" onClick={() => { setCreateMode('new'); setNewName(''); }} className="btn-primary inline-flex items-center gap-2">
            <FilePlus2 className="h-4 w-4" />新建模板
          </button>
        </div>
      </header>

      {message && (
        <div role="status" className="mb-4 flex items-center justify-between rounded-xl border border-line bg-white/60 px-4 py-3 text-[13px] text-ink-soft">
          <span>{message}</span>
          <button type="button" onClick={() => setMessage('')} aria-label="关闭提示" className="rounded-md p-1 hover:bg-white"><X className="h-4 w-4" /></button>
        </div>
      )}

      <div className="grid items-start gap-5 xl:grid-cols-[300px_minmax(0,1fr)]">
        <aside className="glass overflow-hidden">
          <div className="flex items-center justify-between border-b border-line/70 px-4 py-3">
            <div>
              <h2 className="text-sm font-semibold text-ink-deep">模板</h2>
              <p className="mt-1 text-[11px] text-ink-soft">{templates.length} 个可用模板</p>
            </div>
            <LayoutTemplate className="h-4 w-4 text-primary" />
          </div>
          {loading ? <div className="p-6 text-center text-[13px] text-ink-soft">加载中...</div> : templates.length === 0 ? (
            <div className="p-6 text-center text-[13px] text-ink-soft">暂无模板</div>
          ) : (
            <div className="space-y-1 p-2">
              {templates.map((template) => {
                const size = dimensions(template);
                return (
                  <button
                    key={template.id}
                    type="button"
                    onClick={() => chooseTemplate(template)}
                    className={`w-full rounded-xl border px-3 py-3 text-left transition-colors ${selectedId === template.id ? 'border-primary/40 bg-primary/8' : 'border-transparent hover:border-line hover:bg-white/50'}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="min-w-0 truncate text-[13px] font-semibold text-ink-deep">{template.templateName}</span>
                      {template.isDefault && <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] text-primary"><Star className="h-3 w-3" />默认</span>}
                    </div>
                    <p className="mt-1 text-[11px] text-ink-soft">{size.width} × {size.height} mm · {template.orientation === 'landscape' ? '横向' : '纵向'}</p>
                  </button>
                );
              })}
            </div>
          )}
        </aside>

        {draft ? (
          <section className="grid min-w-0 gap-5 md:grid-cols-[minmax(0,1fr)_minmax(320px,0.9fr)]">
            <div className="order-2 glass min-w-0 overflow-hidden md:order-1">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line/70 px-5 py-4">
                <div>
                  <h2 className="text-base font-semibold text-ink-deep">模板设置</h2>
                  <p className="mt-1 text-[11px] text-ink-soft">设置尺寸、字段内容和文本样式</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button type="button" onClick={() => void saveDraft()} disabled={saving || !draft.templateName.trim()} className="btn-primary inline-flex items-center gap-1.5 !px-3 !py-2 text-[12px] disabled:opacity-50">
                    {saving ? <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" /> : <Save className="h-3.5 w-3.5" />}
                    保存
                  </button>
                  <button type="button" onClick={() => { setCreateMode('copy'); setNewName(`${draft.templateName} 副本`); }} title="复制模板" aria-label="复制模板" className="btn-ghost !px-3"><Copy className="h-4 w-4" /></button>
                  {!selectedTemplate?.isDefault && <button type="button" onClick={() => setDeleteOpen(true)} title="删除模板" aria-label="删除模板" className="rounded-lg border border-danger/20 bg-danger/5 p-2 text-danger hover:bg-danger/10"><Trash2 className="h-4 w-4" /></button>}
                  {!selectedTemplate?.isDefault && <button type="button" onClick={() => selectedTemplate && void setDefault(selectedTemplate)} className="btn-ghost inline-flex items-center gap-1.5 !px-3"><Star className="h-4 w-4" />设为默认</button>}
                </div>
              </div>

              <div className="space-y-5 p-5">
                <label className="block">
                  <span className="mb-1.5 block text-[12px] font-medium text-ink-deep">模板名称</span>
                  <input value={draft.templateName} onChange={(event) => updateDraft({ templateName: event.target.value })} maxLength={40} className="field" />
                </label>

                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="block">
                    <span className="mb-1.5 block text-[12px] font-medium text-ink-deep">纸张尺寸</span>
                    <CustomSelect
                      value={`${draft.width}x${draft.height}`}
                      onChange={(value) => {
                        const [width, height] = value.split('x').map(Number);
                        updateDraft({ width: width as 60 | 80, height: height as 40 | 50 });
                      }}
                      options={[{ value: '60x40', label: '60 × 40 mm' }, { value: '80x50', label: '80 × 50 mm' }]}
                    />
                  </label>
                  <label className="block">
                    <span className="mb-1.5 block text-[12px] font-medium text-ink-deep">打印方向</span>
                    <CustomSelect
                      value={draft.orientation}
                      onChange={(value) => updateDraft({ orientation: value as LabelTemplate['orientation'] })}
                      options={[{ value: 'landscape', label: '横向' }, { value: 'portrait', label: '纵向' }]}
                    />
                  </label>
                </div>

                <label className="block max-w-xs">
                  <span className="mb-1.5 block text-[12px] font-medium text-ink-deep">字段间距</span>
                  <div className="flex items-center gap-3">
                    <input type="range" min="0" max="8" step="0.5" value={draft.fieldGap} onChange={(event) => updateDraft({ fieldGap: Number(event.target.value) })} className="w-full accent-primary" aria-label="字段间距，毫米" />
                    <span className="min-w-14 text-right font-mono text-[12px] text-ink-deep">{draft.fieldGap} mm</span>
                  </div>
                </label>

                <label className="block max-w-xs">
                  <span className="mb-1.5 block text-[12px] font-medium text-ink-deep">字段布局</span>
                  <CustomSelect
                    value={draft.layoutMode}
                    onChange={(value) => setLayoutMode(value as LabelTemplate['layoutMode'])}
                    options={[
                      { value: 'flow', label: '顺序排列（兼容旧模板）' },
                      { value: 'free', label: '自由排列（拖拽定位）' },
                    ]}
                  />
                  <span className="mt-1.5 block text-[11px] text-ink-soft">自由排列后可直接拖动右侧预览中的字段。</span>
                </label>

                <div className="rounded-xl border border-line/70 bg-white/35 p-3">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h3 className="text-[13px] font-semibold text-ink-deep">设计元素</h3>
                      <p className="mt-1 text-[11px] text-ink-soft">添加直线或条码，拖动预览中的元素自由排版</p>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <button type="button" onClick={() => addElement('line')} className="btn-ghost inline-flex items-center gap-1.5 !px-2.5 !py-1.5 text-[11px]">
                        <Minus className="h-3.5 w-3.5" />直线
                      </button>
                      <button type="button" onClick={() => addElement('barcode')} className="btn-ghost inline-flex items-center gap-1.5 !px-2.5 !py-1.5 text-[11px]">
                        <Barcode className="h-3.5 w-3.5" />条码
                      </button>
                    </div>
                  </div>
                  {(draft.elements || []).length > 0 ? (
                    <div className="space-y-2">
                      {draft.elements.map((element, index) => (
                        <div key={element.id} className="space-y-2 rounded-lg border border-line/60 bg-white/55 px-2.5 py-2 text-[11px] transition hover:border-primary/35 hover:bg-white/75">
                          <div className="flex items-center justify-between gap-2">
                          <span className="inline-flex min-w-0 items-center gap-2 text-ink-deep">
                            {element.type === 'line' ? <Minus className="h-3.5 w-3.5 shrink-0 text-primary" /> : <Barcode className="h-3.5 w-3.5 shrink-0 text-primary" />}
                            <span>{element.type === 'line' ? '直线' : `条码 ${index + 1}`}</span>
                          </span>
                          <div className="flex items-center gap-2">
                            {element.type === 'barcode' && (
                              <CustomSelect
                                value={element.contentKey || 'sn'}
                                onChange={(value) => updateElement(element.id, { contentKey: value as FieldKey })}
                                options={FIELD_KEYS.map((key) => ({ value: key, label: FIELD_META[key].label }))}
                              />
                            )}
                            {element.type === 'line' && (
                              <CustomSelect
                                value={element.style.lineStyle || 'solid'}
                                onChange={(value) => updateElementStyle(element.id, { lineStyle: value as LabelElementStyle['lineStyle'] })}
                                options={[{ value: 'solid', label: '实线' }, { value: 'dashed', label: '虚线' }, { value: 'dotted', label: '点线' }]}
                              />
                            )}
                            <button type="button" onClick={() => removeElement(element.id)} className="rounded-md p-1.5 text-ink-soft transition hover:bg-danger/10 hover:text-danger" title="删除元素" aria-label="删除元素"><X className="h-3.5 w-3.5" /></button>
                          </div>
                          </div>
                          {element.type === 'line' ? (
                            <div className="grid grid-cols-[1fr_auto] items-center gap-2 border-t border-line/50 pt-2">
                              <label className="flex items-center gap-2 text-[10px] text-ink-soft">粗细
                                <input type="range" min="1" max="4" step="1" value={element.style.strokeWidth || 1} onChange={(event) => updateElementStyle(element.id, { strokeWidth: Number(event.target.value) })} className="w-full accent-primary" />
                              </label>
                              <label className="flex items-center gap-1.5 text-[10px] text-ink-soft">颜色
                                <input type="color" value={element.style.stroke || '#1e232c'} onChange={(event) => updateElementStyle(element.id, { stroke: event.target.value })} className="h-6 w-8 cursor-pointer rounded border border-line bg-white p-0.5" aria-label="直线颜色" />
                              </label>
                            </div>
                          ) : (
                            <div className="grid grid-cols-2 gap-2 border-t border-line/50 pt-2">
                              <label className="flex items-center gap-1.5 text-[10px] text-ink-soft">前景
                                <input type="color" value={element.style.foreground || '#111827'} onChange={(event) => updateElementStyle(element.id, { foreground: event.target.value })} className="h-6 w-8 cursor-pointer rounded border border-line bg-white p-0.5" aria-label="条码前景色" />
                              </label>
                              <label className="flex items-center gap-1.5 text-[10px] text-ink-soft">背景
                                <input type="color" value={element.style.background || '#ffffff'} onChange={(event) => updateElementStyle(element.id, { background: event.target.value })} className="h-6 w-8 cursor-pointer rounded border border-line bg-white p-0.5" aria-label="条码背景色" />
                              </label>
                              <label className="col-span-2 flex items-center gap-2 text-[10px] text-ink-soft"><input type="checkbox" checked={element.style.showText !== false} onChange={(event) => updateElementStyle(element.id, { showText: event.target.checked })} className="h-3.5 w-3.5 accent-primary" />显示编码文字</label>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="rounded-lg border border-dashed border-line px-3 py-2 text-[11px] text-ink-soft">还没有装饰元素</p>
                  )}
                </div>

                <div>
                  <div className="mb-2 flex items-center justify-between">
                    <div><h3 className="text-[13px] font-semibold text-ink-deep">标签字段</h3><p className="mt-1 text-[11px] text-ink-soft">开启需要打印的字段并调整排列</p></div>
                    <span className="text-[11px] text-ink-soft">{draft.fields.filter((field) => field.visible).length} 项显示</span>
                  </div>
                  <div className="divide-y divide-line/70 rounded-xl border border-line/70 bg-white/35">
                    {orderedFields.map((field, index) => (
                      <div key={field.key} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-3">
                        <label className="flex min-w-0 items-center gap-2.5">
                          <input type="checkbox" checked={field.visible} onChange={(event) => updateField(field.key, { visible: event.target.checked })} className="h-4 w-4 accent-primary" />
                          <span className="truncate text-[12px] font-medium text-ink-deep">{FIELD_META[field.key].label}</span>
                        </label>
                        <div className="flex items-center justify-end gap-1">
                          <button type="button" disabled={index === 0} onClick={() => moveField(field.key, -1)} aria-label={`上移${FIELD_META[field.key].label}`} className="rounded-md p-1.5 text-ink-soft hover:bg-white disabled:opacity-30"><MoveUp className="h-3.5 w-3.5" /></button>
                          <button type="button" disabled={index === orderedFields.length - 1} onClick={() => moveField(field.key, 1)} aria-label={`下移${FIELD_META[field.key].label}`} className="rounded-md p-1.5 text-ink-soft hover:bg-white disabled:opacity-30"><MoveDown className="h-3.5 w-3.5" /></button>
                        </div>
                        <label className="flex min-w-0 items-center gap-2 text-[11px] text-ink-soft">
                          字号
                          <input type="number" min="6" max="24" value={field.fontSize} onChange={(event) => updateField(field.key, { fontSize: Math.max(6, Math.min(24, Number(event.target.value) || 6)) })} className="field !w-14 min-w-0 !px-2 !py-1.5 text-center" />
                        </label>
                        <div className="flex items-center gap-1 rounded-lg border border-line bg-white/50 p-1" aria-label={`${FIELD_META[field.key].label}对齐方式`}>
                          {(['left', 'center', 'right'] as const).map((align) => (
                            <button key={align} type="button" onClick={() => updateField(field.key, { align })} aria-pressed={field.align === align} className={`flex-1 whitespace-nowrap rounded-md px-1.5 py-1 text-[10px] ${field.align === align ? 'bg-primary/12 font-medium text-primary' : 'text-ink-soft hover:bg-white'}`}>
                              {{ left: '左对齐', center: '居中', right: '右对齐' }[align]}
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line/70 pt-4">
                  <div className="text-[11px] text-ink-soft">{draft.isDefault ? '当前为默认模板' : '更改仅在保存后生效'}</div>
                  <button type="button" onClick={() => void saveDraft()} disabled={saving || !draft.templateName.trim()} className="btn-primary inline-flex items-center gap-2 disabled:opacity-50">
                    {saving ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" /> : <Save className="h-4 w-4" />}
                    保存模板
                  </button>
                </div>
              </div>
            </div>

            <div className="order-1 glass h-fit min-w-0 overflow-hidden md:sticky md:top-4 md:order-2">
              <div className="flex items-start justify-between gap-3 border-b border-line/70 px-5 py-4">
                <div>
                  <h2 className="text-sm font-semibold text-ink-deep">实时预览</h2>
                  <p className="mt-1 text-[11px] text-ink-soft">使用当前在库商品样例 · {previewSize.width} × {previewSize.height} mm</p>
                </div>
                <button type="button" onClick={() => setLayoutMode('free')} aria-pressed={draft.layoutMode === 'free'} className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] transition hover:scale-[1.02] ${draft.layoutMode === 'free' ? 'border-primary/30 bg-primary/10 text-primary' : 'border-line bg-white/60 text-ink-soft hover:bg-white'}`}>
                  <MousePointer2 className="h-3.5 w-3.5" />自由编辑
                </button>
              </div>
              <div className="flex min-h-[340px] min-w-0 flex-col items-center justify-center gap-4 bg-slate-50/45 px-3 py-5">
                <div className="w-full min-w-0 overflow-x-auto p-1">
                  <div className="flex w-fit min-w-full justify-center">
                    <LabelCanvas
                      template={draft}
                      values={previewValues}
                      className={`shadow-sm outline outline-1 outline-line-strong ${draft.layoutMode === 'free' ? 'touch-none' : ''}`}
                      fieldProps={(field) => ({
                        onPointerDown: (event) => startDraggingField(event, field, 0),
                        onPointerMove: (event) => updateDraggedField(event, field.key),
                        onPointerUp: (event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); delete dragOffsets.current[field.key]; },
                        onPointerCancel: (event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); delete dragOffsets.current[field.key]; },
                        className: draft.layoutMode === 'free' ? 'cursor-move outline-dashed outline-1 outline-primary/25 transition-colors hover:bg-primary/8' : '',
                      })}
                      elementProps={(element) => ({
                        onPointerDown: startDraggingElement,
                        onPointerMove: (event) => updateDraggedElement(event, element.id),
                        onPointerUp: (event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); delete dragOffsets.current[element.id]; },
                        onPointerCancel: (event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); delete dragOffsets.current[element.id]; },
                        className: 'cursor-move outline outline-1 outline-primary/25 transition-colors hover:bg-primary/8',
                      })}
                    />
                  </div>
                </div>
                <p className="max-w-xs text-center text-[11px] text-ink-soft">{draft.layoutMode === 'free' ? '拖动字段即可调整位置，虚线框表示可移动区域' : sample ? '预览数据来自当前库存' : '当前没有在库商品，显示字段名称作为预览'}</p>
              </div>
            </div>
          </section>
        ) : (
          <section className="glass flex min-h-72 flex-col items-center justify-center p-8 text-center">
            <LayoutTemplate className="mb-3 h-8 w-8 text-ink-soft/60" />
            <p className="text-[13px] text-ink-soft">{loading ? '正在加载模板...' : '新建标签模板以开始设计'}</p>
          </section>
        )}
      </div>

      {createMode && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-ink-deep/25 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="create-template-title">
          <div className="glass-strong w-full max-w-md overflow-visible">
            <header className="flex items-center justify-between border-b border-line/70 px-5 py-4">
              <h2 id="create-template-title" className="text-base font-semibold text-ink-deep">{createMode === 'copy' ? '复制模板' : '新建模板'}</h2>
              <button type="button" onClick={() => setCreateMode(null)} aria-label="关闭" className="rounded-lg p-2 text-ink-soft hover:bg-white"><X className="h-4 w-4" /></button>
            </header>
            <div className="p-5">
              <label className="block"><span className="mb-1.5 block text-[12px] font-medium text-ink-deep">模板名称</span><input autoFocus value={newName} onChange={(event) => setNewName(event.target.value)} maxLength={40} onKeyDown={(event) => { if (event.key === 'Enter') void createTemplate(); }} className="field" placeholder="例如：仓库入库标签" /></label>
              <div className="mt-5 flex justify-end gap-2"><button type="button" onClick={() => setCreateMode(null)} className="btn-ghost">取消</button><button type="button" onClick={() => void createTemplate()} className="btn-primary">创建模板</button></div>
            </div>
          </div>
        </div>
      )}

      {deleteOpen && selectedTemplate && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-ink-deep/25 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="delete-template-title">
          <div className="glass-strong w-full max-w-sm p-5">
            <h2 id="delete-template-title" className="text-base font-semibold text-ink-deep">删除标签模板</h2>
            <p className="mt-2 text-[13px] leading-6 text-ink-soft">确定删除“{selectedTemplate.templateName}”吗？此操作不会影响已打印的标签。</p>
            <div className="mt-5 flex justify-end gap-2"><button type="button" onClick={() => setDeleteOpen(false)} className="btn-ghost">取消</button><button type="button" onClick={() => void deleteTemplate()} className="rounded-full bg-danger px-4 py-2 text-[13px] font-medium text-white hover:bg-danger/90">删除</button></div>
          </div>
        </div>
      )}
    </div>
  );
}
