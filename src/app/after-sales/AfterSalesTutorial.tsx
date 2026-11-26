'use client';

import { useEffect, useState } from 'react';
import {
  ArrowDownToLine, ArrowUpFromLine, Check, ChevronLeft, ChevronRight, ClipboardCheck,
  Film, LockKeyhole, PackageCheck, Pause, Play, RotateCcw, ScanLine,
} from 'lucide-react';
import BusinessDialog from '@/components/BusinessDialog';

const chapters = [
  {
    title: '登记并收原机',
    duration: 9000,
    icon: PackageCheck,
    action: '确认收到原机',
    text: '点「登记售后」，选已售原机 A，处理方式选「换货」，再点「创建售后单」。寄回运单可按实际情况填写。',
    tip: '从「待收原机」找到该单，核对收到的实物 SN，再点「确认收到原机」。机器状况可稍后补录。',
    original: '尚未签收',
    originalResult: '已签收 · 售后暂存',
    replacement: '尚未预留',
    replacementResult: '尚未预留',
    outcome: '下一步：选择替换机',
  },
  {
    title: '预留替换机',
    duration: 8000,
    icon: LockKeyhole,
    action: '预留这台替换机',
    text: '在同一张换货单里，搜索或扫描库存机 B，核对 SN 后点「预留这台替换机」。',
    tip: 'B 仍在仓，其他业务不能占用。发货前可在「更多操作」更换替换机或解除预留。',
    original: '在售后暂存',
    originalResult: '在售后暂存',
    replacement: '已选中 · 等待预留',
    replacementResult: '已预留 · 未出库',
    outcome: '下一步：等待实际发货',
  },
  {
    title: '登记替换机发货',
    duration: 9000,
    icon: ScanLine,
    action: '登记已发货并出库',
    text: '实际寄出后，扫描或输入实物 B 的 SN，填写寄给客户的运单号，再确认发货并出库。',
    tip: '错扫 SN 或误填客户寄回的运单号都会被拦截。只有 B 出库，原机 A 仍在售后暂存。',
    original: '在售后暂存',
    originalResult: '在售后暂存',
    replacement: '已预留 · 未出库',
    replacementResult: '已登记发货 · 已出库',
    outcome: '替换机已出库 · 原机待处置',
  },
  {
    title: '处置原机',
    duration: 8000,
    icon: ClipboardCheck,
    action: '检查合格后将原机入库',
    text: '从「原机待处置」打开同一张换货单。仍需检修时，原机 A 可以继续放在售后暂存。',
    tip: '检查合格后，填写入库检查结果，再单独确认 A 入库。发货后也可用「仅看售后暂存」查找仍在暂存的原机。',
    original: '仍可继续暂存',
    originalResult: '检查合格 · 已转正式库存',
    replacement: '已出库 · 寄给客户',
    replacementResult: '已出库 · 寄给客户',
    outcome: '此次换货处理完成',
  },
] as const;

const chapterStarts = chapters.map((_, index) => chapters.slice(0, index).reduce((total, chapter) => total + chapter.duration, 0));
const lastChapter = chapters.length - 1;
const duration = chapterStarts[lastChapter] + chapters[lastChapter].duration;
const clockText = (ms: number) => `0:${String(Math.floor(ms / 1000)).padStart(2, '0')}`;
const controlClass = 'inline-flex min-h-10 items-center justify-center gap-1.5 rounded-xl px-3 text-xs font-semibold outline-offset-2 transition hover:bg-primary/10 hover:text-primary motion-safe:active:scale-[0.97] disabled:opacity-40';

