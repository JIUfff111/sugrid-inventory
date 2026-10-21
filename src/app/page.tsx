'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowRight,
  Bell,
  CircleDollarSign,
  ClipboardList,
  Package,
  Plus,
  RefreshCw,
  ShoppingCart,
  Truck,
  Warehouse,
} from 'lucide-react';

type DashboardStats = {
  inventoryTotal: number;
  inStock: number;
  sold: number;
  returning: number;
  inStockCost: number;
  orderTotal: number;
  draftOrders: number;
  inboundedOrders: number;
  salesTotal: number;
  salesQuantity?: number;
  salesCost?: number;
  salesAmount: number;
  salesProfit: number;
  skuCount: number;
  supplierCount: number;
};

type RecentOrder = {
  id: string;
  purchaseNo: string;
  supplierName: string;
  purchaseDate: string;
  totalQuantity: number;
  totalAmount: number;
  isInbounded: number;
  createdAt: string;
};

type DashboardMessage = {
  id: string;
  tone: 'warn' | 'danger' | 'info' | 'success';
  title: string;
  detail: string;
  href: string;
};

type DashboardPayload = {
  stats: DashboardStats;
  recentOrders: RecentOrder[];
  messages: DashboardMessage[];
};

const EMPTY_STATS: DashboardStats = {
  inventoryTotal: 0,
  inStock: 0,
  sold: 0,
  returning: 0,
  inStockCost: 0,
  orderTotal: 0,
  draftOrders: 0,
  inboundedOrders: 0,
  salesTotal: 0,
  salesAmount: 0,
  salesProfit: 0,
  skuCount: 0,
  supplierCount: 0,
};

const money = (value: number) => `¥${value.toLocaleString('zh-CN', { maximumFractionDigits: 0 })}`;
const dateText = (value: string) => value?.slice(0, 10) || '-';

function messageStyle(tone: DashboardMessage['tone']) {
  return {
    warn: { icon: AlertTriangle, className: 'text-warn bg-warn/10' },
    danger: { icon: AlertTriangle, className: 'text-danger bg-danger/10' },
    info: { icon: Bell, className: 'text-primary bg-primary/10' },
    success: { icon: ClipboardList, className: 'text-ok bg-ok/10' },
  }[tone];
}

