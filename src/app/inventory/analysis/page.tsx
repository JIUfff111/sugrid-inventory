/**
 * 库存分析工作台
 */
'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useWorkspace } from '@/components/WorkspaceContext';
import {
  ArrowLeft,
  BarChart3,
  Clock3,
  Download,
  Package,
  RefreshCw,
  WalletCards,
} from 'lucide-react';

type GroupRow = { name: string; count: number; inStock: number; cost: number };
type DetailRow = {
  sn: string;
  brand: string;
  model: string;
  year: number | null;
  status: string;
  customStatusName?: string | null;
  purchasePrice: number;
  supplierName: string;
  inboundDate: string;
  inboundDays: number;
};
type AnalysisData = {
  summary: {
    total: number;
    inStock: number;
    sold: number;
    returning: number;
    renting: number;
    afterSale: number;
    reserved: number;
    totalCost: number;
    inStockCost: number;
    averageCost: number;
    custom?: number;
    customCost?: number;
    available?: number;
    availableCost?: number;
  };
  byBrand: GroupRow[];
  byModel: GroupRow[];
  bySupplier: GroupRow[];
  byAge: GroupRow[];
  details: DetailRow[];
  byCustomStatus?: Array<{ id: string; name: string; color: string; count: number; cost: number }>;
};

function productName(item: Pick<DetailRow, 'brand' | 'model' | 'year'>) {
  return [item.brand, item.model, item.year].filter((value) => value !== null && value !== undefined && String(value).trim() !== '').join(' ') || '未命名商品';
}

const EMPTY_DATA: AnalysisData = {
  summary: {
    total: 0,
    inStock: 0,
    sold: 0,
    returning: 0,
    renting: 0,
    afterSale: 0,
    reserved: 0,
    totalCost: 0,
    inStockCost: 0,
    averageCost: 0,
  },
  byBrand: [],
  byModel: [],
  bySupplier: [],
  byAge: [],
  details: [],
};

const STATUS_LABELS: Record<string, string> = {
  in_stock: '在库',
  sold: '已售',
  returning: '退货中',
  renting: '租赁中',
  reserved: '已预留',
  after_sale: '售后中',
  returned: '已退货',
};