export default function AfterSalesTutorial({ onClose }: { onClose: () => void }) {
  const [playback, setPlayback] = useState({ elapsed: 0, playing: false });
  const chapterIndex = chapterStarts.reduce((current, start, index) => playback.elapsed >= start ? index : current, 0);
  const chapter = chapters[chapterIndex];
  const localTime = playback.elapsed - chapterStarts[chapterIndex];
  const completed = playback.elapsed >= duration;
  const acted = (!playback.playing && localTime === 0) || localTime >= 1900;
  const ChapterIcon = chapter.icon;

  useEffect(() => {
    if (!playback.playing) return;
    let previousTime = performance.now();
    const timer = window.setInterval(() => {
      const now = performance.now();
      const increment = now - previousTime;
      previousTime = now;
      setPlayback(current => {
        if (!current.playing) return current;
        const elapsed = Math.min(duration, current.elapsed + increment);
        return { elapsed, playing: elapsed < duration };
      });
    }, 125);
    const pauseWhenHidden = () => {
      if (document.hidden) setPlayback(current => ({ ...current, playing: false }));
    };
    document.addEventListener('visibilitychange', pauseWhenHidden);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', pauseWhenHidden); };
  }, [playback.playing]);

  const jumpTo = (index: number) => setPlayback({ elapsed: chapterStarts[index], playing: false });
  const togglePlayback = () => setPlayback(current => ({
    elapsed: current.elapsed >= duration ? 0 : current.elapsed,
    playing: !current.playing,
  }));

  return <BusinessDialog title="售后流程教程" description="换货操作演示 · 约半分钟 · 可逐步查看" onClose={onClose} footer={
    <>
      {chapterIndex !== lastChapter && <button type="button" className="btn-ghost mr-auto" onClick={onClose}>跳过教程</button>}
      <button type="button" className="btn-ghost inline-flex items-center gap-1" disabled={chapterIndex === 0} onClick={() => jumpTo(chapterIndex - 1)}>
        <ChevronLeft aria-hidden="true" className="h-4 w-4" />上一步
      </button>
      {chapterIndex < lastChapter
        ? <button type="button" className="btn-primary inline-flex items-center gap-1" onClick={() => jumpTo(chapterIndex + 1)}>下一步<ChevronRight aria-hidden="true" className="h-4 w-4" /></button>
        : <button type="button" className="btn-primary" onClick={onClose}>完成教程</button>}
    </>
  }>
    <div className="space-y-4">
      <div className="overflow-hidden rounded-2xl border border-line bg-white">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/15 bg-ink-deep px-4 py-2 text-white sm:px-5">
          <p className="inline-flex items-center gap-2 text-xs font-semibold"><Film aria-hidden="true" className="h-4 w-4 text-blue-200" />换货操作演示</p>
          <span className="rounded-full border border-white/20 px-2 py-0.5 text-[11px] text-blue-100">模拟画面 · 不修改工单</span>
        </div>
        <div className="bg-gradient-to-br from-blue-50 to-white px-3 py-3 sm:px-5 sm:py-4" aria-hidden="true">
          <div key={chapterIndex} className="space-y-2.5 motion-safe:animate-fade-in">
            <div className="grid gap-2 sm:grid-cols-2">
              <MachineFrame direction="in" serial="DEMO-A01" status={acted ? chapter.originalResult : chapter.original} active={chapterIndex === 0 || chapterIndex === 3} />
              <MachineFrame direction="out" serial={chapterIndex > 0 ? 'DEMO-B02' : '—'} status={acted ? chapter.replacementResult : chapter.replacement} active={chapterIndex === 1 || chapterIndex === 2} />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2.5 rounded-xl border border-primary/15 bg-white p-2.5 sm:px-3.5">
              <span className="inline-flex items-center gap-2 text-xs font-medium text-ink-deep">
                <ChapterIcon className="h-4 w-4 shrink-0 text-primary" />{acted ? chapter.outcome : '在当前工单继续'}
              </span>
              <span className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11px] font-semibold text-white motion-safe:transition-colors ${acted ? 'bg-ink-deep' : 'bg-primary'}`}>
                {acted && <Check className="h-3.5 w-3.5" />}{chapter.action}
              </span>
            </div>
          </div>
        </div>
        <div className="border-t border-line bg-white px-3 py-2.5 sm:px-4">
          <div role="group" aria-label="教程章节" className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
            {chapters.map((item, index) => {
              const progress = Math.max(0, Math.min(1, (playback.elapsed - chapterStarts[index]) / item.duration));
              const current = index === chapterIndex;
              return <button key={item.title} type="button" aria-current={current ? 'step' : undefined} onClick={() => jumpTo(index)}
                className={`grid min-w-0 gap-1 rounded-lg border px-2 py-1.5 text-left text-[11px] font-semibold outline-offset-1 transition-colors ${current ? 'border-primary/25 bg-primary/5 text-primary' : 'border-transparent text-ink-soft hover:bg-slate-50 hover:text-ink-deep'}`}>
                <span aria-hidden="true" className="h-1 overflow-hidden rounded-full bg-slate-200"><span className="block h-full rounded-full bg-primary motion-safe:transition-[width] motion-safe:duration-150" style={{ width: `${progress * 100}%` }} /></span>
                <span className="leading-4"><span aria-hidden="true" className="mr-1 tabular-nums">{index + 1}</span>{item.title}</span>
              </button>;
            })}
          </div>
          <div className="mt-1.5 flex items-center gap-1">
            <button type="button" className={controlClass} onClick={togglePlayback}>
              {playback.playing ? <Pause aria-hidden="true" className="h-4 w-4" /> : completed ? <RotateCcw aria-hidden="true" className="h-4 w-4" /> : <Play aria-hidden="true" className="h-4 w-4" />}
              {playback.playing ? '暂停播放' : completed ? '重新播放' : '播放演示'}
            </button>
            {playback.elapsed > 0 && !completed && <button type="button" aria-label="从头播放" title="从头播放" className={controlClass} onClick={() => setPlayback({ elapsed: 0, playing: true })}><RotateCcw aria-hidden="true" className="h-4 w-4" /></button>}
            <span aria-hidden="true" className="ml-auto font-mono text-[11px] text-ink-soft">{clockText(playback.elapsed)} / {clockText(duration)}</span>
          </div>
        </div>
      </div>
      <section aria-live="polite" aria-atomic="true" className="space-y-1.5 px-0.5">
        <h3 className="flex items-baseline gap-2 text-sm font-semibold text-ink-deep"><span className="font-mono text-xs text-primary">{String(chapterIndex + 1).padStart(2, '0')}</span>{chapter.title}</h3>
        <p className="text-sm leading-6 text-ink-deep">{chapter.text}</p>
        <p className="text-xs leading-5 text-ink-soft">{chapter.tip}</p>
      </section>
    </div>
  </BusinessDialog>;
}

function MachineFrame({ direction, serial, status, active }: {
  direction: 'in' | 'out'; serial: string; status: string; active: boolean;
}) {
  const inbound = direction === 'in';
  const Icon = inbound ? ArrowDownToLine : ArrowUpFromLine;
  return <div className={`min-w-0 rounded-xl border bg-white px-3 py-2.5 ${active ? 'border-primary/35 ring-1 ring-primary/10' : 'border-line'}`}>
    <div className="flex items-center gap-1.5 text-[11px] font-semibold text-ink-deep">
      <Icon className="h-3.5 w-3.5 shrink-0 text-primary" />{inbound ? '客户寄回 · 原机 A' : '寄给客户 · 替换机 B'}
    </div>
    <p className="mt-0.5 min-w-0 break-words font-mono text-xs font-semibold text-ink-deep">SN {serial}</p>
    <p className={`mt-0.5 text-[11px] ${active ? 'font-medium text-primary' : 'text-ink-soft'}`}>{status}</p>
  </div>;
}
