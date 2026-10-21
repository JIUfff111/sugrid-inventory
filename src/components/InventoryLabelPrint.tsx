'use client';

import { useCallback, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import LabelCanvas, { labelDimensions, type CanvasElement, type CanvasField } from '@/components/LabelCanvas';
import { useWorkspace } from '@/components/WorkspaceContext';

type PrintTemplate = {
  id: string;
  isDefault: boolean;
  width: number;
  height: number;
  orientation: 'portrait' | 'landscape';
  layoutMode: 'flow' | 'free';
  fieldGap: number;
  fields: CanvasField[];
  elements: CanvasElement[];
};
type PrintItem = {
  id: string;
  sn: string;
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
type PrintJob = { id: string; template: PrintTemplate; items: PrintItem[] };

function printableDate(value: string) {
  const date = new Date(value.replace(' ', 'T'));
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

/** Print labels from the current workflow without navigating away from its page. */
export function useInventoryLabelPrinter() {
  const { active, activeRef } = useWorkspace();
  const rootId = useId();
  const printRootId = `direct-inventory-print-${rootId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const [job, setJob] = useState<PrintJob | null>(null);
  const [printing, setPrinting] = useState(false);
  const lock = useRef(false);

  const printLabels = useCallback(async (inventoryIds: string[]) => {
    if (lock.current || !activeRef.current) return;
    const ids = [...new Set(inventoryIds)];
    if (!ids.length) throw new Error('没有可打印的入库机器');
    lock.current = true;
    setPrinting(true);
    try {
      const read = async (url: string) => {
        const response = await fetch(url, { cache: 'no-store' });
        const result = await response.json();
        if (!response.ok || !result.success) throw new Error(result.error?.message || '读取打印数据失败');
        return result.data;
      };
      const [templates, firstPage] = await Promise.all([
        read('/api/label-templates') as Promise<PrintTemplate[]>,
        read('/api/inventory?page=1&pageSize=100&status=all'),
      ]);
      const template = templates.find((item) => item.isDefault);
      if (!template) throw new Error('请先在标签设计中设置默认模板');
      const wanted = new Set(ids);
      const collected = new Map<string, PrintItem>();
      const addItems = (items: PrintItem[]) => items.forEach((item) => { if (wanted.has(item.id)) collected.set(item.id, item); });
      addItems(firstPage.items || []);
      for (let page = 2; page <= Number(firstPage.totalPages || 1) && collected.size < wanted.size; page += 1) {
        const nextPage = await read(`/api/inventory?page=${page}&pageSize=100&status=all`);
        addItems(nextPage.items || []);
      }
      if (collected.size !== wanted.size) throw new Error('部分入库机器未找到，请在库存清单重新选择后打印');
      if (!activeRef.current) throw new Error('打印已暂停，请返回此标签后重试');
      setJob({ id: crypto.randomUUID(), template, items: ids.map((id) => collected.get(id)!) });
      await document.fonts.ready;
      const deadline = performance.now() + 10000;
      while (true) {
        if (!activeRef.current) throw new Error('打印已暂停，请返回此标签后重试');
        const root = document.getElementById(printRootId);
        if (root?.querySelector('[data-barcode-status="error"]')) throw new Error('标签条码生成失败，请检查 SN 和模板字段');
        const pending = root?.querySelector('[data-barcode-status="loading"], [data-label-text-status="pending"]');
        if (root && root.children.length === ids.length && !pending) break;
        if (performance.now() > deadline) throw new Error('打印内容准备超时，请重试打印');
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      if (activeRef.current) window.print();
    } finally {
      setJob(null);
      setPrinting(false);
      lock.current = false;
    }
  }, [activeRef, printRootId]);

  const size = job ? labelDimensions(job.template) : null;
  const printPortal = active && job && size && createPortal(<>
    <style>{`
      @media screen { #${printRootId} { display: none !important; } }
      @media print {
        @page { size: ${size.width}mm ${size.height}mm; margin: 0; }
        html, body { width: ${size.width}mm !important; min-width: 0 !important; height: auto !important; min-height: 0 !important; margin: 0 !important; padding: 0 !important; overflow: visible !important; background: white !important; }
        body { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
        body > :not(#${printRootId}) { display: none !important; }
        body > #${printRootId} { display: block !important; position: static !important; width: ${size.width}mm !important; margin: 0 !important; padding: 0 !important; }
        #${printRootId} .direct-print-tag { box-sizing: border-box; display: block; width: ${size.width}mm; height: ${size.height}mm; margin: 0; padding: 0; overflow: hidden; break-inside: avoid; break-after: page; page-break-after: always; }
        #${printRootId} .direct-print-tag:last-child { break-after: auto; page-break-after: auto; }
      }
    `}</style>
    <div id={printRootId} data-print-job={job.id} aria-hidden="true">{job.items.map((item) => <article key={item.id} className="direct-print-tag">
      <LabelCanvas template={job.template} values={{
        product: [item.brand, item.model, item.year].filter(Boolean).join(' '),
        config: [item.cpu, item.ram, item.gpu, item.storage, item.screen, item.touchScreen ? '触屏' : ''].filter(Boolean).join(' · ') || '配置未补充',
        sn: item.sn,
        purchasePrice: `¥${Number(item.purchasePrice).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
        supplier: item.supplierName || '-',
        inboundDate: printableDate(item.inboundDate),
      }} />
    </article>)}</div>
  </>, document.body);

  return { printLabels, printing, printPortal };
}

