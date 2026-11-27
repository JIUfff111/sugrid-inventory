'use client';

import { useEffect, useRef, useState } from 'react';
import {
  ArrowDownToLine, ArrowUpFromLine, BookOpen, Check, ChevronLeft, ChevronRight,
  ClipboardCheck, Film, Laptop, LockKeyhole, PackageCheck, Pause, Play,
  Receipt, Repeat2, RotateCcw, ScanLine, Wrench, type LucideIcon,
} from 'lucide-react';
import BusinessDialog from '@/components/BusinessDialog';

type Chapter = {
  title: string;
  duration: number;
  icon: LucideIcon;
  action: string;
  text: string;
  tip: string;
  original: [before: string, after: string];
  replacement?: [before: string, after: string];
  outcome: string;
};

type Demo = { label: string; description: string; icon: LucideIcon; chapters: Chapter[] };

const demos = {
  repair: {
    label: '维修', description: '修好后，把同一台机器归还客户。', icon: Wrench,
    chapters: [
      {
        title: '登记并收件', duration: 8000, icon: PackageCheck, action: '确认收件',
        text: '点「登记售后」，选已售机器和「维修」。客户寄回运单选填。收到实物后，在工单里核对 SN 并确认收件。',
        tip: '机器状况选填，可在拆包检查后补录。已收件的机器进入售后暂存。',
        original: ['未确认收到', '已收件 · 在售后暂存'], outcome: '下一步：开始维修',
      },
      {
        title: '开始维修', duration: 7000, icon: Wrench, action: '开始维修',
        text: '接手维修时，打开工单并确认开始。在详情里可补充检测结果和交接备注。',
        tip: '「维修中」是工单进度；「在售后暂存」是机器去向。两者可以同时成立。',
        original: ['待维修 · 在售后暂存', '维修中 · 在售后暂存'], outcome: '下一步：修好并归还客户',
      },
      {
        title: '确认归还客户', duration: 8000, icon: ArrowUpFromLine, action: '确认已归还客户',
        text: '修好并实际归还客户后，再在工单确认归还。',
        tip: '结单后这台机器退出售后暂存，恢复已售状态，不会变成可销售的在库机器。',
        original: ['维修中 · 在售后暂存', '已归还客户 · 恢复已售'], outcome: '维修办结',
      },
    ],
  },
  exchange: {
    label: '换货', description: '客户寄回原机，再寄出另一台机器。', icon: Repeat2,
    chapters: [
      {
        title: '登记并收原机', duration: 8000, icon: PackageCheck, action: '确认收到原机',
        text: '点「登记售后」，选已售原机 A 和「换货」，填已知的客户寄回运单后建单。',
        tip: '实际收到原机 A 并核对实物 SN 后确认收件。机器状况可稍后补录。',
        original: ['未确认收到', '已收件 · 在售后暂存'], replacement: ['未预留', '未预留'], outcome: '下一步：选择替换机',
      },
      {
        title: '预留替换机', duration: 7000, icon: LockKeyhole, action: '预留这台替换机',
        text: '在同一张换货工单里搜索或扫描库存机 B，核对 SN 后预留。',
        tip: 'B 仍在仓，其他业务不能占用。发货前可在「更多操作」更换替换机或解除预留。',
        original: ['在售后暂存', '在售后暂存'], replacement: ['已选中 · 待预留', '已预留 · 未出库'], outcome: '下一步：实际寄出替换机',
      },
      {
        title: '登记替换机发货', duration: 9000, icon: ScanLine, action: '登记已发货并出库',
        text: 'B 实际寄出后，扫入实物 B 的 SN，填写寄给客户的运单号，再确认发货。',
        tip: '系统会拦截 SN 不一致和错填客户寄回运单的情况。只有 B 出库，A 继续在售后暂存。',
        original: ['在售后暂存', '在售后暂存'], replacement: ['已预留 · 未出库', '已发货 · 已出库'], outcome: '下一步：检查并处置原机',
      },
      {
        title: '检查并处置原机', duration: 8000, icon: ClipboardCheck, action: '检查合格后将原机入库',
        text: '替换机发出后，从同一张工单看原机去向。原机 A 仍需检修时，可以继续留在售后暂存。',
        tip: '只有检查合格后，才填写检查结果、单独确认 A 转入正式库存。',
        original: ['待检查 · 在售后暂存', '检查合格 · 已转正式库存'], replacement: ['已出库 · 寄给客户', '已出库 · 寄给客户'], outcome: '换货和原机处置办结',
      },
    ],
  },
  refund: {
    label: '退货退款', description: '收到并核验退货后，在系统登记结果。', icon: Receipt,
    chapters: [
      {
        title: '先核对实物和退款结果', duration: 9000, icon: ClipboardCheck, action: '检查退回机器',
        text: '先实际收件，确认退回机器的 SN 与原销售记录一致，并检查机器符合入库条件。',
        tip: '在原销售渠道核实退款已处理。没收到机器、检验未通过或退款结果未核实，就不要完成下面的登记。',
        original: ['等待实际收件与核验', '实物已核对 · 检查合格'], outcome: '下一步：登记退款结果并入库',
      },
      {
        title: '登记退货退款并入库', duration: 9000, icon: Receipt, action: '确认并恢复库存',
        text: '点「登记售后」，选择「退货退款」和已售机器。客户寄回运单可选填，点「核对退款与入库」后再确认。',
        tip: '确认会直接完成工单并恢复到原仓库正式库存。系统只记录结果，不向客户打款。',
        original: ['已核验 · 待系统入库', '已恢复原仓库正式库存'], outcome: '可从「历史」查看办理结果',
      },
    ],
  },
} satisfies Record<string, Demo>;