export default function HomePage() {
  const [payload, setPayload] = useState<DashboardPayload>({ stats: EMPTY_STATS, recentOrders: [], messages: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  const loadDashboard = useCallback(async () => {
    try {
      setLoading(true);
      setError('');
      const response = await fetch('/api/dashboard', { cache: 'no-store' });
      const result = await response.json() as { success?: boolean; data?: DashboardPayload; error?: { message?: string } };
      if (!response.ok || !result.success || !result.data) {
        throw new Error(result.error?.message || '首页数据加载失败');
      }
      setPayload(result.data);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '首页数据加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadDashboard();
  }, [loadDashboard, reloadKey]);

  const { stats, recentOrders, messages } = payload;

  return (
    <div className="mx-auto max-w-[1400px] space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="mb-1 text-[12px] font-medium uppercase tracking-[0.12em] text-primary">工作台</p>
          <h1 className="text-2xl font-bold tracking-wide text-ink-deep">溯格工作台</h1>
          <p className="mt-2 text-[13px] text-ink-soft">每台机器有迹可循，每次交付有据可查。</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setReloadKey((key) => key + 1)}
            disabled={loading}
            title="刷新首页数据"
            aria-label="刷新首页数据"
            className="rounded-lg border border-line bg-white/70 p-2 text-ink-soft transition-colors hover:bg-white hover:text-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <Link href="/orders" className="btn-primary inline-flex items-center gap-2 text-[13px]">
            <Plus className="h-4 w-4" />
            新增采购单
          </Link>
        </div>
      </header>

      {error && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-danger/20 bg-danger/5 px-4 py-3 text-[13px] text-danger">
          <span>{error}</span>
          <button type="button" onClick={() => setReloadKey((key) => key + 1)} className="font-medium underline underline-offset-2">重试</button>
        </div>
      )}

      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="核心指标">
        <Link href="/inventory" className="glass card-hover group p-5">
          <div className="flex items-start justify-between">
            <div><p className="text-[12px] text-ink-soft">在库机器</p><p className="mt-2 font-mono text-3xl font-bold tracking-tight text-ink-deep">{stats.inStock}</p></div>
            <span className="rounded-xl bg-ok/10 p-2.5 text-ok"><Warehouse className="h-5 w-5" /></span>
          </div>
          <p className="mt-4 flex items-center gap-1 text-[12px] text-ink-soft group-hover:text-primary">查看库存清单 <ArrowRight className="h-3.5 w-3.5" /></p>
        </Link>

        <Link href="/orders" className="glass card-hover group p-5">
          <div className="flex items-start justify-between">
            <div><p className="text-[12px] text-ink-soft">待处理采购</p><p className="mt-2 font-mono text-3xl font-bold tracking-tight text-ink-deep">{stats.draftOrders}</p></div>
            <span className="rounded-xl bg-warn/10 p-2.5 text-warn"><ShoppingCart className="h-5 w-5" /></span>
          </div>
          <p className="mt-4 flex items-center gap-1 text-[12px] text-ink-soft group-hover:text-primary">管理采购订单 <ArrowRight className="h-3.5 w-3.5" /></p>
        </Link>

        <Link href="/inventory" className="glass card-hover group p-5">
          <div className="flex items-start justify-between">
            <div><p className="text-[12px] text-ink-soft">在库台账成本</p><p className="mt-2 font-mono text-2xl font-bold tracking-tight text-ink-deep">{money(stats.inStockCost)}</p></div>
            <span className="rounded-xl bg-primary/10 p-2.5 text-primary"><CircleDollarSign className="h-5 w-5" /></span>
          </div>
          <p className="mt-4 text-[12px] text-ink-soft">保留 {stats.inventoryTotal} 份机器档案</p>
        </Link>

        <Link href="/orders" className="glass card-hover group p-5">
          <div className="flex items-start justify-between">
            <div><p className="text-[12px] text-ink-soft">产品库 SKU</p><p className="mt-2 font-mono text-3xl font-bold tracking-tight text-ink-deep">{stats.skuCount}</p></div>
            <span className="rounded-xl bg-primary/10 p-2.5 text-primary"><Package className="h-5 w-5" /></span>
          </div>
          <p className="mt-4 text-[12px] text-ink-soft">供应商 {stats.supplierCount} 家</p>
        </Link>
      </section>

      <section className="glass p-5" aria-label="销售出库概览"><div className="mb-4 flex flex-wrap items-center justify-between gap-2"><div><h2 className="text-[15px] font-semibold text-ink-deep">销售出库概览</h2><p className="mt-1 text-xs text-ink-soft">累计有效出库，不含撤销及换货重复交付；售后退款不冲减。</p></div><Link href="/sales/records" className="inline-flex items-center gap-1 text-xs font-medium text-primary">销售出库管理 <ArrowRight className="h-3.5 w-3.5" /></Link></div><dl className="grid grid-cols-2 gap-4 lg:grid-cols-4">{[['有效销售台数', stats.salesQuantity || 0], ['销售额', money(stats.salesAmount)], ['出库成本', money(stats.salesCost || 0)], ['出库毛利', money(stats.salesProfit)]].map(([label, value]) => <div key={label} className="rounded-xl bg-white/60 p-3"><dt className="text-xs text-ink-soft">{label}</dt><dd className="mt-2 font-mono text-xl font-semibold text-ink-deep">{value}</dd></div>)}</dl></section>
      <section className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1.55fr)_minmax(320px,0.9fr)]">
        <div className="glass overflow-hidden">
          <div className="flex items-center justify-between border-b border-line/70 px-5 py-4">
            <div><h2 className="text-[15px] font-semibold text-ink-deep">最近采购单</h2><p className="mt-1 text-[12px] text-ink-soft">按最近创建时间显示</p></div>
            <Link href="/orders" className="inline-flex items-center gap-1 text-[12px] font-medium text-primary hover:text-primary-deep">查看全部 <ArrowRight className="h-3.5 w-3.5" /></Link>
          </div>
          {loading ? (
            <div className="px-5 py-12 text-center text-[13px] text-ink-soft">加载中...</div>
          ) : recentOrders.length === 0 ? (
            <div className="px-5 py-12 text-center">
              <ClipboardList className="mx-auto h-8 w-8 text-ink-soft/40" />
              <p className="mt-3 text-[13px] text-ink-soft">还没有采购记录</p>
              <Link href="/orders" className="mt-3 inline-flex items-center gap-1 text-[12px] font-medium text-primary hover:text-primary-deep">创建第一张采购单 <ArrowRight className="h-3.5 w-3.5" /></Link>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table w-full min-w-[620px]">
                <thead><tr><th>采购单号</th><th>供应商</th><th>日期</th><th>数量</th><th>金额</th><th>状态</th></tr></thead>
                <tbody>
                  {recentOrders.map((order) => (
                    <tr key={order.id}>
                      <td><Link href="/orders" className="font-mono text-[12px] font-medium text-primary hover:text-primary-deep">{order.purchaseNo}</Link></td>
                      <td className="text-[13px]">{order.supplierName}</td>
                      <td className="font-mono text-[12px] text-ink-soft">{dateText(order.purchaseDate || order.createdAt)}</td>
                      <td className="font-mono text-[12px]">{order.totalQuantity}</td>
                      <td className="font-mono text-[12px]">{money(order.totalAmount)}</td>
                      <td><span className={`status-pill ${order.isInbounded ? 'ok' : 'warn'}`}><span className="status-dot" />{order.isInbounded ? '已入库' : '待处理'}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="glass overflow-hidden">
          <div className="flex items-center justify-between border-b border-line/70 px-5 py-4">
            <div><h2 className="text-[15px] font-semibold text-ink-deep">系统消息</h2><p className="mt-1 text-[12px] text-ink-soft">需要关注的业务状态</p></div>
            <Bell className="h-4 w-4 text-ink-soft" />
          </div>
          <div className="divide-y divide-line/60">
            {messages.map((message) => {
              const style = messageStyle(message.tone);
              const Icon = style.icon;
              return (
                <Link key={message.id} href={message.href} className="flex items-start gap-3 px-5 py-4 transition-colors hover:bg-white/60">
                  <span className={`mt-0.5 rounded-lg p-2 ${style.className}`}><Icon className="h-4 w-4" /></span>
                  <span className="min-w-0 flex-1"><span className="block text-[13px] font-medium text-ink-deep">{message.title}</span><span className="mt-1 block text-[12px] leading-relaxed text-ink-soft">{message.detail}</span></span>
                  <ArrowRight className="mt-2 h-3.5 w-3.5 shrink-0 text-ink-soft" />
                </Link>
              );
            })}
          </div>
        </div>
      </section>

      <section className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="glass p-5">
          <div className="flex items-center justify-between">
            <div><h2 className="text-[15px] font-semibold text-ink-deep">库存状态</h2><p className="mt-1 text-[12px] text-ink-soft">当前库存记录分布</p></div>
            <Link href="/inventory" className="text-[12px] font-medium text-primary hover:text-primary-deep">库存清单</Link>
          </div>
          <div className="mt-5 grid grid-cols-3 gap-3">
            <div className="rounded-xl bg-ok/8 px-3 py-3"><p className="text-[11px] text-ink-soft">在库</p><p className="mt-1 font-mono text-xl font-bold text-ok">{stats.inStock}</p></div>
            <div className="rounded-xl bg-primary/8 px-3 py-3"><p className="text-[11px] text-ink-soft">已售</p><p className="mt-1 font-mono text-xl font-bold text-primary">{stats.sold}</p></div>
            <div className="rounded-xl bg-danger/8 px-3 py-3"><p className="text-[11px] text-ink-soft">供应商退货中</p><p className="mt-1 font-mono text-xl font-bold text-danger">{stats.returning}</p></div>
          </div>
        </div>

        <div className="glass p-5">
          <div className="flex items-center justify-between">
            <div><h2 className="text-[15px] font-semibold text-ink-deep">快捷操作</h2><p className="mt-1 text-[12px] text-ink-soft">直接进入常用业务流程</p></div>
            <Truck className="h-4 w-4 text-ink-soft" />
          </div>
          <div className="mt-5 grid grid-cols-1 gap-2 sm:grid-cols-3">
            <Link href="/orders" className="group flex items-center gap-2 rounded-xl border border-line bg-white/50 px-3 py-3 text-[12px] text-ink-deep transition-colors hover:border-primary/30 hover:bg-white"><ShoppingCart className="h-4 w-4 text-primary" />采购入库<ArrowRight className="ml-auto h-3.5 w-3.5 text-ink-soft group-hover:text-primary" /></Link>
            <Link href="/sales/out" className="group flex items-center gap-2 rounded-xl border border-line bg-white/50 px-3 py-3 text-[12px] text-ink-deep transition-colors hover:border-primary/30 hover:bg-white"><ArrowDownToLine className="h-4 w-4 text-primary" />销售出库<ArrowRight className="ml-auto h-3.5 w-3.5 text-ink-soft group-hover:text-primary" /></Link>
            <Link href="/inventory" className="group flex items-center gap-2 rounded-xl border border-line bg-white/50 px-3 py-3 text-[12px] text-ink-deep transition-colors hover:border-primary/30 hover:bg-white"><Package className="h-4 w-4 text-primary" />库存台账<ArrowRight className="ml-auto h-3.5 w-3.5 text-ink-soft group-hover:text-primary" /></Link>
          </div>
        </div>
      </section>
    </div>
  );
}
