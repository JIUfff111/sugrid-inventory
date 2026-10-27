'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useWorkspace } from '@/components/WorkspaceContext';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { Check, Printer, RefreshCw } from 'lucide-react';
import CustomSelect from '@/components/CustomSelect';
import LabelCanvas from '@/components/LabelCanvas';
import { formatProductName } from '@/lib/product-name';
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
  width: 60 | 80;
  height: 40 | 50;
  orientation: 'portrait' | 'landscape';
  fieldGap: number;
  layoutMode: 'flow' | 'free';
  fields: LabelField[];
  elements: LabelElement[];
  isDefault: boolean;
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
type InventoryResult = { items: InventoryItem[]; totalPages?: number };

function formatMoney(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '-';
  return `¥${Number(value).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(value: string | null | undefined) {
  if (!value) return '-';
  const parsed = new Date(value.replace(' ', 'T'));
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

function productName(item: InventoryItem) {
  return formatProductName(item, item.productType || '未命名商品');
}

function configSummary(item: InventoryItem) {
  return [formatCPUDisplay(item.cpu), item.ram, formatGPUDisplay(item.gpu), item.storage, item.screen, item.touchScreen ? '触屏' : ''].filter(Boolean).join(' · ') || '配置未补充';
}

function fieldValue(key: FieldKey, item: InventoryItem) {
  switch (key) {
    case 'product': return productName(item);
    case 'config': return configSummary(item);
    case 'sn': return item.sn || '-';
    case 'purchasePrice': return formatMoney(item.purchasePrice);
    case 'supplier': return item.supplierName || '-';
    case 'inboundDate': return formatDate(item.inboundDate);
  }
}

function labelSize(template: LabelTemplate | null) {
  if (!template) return { width: 60, height: 40 };
  const short = Math.min(template.width, template.height);
  const long = Math.max(template.width, template.height);
  return template.orientation === 'portrait'
    ? { width: short, height: long }
    : { width: long, height: short };
}

export default function PrintPreviewPage() {
  const { active, activeRef, searchParams } = useWorkspace();
  const queryKey = searchParams.toString();
  const initializedQuery = useRef<string | null>(null);
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [templates, setTemplates] = useState<LabelTemplate[]>([]);
  const [templateId, setTemplateId] = useState('');
  const [loading, setLoading] = useState(true);
  const [printing, setPrinting] = useState(false);
  const [error, setError] = useState('');
  const [portalReady, setPortalReady] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const autoPrintStarted = useRef<Set<string>>(new Set());
  const printPending = useRef(false);

  useEffect(() => {
    setPortalReady(true);
    const controller = new AbortController();
    async function load() {
      const initial = initializedQuery.current !== queryKey;
      if (initial) setLoading(true);
      setError('');
      try {
        const query = new URLSearchParams(queryKey);
        const requestedIds = [...new Set((query.get('ids') || '').split(',').map((id) => id.trim()).filter(Boolean))];
        const inventoryStatus = requestedIds.length > 0 ? 'all' : 'in_stock';
        const [templateResponse, firstInventoryResponse] = await Promise.all([
          fetch('/api/label-templates', { cache: 'no-store', signal: controller.signal }),
          fetch(`/api/inventory?page=1&pageSize=100&status=${inventoryStatus}`, { cache: 'no-store', signal: controller.signal }),
        ]);
        const [templateResult, firstInventoryResult] = await Promise.all([templateResponse.json(), firstInventoryResponse.json()]);
        if (!templateResponse.ok || !templateResult.success) throw new Error(templateResult.error?.message || '加载标签模板失败');
        if (!firstInventoryResponse.ok || !firstInventoryResult.success) throw new Error(firstInventoryResult.error?.message || '加载库存清单失败');
        const nextTemplates = Array.isArray(templateResult.data) ? templateResult.data as LabelTemplate[] : [];
        const preferred = query.get('templateId') || nextTemplates.find((template) => template.isDefault)?.id || nextTemplates[0]?.id || '';
        setTemplates(nextTemplates);
        if (initial) setTemplateId(nextTemplates.some((template) => template.id === preferred) ? preferred : nextTemplates[0]?.id || '');

        const firstPage = firstInventoryResult.data as InventoryResult;
        const collected = [...(firstPage.items || [])];
        const wanted = new Set(requestedIds);
        const found = new Set(collected.filter((item) => wanted.has(item.id)).map((item) => item.id));
        let page = 2;
        const totalPages = Number(firstPage.totalPages || 1);
        while (requestedIds.length > 0 && page <= totalPages && found.size < wanted.size) {
          const response = await fetch(`/api/inventory?page=${page}&pageSize=100&status=${inventoryStatus}`, { cache: 'no-store', signal: controller.signal });
          const result = await response.json();
          if (!response.ok || !result.success) throw new Error(result.error?.message || '加载库存清单失败');
          const nextItems = (result.data as InventoryResult).items || [];
          collected.push(...nextItems);
          nextItems.forEach((item) => { if (wanted.has(item.id)) found.add(item.id); });
          page += 1;
        }
        if (controller.signal.aborted) return;
        const desired = requestedIds.length > 0 ? collected.filter((item) => wanted.has(item.id)) : collected;
        if (requestedIds.length > 0 && desired.length !== wanted.size) throw new Error('部分机器已不在库存中，请返回库存清单重新选择后打印');
        setInventory(desired);
        if (initial) setSelectedIds(new Set(requestedIds.length > 0 ? desired.map((item) => item.id) : []));
        else setSelectedIds(current => new Set([...current].filter(id => desired.some(item => item.id === id))));
        initializedQuery.current = queryKey;
      } catch (loadError) {
        if (loadError instanceof DOMException && loadError.name === 'AbortError') return;
        setError(loadError instanceof Error ? loadError.message : '加载打印预览失败');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [queryKey, reloadKey]);

  const template = templates.find((item) => item.id === templateId) || null;
  const size = labelSize(template);
  const selectedItems = useMemo(() => inventory.filter((item) => selectedIds.has(item.id)), [inventory, selectedIds]);
  const allSelected = inventory.length > 0 && selectedItems.length === inventory.length;
  const toggleAll = () => setSelectedIds(allSelected ? new Set() : new Set(inventory.map((item) => item.id)));
  const toggleItem = (id: string) => setSelectedIds((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const printNow = useCallback(async () => {
    if (!activeRef.current || !template || selectedItems.length === 0 || printPending.current) return;
    printPending.current = true;
    setPrinting(true);
    setError('');
    try {
      await document.fonts.ready;
      const deadline = performance.now() + 10000;
      // Portal contents remain measurable through SVG viewBoxes even while hidden on screen.
      while (true) {
        if (!activeRef.current) throw new Error('打印已暂停，请返回此标签后重试');
        const root = document.getElementById('inventory-print-root');
        if (root?.querySelector('[data-barcode-status="error"]')) throw new Error('标签包含无法生成的条码，请检查 SN 或条码绑定字段后重试');
        const pending = root?.querySelector('[data-barcode-status="loading"], [data-label-text-status="pending"]');
        if (root && root.children.length === selectedItems.length && !pending) break;
        if (performance.now() > deadline) throw new Error('标签尚未准备完成，请稍后重试打印');
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      }
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())));
      if (activeRef.current) window.print();
    } catch (printError) {
      setError(printError instanceof Error ? printError.message : '打开打印失败，请重试');
    } finally {
      printPending.current = false;
      setPrinting(false);
    }
  }, [activeRef, selectedItems.length, template]);

  useEffect(() => {
    if (!active || loading || !portalReady || !template || selectedItems.length === 0 || initializedQuery.current !== queryKey || autoPrintStarted.current.has(queryKey)) return;
    if (searchParams.get('autoPrint') !== '1') return;
    autoPrintStarted.current.add(queryKey);
    void printNow();
  }, [active, loading, portalReady, printNow, queryKey, searchParams, selectedItems.length, template]);

  const renderTag = (item: InventoryItem) => (
    <article key={item.id} className="print-tag relative shrink-0 bg-white shadow-sm outline outline-1 outline-slate-300" style={{ width: `${size.width}mm`, height: `${size.height}mm` }}>
      {template && <LabelCanvas template={template} values={{ product: fieldValue('product', item), config: fieldValue('config', item), sn: fieldValue('sn', item), purchasePrice: fieldValue('purchasePrice', item), supplier: fieldValue('supplier', item), inboundDate: fieldValue('inboundDate', item) }} />}
    </article>
  );

  return (
    <div className="mx-auto max-w-[1440px] page-transition-enter">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-4 print:hidden">
        <div>
          <h1 className="mb-2 text-xl font-bold tracking-wide text-ink-deep">打印预览</h1>
          <p className="text-[13px] text-ink-soft">检查库存标签内容并打印</p>
        </div>
        <Link href="/inventory" className="btn-ghost">返回库存清单</Link>
      </header>

      {error && <div role="alert" className="mb-4 rounded-xl border border-danger/20 bg-danger/5 px-4 py-3 text-[13px] text-danger">{error}</div>}

      <section className="glass mb-5 p-4 print:hidden">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
          <label className="block min-w-0 flex-1 lg:max-w-sm">
            <span className="mb-1.5 block text-[11px] text-ink-soft">标签模板</span>
            <CustomSelect value={templateId} onChange={setTemplateId} options={templates.map((item) => ({ value: item.id, label: `${item.templateName}${item.isDefault ? '（默认）' : ''}` }))} placeholder="请选择模板" />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={toggleAll} disabled={inventory.length === 0 || loading} className="btn-ghost inline-flex items-center gap-1.5 disabled:opacity-50">
              <Check className="h-4 w-4" />{allSelected ? '取消全选' : '全选当前结果'}
            </button>
            <button type="button" onClick={() => setReloadKey(current => current + 1)} disabled={loading} aria-label="刷新清单" title="刷新清单" className="rounded-lg p-2 text-ink-soft hover:bg-white/70 hover:text-primary disabled:opacity-50"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /></button>
            <button type="button" onClick={() => void printNow()} disabled={selectedItems.length === 0 || !template || printing} className="btn-primary inline-flex items-center gap-2 disabled:opacity-50">
              <Printer className="h-4 w-4" />{printing ? '正在打开打印...' : `打印已选 ${selectedItems.length} 张`}
            </button>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[11px] text-ink-soft">
          <span>已选 {selectedItems.length} 台{template ? ` · ${size.width} × ${size.height} mm · ${template.orientation === 'landscape' ? '横向' : '纵向'}` : ''}</span>
          {inventory.length > 0 && <span>来源库存 {inventory.length} 台</span>}
        </div>
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-primary/15 bg-primary/5 px-3 py-2.5 text-[11px] text-ink-soft">
          <Printer className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
          <p>浏览器打印建议选择自定义纸张 {size.width} × {size.height} mm、缩放 100%、边距“无”，关闭“适合页面大小”和“页眉和页脚”后打印。</p>
        </div>
      </section>

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(320px,0.9fr)_minmax(0,1.4fr)] print:block">
        <section className="glass overflow-hidden print:hidden">
          <div className="flex items-center justify-between border-b border-line/70 px-4 py-3">
            <div><h2 className="text-sm font-semibold text-ink-deep">打印商品</h2><p className="mt-1 text-[11px] text-ink-soft">选择要打印的在库机器</p></div>
            <span className="text-[12px] text-ink-soft">{inventory.length} 条</span>
          </div>
          {loading ? <div className="p-8 text-center text-[13px] text-ink-soft">正在加载库存...</div> : inventory.length === 0 ? (
            <div className="p-8 text-center text-[13px] text-ink-soft">没有找到传入的在库机器</div>
          ) : (
            <div className="max-h-[65vh] overflow-auto">
              <table className="data-table w-full min-w-[440px]">
                <thead><tr><th className="w-12 text-center">选择</th><th>商品</th><th>SN / IMEI</th><th className="text-right">采购价</th></tr></thead>
                <tbody>{inventory.map((item) => <tr key={item.id}>
                  <td className="text-center"><input type="checkbox" checked={selectedIds.has(item.id)} onChange={() => toggleItem(item.id)} aria-label={`选择 ${item.sn || productName(item)}`} className="h-4 w-4 accent-primary" /></td>
                  <td><div className="font-medium text-ink-deep">{productName(item)}</div><div className="mt-1 text-[11px] text-ink-soft">{configSummary(item)}</div></td>
                  <td className="font-mono text-[11px] text-ink-deep">{item.sn || '-'}</td>
                  <td className="text-right font-mono text-[11px] text-ink-deep">{formatMoney(item.purchasePrice)}</td>
                </tr>)}</tbody>
              </table>
            </div>
          )}
        </section>

        <section className="glass overflow-hidden lg:sticky lg:top-0 print:border-0 print:bg-transparent print:shadow-none">
          <div className="flex items-center justify-between border-b border-line/70 px-4 py-3 print:hidden">
            <div><h2 className="text-sm font-semibold text-ink-deep">标签预览</h2><p className="mt-1 text-[11px] text-ink-soft">按选定模板显示字段与纸张规格</p></div>
            <span className="text-[12px] text-ink-soft">{selectedItems.length} 张</span>
          </div>
          <div id="print-output" className="flex flex-wrap items-start justify-center gap-4 bg-slate-50/45 p-5 print:block print:bg-transparent print:p-0">
            {selectedItems.map(renderTag)}
            {!loading && selectedItems.length === 0 && <div className="flex min-h-56 w-full items-center justify-center text-center text-[13px] text-ink-soft print:hidden"><div><Printer className="mx-auto mb-3 h-8 w-8 opacity-50" /><p>{inventory.length ? '请选择要打印的商品' : '从库存清单选择机器后可在此预览'}</p></div></div>}
          </div>
        </section>
      </div>

      {active && printing && portalReady && template && createPortal(
        <>
          <style>{`@media screen { #inventory-print-root { display: none !important; } }
          @media print {
            @page { size: ${size.width}mm ${size.height}mm; margin: 0; }
            html, body { width: ${size.width}mm !important; min-width: 0 !important; height: auto !important; min-height: 0 !important; margin: 0 !important; padding: 0 !important; overflow: visible !important; background: #fff !important; }
            body { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
            body > :not(#inventory-print-root) { display: none !important; }
            body > #inventory-print-root { display: block !important; position: static !important; width: ${size.width}mm !important; margin: 0 !important; padding: 0 !important; visibility: visible !important; }
            #inventory-print-root, #inventory-print-root * { visibility: visible !important; }
            #inventory-print-root .print-tag { position: relative !important; display: block !important; box-sizing: border-box !important; width: ${size.width}mm !important; height: ${size.height}mm !important; min-height: ${size.height}mm !important; margin: 0 !important; padding: 0 !important; overflow: hidden !important; border: 0 !important; border-radius: 0 !important; box-shadow: none !important; outline: 0 !important; background: #fff !important; break-inside: avoid !important; page-break-inside: avoid !important; break-after: page !important; page-break-after: always !important; }
            #inventory-print-root .print-tag:last-child { break-after: auto !important; page-break-after: auto !important; }
            #inventory-print-root .print-tag svg { max-width: 100% !important; }
          }`}</style>
          <div id="inventory-print-root" aria-hidden="true">{selectedItems.map(renderTag)}</div>
        </>,
        document.body,
      )}
    </div>
  );
}
