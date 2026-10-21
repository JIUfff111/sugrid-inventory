/**
 * 条码组件 —— 每台机器的"面单条码"
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