function formatMoney(value: number) {
  return `¥${Number(value || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(value: string) {
  if (!value) return '-';
  const date = new Date(value.replace(' ', 'T'));
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('zh-CN');
}

function csvCell(value: unknown) {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export default function InventoryAnalysisPage() {
  const { active } = useWorkspace();
  const [data, setData] = useState<AnalysisData>(EMPTY_DATA);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError('');
      try {
        const response = await fetch('/api/inventory/analysis', { cache: 'no-store' });
        const result = await response.json();
        if (!response.ok || !result.success) throw new Error(result.error?.message || '加载库存分析失败');
        if (!cancelled) setData(result.data as AnalysisData);
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : '加载库存分析失败');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [active, reloadKey]);

  const exportDetails = () => {
    const header = ['SN / IMEI', '品牌', '型号', '年份', '状态', '采购价', '供应商', '入库日期', '库龄（天）'];
    const rows = data.details.map((item) => [
      item.sn,
      item.brand,
      item.model,
      item.year || '',
      item.customStatusName || STATUS_LABELS[item.status] || item.status,
      item.purchasePrice,
      item.supplierName,
      formatDate(item.inboundDate),
      item.inboundDays,
    ]);
    const csv = [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
    const blob = new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `库存分析-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="mx-auto max-w-[1400px] page-transition-enter">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="mb-2 flex items-center gap-2 text-[12px] text-ink-soft">
            <Link href="/inventory" className="inline-flex items-center gap-1 hover:text-primary"><ArrowLeft className="h-3.5 w-3.5" />在库清单</Link>
            <span>/</span>
            <span>库存分析</span>
          </div>
          <h1 className="text-xl font-bold tracking-wide text-ink-deep">库存分析工作台</h1>
          <p className="mt-2 text-[13px] text-ink-soft">按状态、品牌、型号、供应商和库龄查看库存结构与成本占用</p>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => setReloadKey((current) => current + 1)} disabled={loading} className="btn-ghost inline-flex items-center gap-1.5" title="刷新分析"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />刷新</button>
          <button type="button" onClick={exportDetails} disabled={loading || data.details.length === 0} className="btn-primary inline-flex items-center gap-1.5"><Download className="h-4 w-4" />导出库存明细</button>
        </div>
      </header>

      {error && <div role="alert" className="mb-4 rounded-xl border border-danger/20 bg-danger/5 px-4 py-3 text-[13px] text-danger">{error}</div>}

      <section className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Metric icon={<Package className="h-5 w-5" />} label="库存总数" value={data.summary.total} />
        <Metric icon={<Package className="h-5 w-5" />} label="当前在库" value={data.summary.inStock} tone="success" />
        <Metric icon={<BarChart3 className="h-5 w-5" />} label="已售机器" value={data.summary.sold} tone="primary" />
        <Metric icon={<Clock3 className="h-5 w-5" />} label="售后 / 退货 / 租赁" value={`${data.summary.afterSale} / ${data.summary.returning} / ${data.summary.renting}`} tone="warning" />
        <Metric icon={<WalletCards className="h-5 w-5" />} label="在库成本" value={formatMoney(data.summary.inStockCost)} tone="primary" />
      </section>

      <section className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric icon={<Package className="h-5 w-5" />} label="自定义状态机器" value={data.summary.custom || 0} tone="warning" />
        <Metric icon={<WalletCards className="h-5 w-5" />} label="自定义状态成本" value={formatMoney(data.summary.customCost || 0)} />
        <Metric icon={<Package className="h-5 w-5" />} label="可参与在库业务" value={data.summary.available ?? data.summary.inStock} tone="success" />
        <Metric icon={<WalletCards className="h-5 w-5" />} label="可参与业务成本" value={formatMoney(data.summary.availableCost ?? data.summary.inStockCost)} tone="primary" />
      </section>
      {!!data.byCustomStatus?.length && <section className="glass mb-5 overflow-hidden"><h2 className="border-b border-line/70 px-5 py-4 text-sm font-semibold">自定义状态分布</h2><div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">{data.byCustomStatus.map(row => <div key={row.id} className="rounded-xl border border-line/70 bg-white/60 p-3"><p className="flex items-center gap-2 text-sm"><span className="h-2.5 w-2.5 rounded-full" style={{ background: row.color }} />{row.name}</p><p className="mt-2 font-mono text-sm">{row.count} 台 · {formatMoney(row.cost)}</p></div>)}</div></section>}

      <section className="mb-5 grid gap-4 lg:grid-cols-2">
        <GroupPanel title="品牌分布" rows={data.byBrand} />
        <GroupPanel title="型号分布" rows={data.byModel} />
        <GroupPanel title="供应商分布" rows={data.bySupplier} />
        <GroupPanel title="库龄分布" rows={data.byAge} />
      </section>

      <section className="glass overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line/70 px-5 py-4">
          <div><h2 className="text-sm font-semibold text-ink-deep">成本概览</h2><p className="mt-1 text-[11px] text-ink-soft">采购总成本 {formatMoney(data.summary.totalCost)} · 平均单台 {formatMoney(data.summary.averageCost)}</p></div>
          <span className="text-[12px] text-ink-soft">明细 {data.details.length} 条</span>
        </div>
        {loading ? <div className="p-8 text-center text-[13px] text-ink-soft">加载中...</div> : data.details.length === 0 ? <div className="p-8 text-center text-[13px] text-ink-soft">暂无库存记录</div> : (
          <div className="overflow-x-auto">
            <table className="data-table w-full min-w-[820px]">
              <thead><tr><th>SN / IMEI</th><th>机器</th><th>供应商</th><th>状态</th><th>采购价</th><th>入库日期</th><th>库龄</th></tr></thead>
              <tbody>{data.details.slice(0, 20).map((item) => <tr key={item.sn}><td className="font-mono text-[12px]">{item.sn}</td><td>{productName(item)}</td><td>{item.supplierName || '-'}</td><td>{item.customStatusName || STATUS_LABELS[item.status] || item.status}</td><td className="font-mono">{formatMoney(item.purchasePrice)}</td><td>{formatDate(item.inboundDate)}</td><td>{item.inboundDays} 天</td></tr>)}</tbody>
            </table>
          </div>
        )}
        {data.details.length > 20 && <p className="border-t border-line/70 px-5 py-3 text-[12px] text-ink-soft">页面展示前 20 条，导出按钮可下载完整明细。</p>}
      </section>
    </div>
  );
}

function Metric({ icon, label, value, tone = 'default' }: { icon: React.ReactNode; label: string; value: string | number; tone?: 'default' | 'success' | 'primary' | 'warning' }) {
  const colors = { default: 'bg-white/55 text-ink-deep', success: 'bg-success/10 text-success', primary: 'bg-primary/10 text-primary', warning: 'bg-warning/10 text-warning' };
  return <div className="glass flex min-h-[112px] flex-col justify-between p-4"><div className={`inline-flex h-9 w-9 items-center justify-center rounded-lg ${colors[tone]}`}>{icon}</div><div><div className="text-[11px] text-ink-soft">{label}</div><strong className="mt-1 block font-mono text-lg text-ink-deep">{value}</strong></div></div>;
}

function GroupPanel({ title, rows }: { title: string; rows: GroupRow[] }) {
  const maxCount = Math.max(...rows.map((row) => row.count), 1);
  return <section className="glass overflow-hidden"><div className="border-b border-line/70 px-5 py-4"><h2 className="text-sm font-semibold text-ink-deep">{title}</h2></div>{rows.length === 0 ? <p className="p-5 text-[12px] text-ink-soft">暂无数据</p> : <div className="divide-y divide-line/60">{rows.slice(0, 8).map((row) => <div key={row.name} className="px-5 py-3"><div className="flex items-center justify-between gap-3 text-[12px]"><span className="min-w-0 truncate text-ink-deep">{row.name}</span><span className="shrink-0 font-mono text-ink-soft">{row.count} 台 · {formatMoney(row.cost)}</span></div><div className="mt-2 h-1.5 overflow-hidden rounded-full bg-line/60"><div className="h-full rounded-full bg-primary" style={{ width: `${Math.max(5, (row.count / maxCount) * 100)}%` }} /></div><div className="mt-1 text-[10px] text-ink-soft">其中在库 {row.inStock} 台</div></div>)}</div>}</section>;
}