type DemoId = keyof typeof demos;
const demoIds: DemoId[] = ['repair', 'exchange', 'refund'];
const controlClass = 'inline-flex min-h-10 items-center justify-center gap-1.5 rounded-xl px-3 text-xs font-semibold outline-offset-2 transition hover:bg-primary/10 hover:text-primary motion-safe:active:scale-[0.97] disabled:opacity-40';
const initialPlayback = { elapsed: 0, playing: false, manual: true };

export default function AfterSalesTutorial({ onClose }: { onClose: () => void }) {
  const [view, setView] = useState<DemoId | 'overview'>('overview');
  const [playback, setPlayback] = useState(initialPlayback);
  const topicContent = useRef<HTMLDivElement>(null);
  const focusNewTopic = useRef(false);
  const activeDemo = view !== 'overview' ? demos[view] : null;
  const chapterStarts = activeDemo?.chapters.map((_, index) => activeDemo.chapters.slice(0, index).reduce((sum, item) => sum + item.duration, 0)) ?? [];
  const lastChapter = activeDemo ? activeDemo.chapters.length - 1 : 0;
  const duration = activeDemo ? chapterStarts[lastChapter] + activeDemo.chapters[lastChapter].duration : 0;
  const chapterIndex = chapterStarts.reduce((current, start, index) => playback.elapsed >= start ? index : current, 0);
  const completed = playback.elapsed >= duration;
  const acted = playback.manual || playback.elapsed - chapterStarts[chapterIndex] >= 1400;

  useEffect(() => {
    if (!focusNewTopic.current) return;
    focusNewTopic.current = false;
    topicContent.current?.focus();
  }, [view]);

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
        return { elapsed, playing: elapsed < duration, manual: false };
      });
    }, 125);
    const pauseWhenHidden = () => {
      if (document.hidden) setPlayback(current => ({ ...current, playing: false }));
    };
    document.addEventListener('visibilitychange', pauseWhenHidden);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', pauseWhenHidden); };
  }, [playback.playing, duration]);

  function selectDemo(id: DemoId | 'overview') {
    if (id === view) return;
    focusNewTopic.current = true;
    setView(id);
    setPlayback(initialPlayback);
  }

  function jumpTo(index: number) {
    setPlayback({ elapsed: chapterStarts[index], playing: false, manual: true });
  }

  function togglePlayback() {
    setPlayback({ elapsed: completed ? 0 : playback.elapsed, playing: !playback.playing, manual: false });
  }

  return <BusinessDialog title="售后流程教程" description="看懂一张工单，再按业务类型查看操作演示。" onClose={onClose} footer={
    <>
      <button type="button" className="btn-ghost mr-auto" onClick={onClose}>跳过教程</button>
      {activeDemo && <button type="button" className="btn-ghost inline-flex items-center gap-1" disabled={chapterIndex === 0} onClick={() => jumpTo(chapterIndex - 1)}><ChevronLeft aria-hidden="true" className="h-4 w-4" />上一步</button>}
      <button type="button" className="btn-primary inline-flex items-center gap-1" onClick={activeDemo && chapterIndex < lastChapter ? () => jumpTo(chapterIndex + 1) : onClose}>
        {activeDemo && chapterIndex < lastChapter ? <>下一步<ChevronRight aria-hidden="true" className="h-4 w-4" /></> : activeDemo ? '完成教程' : '我知道了'}
      </button>
    </>
  }>
    <div className="space-y-4">
      {activeDemo && <div role="group" aria-label="教程类型" className="grid grid-cols-2 gap-1 rounded-xl border border-line bg-slate-50 p-1 sm:grid-cols-4">
        <TopicButton label="工单总览" icon={BookOpen} selected={false} onSelect={() => selectDemo('overview')} />
        {demoIds.map(id => <TopicButton key={id} label={demos[id].label} icon={demos[id].icon} selected={view === id} onSelect={() => selectDemo(id)} />)}
      </div>}
      <div ref={topicContent} tabIndex={-1} role="region" aria-label={activeDemo ? `${activeDemo.label}操作演示` : '工单总览'} className="focus:outline-none">
        {activeDemo ? <DemoPlayer key={view} demo={activeDemo} chapterIndex={chapterIndex} chapterStarts={chapterStarts}
          elapsed={playback.elapsed} duration={duration} playing={playback.playing} acted={acted}
          onChapterChange={jumpTo} onTogglePlayback={togglePlayback}
          onReplay={() => setPlayback({ elapsed: 0, playing: true, manual: false })} /> : <Overview onSelect={selectDemo} />}
      </div>
    </div>
  </BusinessDialog>;
}

