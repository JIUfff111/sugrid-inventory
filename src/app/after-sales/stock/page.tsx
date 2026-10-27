'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { RefreshCw } from 'lucide-react';
import CustomSelect from '@/components/CustomSelect';
import MachineSearchInput from '@/components/MachineSearchInput';
import { useWorkspace } from '@/components/WorkspaceContext';
import { formatProductName } from '@/lib/product-name';

type Stock = { id: string; inventoryId: string; afterSaleNo: string; sn: string; brand: string; model: string; year: number | null; customerName: string; customerPhone: string; issueType: string; receivedAt: string; stockStatus: string; note: string | null };
const labels: Record<string, string> = { stored: '暂存中', released: '已归还客户', restocked: '已转正式库存', exchanged_out: '已换出', scrapped: '已报废' };
export function AfterSalesStockWorkspace({ initialSearch = '', onOpenAfterSale }: { initialSearch?: string; onOpenAfterSale: (afterSaleNo: string) => void }) {
  const { active } = useWorkspace();
  const [checkedAt, setCheckedAt] = useState(0);
  const [rows, setRows] = useState<Stock[]>([]); const [search, setSearch] = useState(initialSearch); const [status, setStatus] = useState('stored'); const [loading, setLoading] = useState(true); const [error, setError] = useState('');
  const load = useCallback(async () => { setLoading(true); setError(''); try { const response = await fetch('/api/after-sales/stock?search=' + encodeURIComponent(search), { cache: 'no-store' }); const result = await response.json(); if (!response.ok || !result.success) throw new Error(result.error?.message || '加载暂存库失败'); setCheckedAt(Date.now()); setRows(result.data || []); } catch (error) { setError(error instanceof Error ? error.message : '加载失败'); } finally { setLoading(false); } }, [search]);
  useEffect(() => { if (!active) return; const timer = window.setTimeout(() => void load(), 250); return () => window.clearTimeout(timer); }, [active, load]);
  const filtered = rows.filter(row => !status || row.stockStatus === status);
  return <div className="mx-auto max-w-[1400px] space-y-5 pb-8"><header className="flex flex-wrap items-end justify-between gap-3"><div><h2 className="text-base font-semibold text-ink-deep">暂存机器</h2><p className="mt-1 text-xs text-ink-soft">收到的售后机器单独暂存，不计入正式库存；超过24小时未完成会提醒。</p></div></header><div className="grid gap-3 sm:grid-cols-2"><div className="glass p-4"><p className="text-xs text-ink-soft">当前暂存</p><p className="mt-1 text-xl font-semibold text-ink-deep">{rows.filter(row => row.stockStatus === 'stored').length} 台</p></div><div className="glass p-4"><p className="text-xs text-ink-soft">超过24小时未完成</p><p className="mt-1 text-xl font-semibold text-danger">{rows.filter(row => row.stockStatus === 'stored' && checkedAt - new Date(row.receivedAt.replace(' ', 'T')).getTime() > 86400000).length} 台</p></div></div><section className="glass overflow-hidden"><div className="flex flex-wrap gap-3 border-b border-line/70 p-4"><MachineSearchInput value={search} onChange={setSearch} endpoint="/api/inventory/lookup?context=inventory" onSelect={item => setSearch(item.sn)} onSearch={setSearch} placeholder="搜索售后单号、SN 后四位、品牌或型号" ariaLabel="搜索售后暂存机器" className="min-w-48 flex-1" /><div className="w-44"><CustomSelect value={status} onChange={setStatus} options={[{ value: '', label: '全部暂存状态' }, ...Object.entries(labels).map(([value, label]) => ({ value, label }))]} /></div><button type="button" className="btn-ghost" aria-label="刷新暂存库" disabled={loading} onClick={() => void load()}><RefreshCw className={'h-4 w-4 ' + (loading ? 'animate-spin' : '')} /></button></div>{error && <p role="alert" className="m-4 rounded-xl bg-danger/5 p-3 text-sm text-danger">{error}</p>}<div className="overflow-x-auto"><table className="w-full min-w-[800px] text-left text-xs"><thead className="bg-white/35 text-ink-soft"><tr>{['机器 / SN', '售后单号', '客户', '收机时间', '暂存状态', '处理入口'].map(label => <th key={label} className="px-4 py-3 font-medium">{label}</th>)}</tr></thead><tbody className="divide-y divide-line/60">{filtered.map(row => { const overdue = row.stockStatus === 'stored' && checkedAt - new Date(row.receivedAt.replace(' ', 'T')).getTime() > 86400000; return <tr key={row.id} className="transition hover:bg-white/40"><td className="p-4"><p className="font-medium text-ink-deep">{formatProductName(row)}</p><p className="mt-1 font-mono text-ink-soft">{row.sn}</p></td><td className="p-4 font-mono">{row.afterSaleNo}</td><td className="p-4">{row.customerName}<p className="mt-1 text-ink-soft">{row.customerPhone}</p></td><td className="p-4">{row.receivedAt.replace('T', ' ').slice(0, 16)}{overdue && <p className="mt-1 text-danger">超过24小时未完成</p>}</td><td className="p-4"><span className={'status-pill ' + (row.stockStatus === 'stored' ? 'warn' : 'ok')}>{labels[row.stockStatus] || row.stockStatus}</span></td><td className="p-4"><button type="button" onClick={() => onOpenAfterSale(row.afterSaleNo)} className="text-primary hover:underline">查看售后单</button></td></tr>; })}</tbody></table></div>{!filtered.length && <p className="p-12 text-center text-sm text-ink-soft">{loading ? '正在加载暂存记录...' : '暂无符合条件的暂存记录'}</p>}</section></div>;
}

export default function AfterSaleStockPage() {
  const router = useRouter();
  const { searchParams } = useWorkspace();
  useEffect(() => {
    const search = searchParams.get('search');
    const params = new URLSearchParams({ view: 'stock' });
    if (search) params.set('search', search);
    router.replace('/after-sales?' + params.toString());
  }, [router, searchParams]);
  return <div className="p-8 text-sm text-ink-soft">正在打开售后工作台…</div>;
}
