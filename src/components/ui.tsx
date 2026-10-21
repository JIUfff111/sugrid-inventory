import type { CSSProperties } from "react";

type Tone = "ok" | "warn" | "danger" | "primary" | "neutral";

const TONE_MAP: Record<Tone, { fg: string; bg: string }> = {
  ok: { fg: "var(--color-ok)", bg: "color-mix(in srgb, var(--color-ok) 11%, white)" },
  warn: { fg: "var(--color-warn)", bg: "color-mix(in srgb, var(--color-warn) 12%, white)" },
  danger: { fg: "var(--color-danger)", bg: "color-mix(in srgb, var(--color-danger) 10%, white)" },
  primary: { fg: "var(--color-primary)", bg: "var(--color-primary-soft)" },
  neutral: { fg: "var(--color-ink-soft)", bg: "color-mix(in srgb, var(--color-ink-soft) 10%, white)" },
};

/** 状态胶囊：点 + 文字 */
export function StatusPill({ tone, text }: { tone: Tone; text: string }) {
  const t = TONE_MAP[tone];
  const style: CSSProperties = { color: t.fg, background: t.bg };
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-[5px] text-xs font-medium whitespace-nowrap"
      style={style}
    >
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: t.fg }} />
      {text}
    </span>
  );
}

/**
 * 条码（纯 CSS 条纹块）—— 每台机器的"面单条码"
 * 条纹图案由 IMEI 决定 hash 偏移，保证不同号码看起来有差异
 */
export function Barcode({ value }: { value: string }) {
  // 用号码生成条纹相位偏移，让不同 IMEI 的"条码"肉眼可辨
  let hash = 0;
  for (let i = 0; i < value.length; i++) hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  const shift = (hash % 17) + 1;
  return (
    <div className="select-none inline-flex flex-col gap-1.5">
      <div
        className="barcode-stripes w-[132px]"
        style={{
          backgroundImage: `repeating-linear-gradient(90deg,
            var(--color-ink) ${0 - shift}px ${2 - shift}px,
            transparent ${2 - shift}px ${5 - shift}px,
            var(--color-ink) ${5 - shift}px ${6 - shift}px,
            transparent ${6 - shift}px ${8 - shift}px,
            var(--color-ink) ${8 - shift}px ${11 - shift}px,
            transparent ${11 - shift}px ${14 - shift}px,
            var(--color-ink) ${14 - shift}px ${15 - shift}px,
            transparent ${15 - shift}px ${18 - shift}px,
            var(--color-ink) ${18 - shift}px ${20 - shift}px,
            transparent ${20 - shift}px ${24 - shift}px)`,
        }}
        aria-hidden
      />
      <div className="font-mono text-[11.5px] tracking-[0.12em] text-ink leading-none">
        {value}
      </div>
    </div>
  );
}