function TopicButton({ label, icon: Icon, selected, onSelect }: { label: string; icon: LucideIcon; selected: boolean; onSelect: () => void }) {
  return <button type="button" aria-pressed={selected} onClick={onSelect} className={`inline-flex min-h-10 items-center justify-center gap-1.5 rounded-lg border px-2 text-xs font-semibold outline-offset-1 motion-safe:transition-colors ${selected ? 'border-primary/20 bg-white text-primary shadow-sm' : 'border-transparent text-ink-soft hover:bg-white hover:text-ink-deep'}`}>
    <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />{label}
  </button>;
}

function Overview({ onSelect }: { onSelect: (id: DemoId) => void }) {
  const example = [
    ['售后类型', '维修', '这张工单要办什么？'],
    ['当前进度', '待维修', '事情办到哪一步？'],
    ['机器去向', '在售后暂存', '机器现在在哪？'],
    ['下一步', '开始维修', '实际接手维修时再确认。'],
  ];
  return <section className="space-y-4 motion-safe:animate-fade-in">
    <div>
      <h3 className="text-sm font-semibold text-ink-deep">如何阅读一张售后单</h3>
      <p className="mt-1 text-xs leading-5 text-ink-soft">日常跟进进入「待办」，查已办结或已取消的单子进入「历史」。可按维修、换货、退货退款筛选。</p>
    </div>
    <div className="overflow-hidden rounded-xl border border-primary/15 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-1.5 border-b border-line bg-blue-50/75 px-3 py-2 text-ink-deep sm:px-4">
        <p className="inline-flex items-center gap-2 text-xs font-semibold"><Laptop aria-hidden="true" className="h-4 w-4 text-primary" />示例工单 · SN DEMO-R01</p>
        <p className="text-[11px] text-ink-soft">演示数据</p>
      </div>
      <dl className="grid grid-cols-2 gap-3 px-3 py-3 sm:grid-cols-4 sm:px-4">
        {example.map(([label, value, meaning]) => <div key={label} className="min-w-0">
          <dt className="text-[11px] font-medium text-ink-soft">{label}</dt>
          <dd className={`mt-1 text-xs font-semibold leading-5 ${label === '下一步' ? 'text-primary' : 'text-ink-deep'}`}>{value}</dd>
          <dd className="text-[11px] leading-4 text-ink-soft">{meaning}</dd>
        </div>)}
      </dl>
    </div>
    <p className="border-l-2 border-primary/30 pl-2.5 text-xs leading-5 text-ink-soft">同一张工单可以是「维修中」，机器同时「在售后暂存」。暂存是已收机器的去向，不是处理进度，也不算可售库存。</p>
    <div>
      <h3 className="mb-2 text-xs font-semibold text-ink-deep">选择一种业务，看操作演示</h3>
      <div className="grid gap-2 sm:grid-cols-3">
        {demoIds.map(id => {
          const { label, description, icon: Icon } = demos[id];
          return <button key={id} type="button" onClick={() => onSelect(id)} className="min-w-0 rounded-xl border border-line bg-white p-2.5 text-left outline-offset-2 hover:border-primary/35 hover:bg-blue-50/60 motion-safe:transition motion-safe:active:scale-[0.98]">
            <span className="flex items-center gap-1.5 text-xs font-semibold text-ink-deep"><Icon aria-hidden="true" className="h-4 w-4 shrink-0 text-primary" />{label}<ChevronRight aria-hidden="true" className="ml-auto h-3.5 w-3.5 shrink-0 text-primary" /></span>
            <span className="mt-1 block text-[11px] leading-4 text-ink-soft">{description}</span>
          </button>;
        })}
      </div>
    </div>
  </section>;
}

const clockText = (ms: number) => `0:${String(Math.floor(ms / 1000)).padStart(2, '0')}`;

function DemoPlayer({ demo, chapterIndex, chapterStarts, elapsed, duration, playing, acted, onChapterChange, onTogglePlayback, onReplay }: {
  demo: Demo; chapterIndex: number; chapterStarts: number[]; elapsed: number; duration: number; playing: boolean; acted: boolean;
  onChapterChange: (index: number) => void; onTogglePlayback: () => void; onReplay: () => void;
}) {
  const chapter = demo.chapters[chapterIndex];
  const completed = elapsed >= duration;
  const ChapterIcon = chapter.icon;

  return <section className="space-y-3 motion-safe:animate-fade-in">
    <div className="overflow-hidden rounded-xl border border-line bg-white">
      <div className="flex flex-wrap items-center justify-between gap-2 bg-ink-deep px-3 py-2 text-white sm:px-4">
        <h3 className="inline-flex items-center gap-2 text-xs font-semibold"><Film aria-hidden="true" className="h-4 w-4 text-blue-200" />{demo.label}操作演示</h3>
        <span className="text-[11px] text-blue-100">模拟操作 · 不修改工单</span>
      </div>
      <div className="bg-gradient-to-br from-blue-50 to-white p-3 sm:px-4" aria-hidden="true">
        <div key={chapterIndex} className="space-y-2 motion-safe:animate-fade-in">
          <div className={`grid gap-2 ${chapter.replacement ? 'sm:grid-cols-2' : ''}`}>
            <MachineFrame label={chapter.replacement ? '客户寄回 · 原机 A' : `${demo.label}机器`} serial={chapter.replacement ? 'DEMO-A01' : demo.label === '维修' ? 'DEMO-R01' : 'DEMO-T01'} status={chapter.original[acted ? 1 : 0]} icon={ArrowDownToLine} />
            {chapter.replacement && <MachineFrame label="寄给客户 · 替换机 B" serial={chapterIndex > 0 ? 'DEMO-B02' : '未选择'} status={chapter.replacement[acted ? 1 : 0]} icon={ArrowUpFromLine} />}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-primary/15 bg-white px-2.5 py-2.5">
            <span className="inline-flex items-center gap-2 text-xs font-medium text-ink-deep"><ChapterIcon className="h-4 w-4 shrink-0 text-primary" />{acted ? chapter.outcome : '当前步骤'}</span>
            <span className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-semibold text-white motion-safe:transition-colors ${acted ? 'bg-ink-deep' : 'bg-primary'}`}>{acted && <Check className="h-3.5 w-3.5" />}{chapter.action}</span>
          </div>
        </div>
      </div>
      <div className="border-t border-line px-2 py-2 sm:px-3">
        <div role="group" aria-label={`${demo.label}演示章节`} className={`grid grid-cols-2 gap-1 ${demo.chapters.length === 3 ? 'sm:grid-cols-3' : demo.chapters.length === 4 ? 'sm:grid-cols-4' : ''}`}>
          {demo.chapters.map((item, index) => {
            const progress = Math.max(0, Math.min(1, (elapsed - chapterStarts[index]) / item.duration));
            return <button key={item.title} type="button" aria-current={index === chapterIndex ? 'step' : undefined} onClick={() => onChapterChange(index)} className={`grid min-w-0 gap-1 rounded-md border px-2 py-1.5 text-left text-[11px] font-semibold outline-offset-1 motion-safe:transition-colors ${index === chapterIndex ? 'border-primary/25 bg-primary/5 text-primary' : 'border-transparent text-ink-soft hover:bg-slate-50 hover:text-ink-deep'}`}>
              <span aria-hidden="true" className="h-1 overflow-hidden rounded-full bg-slate-200"><span className="block h-full rounded-full bg-primary motion-safe:transition-[width] motion-safe:duration-150" style={{ width: `${progress * 100}%` }} /></span>
              <span className="leading-4"><span aria-hidden="true" className="mr-1 tabular-nums">{index + 1}</span>{item.title}</span>
            </button>;
          })}
        </div>
        <div className="mt-1 flex items-center gap-1">
          <button type="button" className={controlClass} onClick={onTogglePlayback}>
            {playing ? <Pause aria-hidden="true" className="h-4 w-4" /> : completed ? <RotateCcw aria-hidden="true" className="h-4 w-4" /> : <Play aria-hidden="true" className="h-4 w-4" />}
            {playing ? '暂停播放' : completed ? '重新播放' : '播放演示'}
          </button>
          {elapsed > 0 && !completed && <button type="button" aria-label="从头播放" title="从头播放" className={controlClass} onClick={onReplay}><RotateCcw aria-hidden="true" className="h-4 w-4" /></button>}
          <span aria-hidden="true" className="ml-auto font-mono text-[11px] text-ink-soft">{clockText(elapsed)} / {clockText(duration)}</span>
        </div>
      </div>
    </div>
    <section aria-live="polite" aria-atomic="true" className="space-y-1.5">
      <h4 className="flex items-baseline gap-2 text-sm font-semibold text-ink-deep"><span className="font-mono text-xs text-primary">{String(chapterIndex + 1).padStart(2, '0')}</span>{chapter.title}</h4>
      <p className="text-sm leading-6 text-ink-deep">{chapter.text}</p>
      <p className="text-xs leading-5 text-ink-soft">{chapter.tip}</p>
    </section>
  </section>;
}

function MachineFrame({ label, serial, status, icon: Icon }: { label: string; serial: string; status: string; icon: LucideIcon }) {
  return <div className="min-w-0 rounded-lg border border-primary/20 bg-white px-2.5 py-2">
    <div className="flex items-center gap-1.5 text-[11px] font-semibold text-ink-deep"><Icon className="h-3.5 w-3.5 shrink-0 text-primary" />{label}</div>
    <p className="mt-0.5 break-words font-mono text-xs font-semibold text-ink-deep">SN {serial}</p>
    <p className="mt-0.5 text-[11px] font-medium text-primary">{status}</p>
  </div>;
}
