'use client';

import { useEffect, useState, type HTMLAttributes } from 'react';
import BarcodePreview from '@/components/BarcodePreview';

export type LabelFieldKey = 'product' | 'config' | 'sn' | 'purchasePrice' | 'supplier' | 'inboundDate';
export type CanvasField = {
  key: LabelFieldKey;
  visible: boolean;
  order: number;
  fontSize: number;
  align: 'left' | 'center' | 'right';
  x?: number;
  y?: number;
};
export type CanvasElement = {
  id: string;
  type: 'line' | 'barcode';
  x: number;
  y: number;
  width: number;
  height: number;
  contentKey?: LabelFieldKey;
  style: {
    stroke?: string;
    strokeWidth?: number;
    lineStyle?: 'solid' | 'dashed' | 'dotted';
    foreground?: string;
    background?: string;
    showText?: boolean;
    fontSize?: number;
  };
};
type CanvasTemplate = {
  width: number;
  height: number;
  orientation: 'portrait' | 'landscape';
  layoutMode: 'flow' | 'free';
  fieldGap: number;
  fields: CanvasField[];
  elements: CanvasElement[];
};

const LABEL_FONT = '"DM Sans", "Noto Sans SC", sans-serif';
const PIXELS_PER_MM = 96 / 25.4;

export function labelDimensions(template: Pick<CanvasTemplate, 'width' | 'height' | 'orientation'>) {
  const short = Math.min(template.width, template.height);
  const long = Math.max(template.width, template.height);
  return template.orientation === 'portrait' ? { width: short, height: long } : { width: long, height: short };
}

/** Percentage boxes are shared by the editor and print output; following objects bound text height. */
export function labelFieldBox(field: CanvasField, template: CanvasTemplate) {
  const x = Math.max(0, Math.min(98, field.x ?? 4));
  const y = Math.max(0, Math.min(98, field.y ?? Math.min(92, 4 + field.order * 15)));
  const width = Math.max(1, Math.min(94, 98 - x));
  const boundaries = [
    ...template.fields.filter((other) => other.visible && other.key !== field.key).map((other) => ({
      x: other.x ?? 4,
      y: other.y ?? Math.min(92, 4 + other.order * 15),
      width: 94,
    })),
    ...template.elements,
  ].filter((other) => other.y > y + 1 && other.x < x + width && other.x + other.width > x);
  const bottom = Math.min(98, ...boundaries.map((other) => other.y - 1));
  return { x, y, width, height: Math.max(1, bottom - y) };
}

function FittedText({ text, width, height, fontSize, align }: {
  text: string;
  width: number;
  height: number;
  fontSize: number;
  align: CanvasField['align'];
}) {
  const [fit, setFit] = useState<{ signature: string; lines: string[]; size: number } | null>(null);
  const signature = JSON.stringify([text, width, height, fontSize]);

  useEffect(() => {
    let cancelled = false;
    void document.fonts.ready.then(() => {
      if (cancelled) return;
      const context = document.createElement('canvas').getContext('2d');
      if (!context) return;
      const wrap = (size: number) => {
        context.font = `${size}px ${LABEL_FONT}`;
        const lines: string[] = [];
        for (const paragraph of text.split('\n')) {
          let line = '';
          for (const character of Array.from(paragraph)) {
            if (line && context.measureText(line + character).width > width) {
              lines.push(line);
              line = character;
            } else line += character;
          }
          lines.push(line);
        }
        return lines;
      };
      let size = fontSize;
      let lines = wrap(size);
      // Keep the complete model/year and configuration inside their region.
      while (size > 1 && (lines.length * size * 1.2 > height || lines.some((line) => context.measureText(line).width > width))) {
        size = Math.max(1, size - 0.25);
        lines = wrap(size);
      }
      setFit({ signature, lines, size });
    });
    return () => { cancelled = true; };
  }, [fontSize, height, signature, text, width]);

  const ready = fit?.signature === signature;
  const size = ready ? fit.size : fontSize;
  const lines = ready ? fit.lines : [text];
  const x = align === 'center' ? width / 2 : align === 'right' ? width : 0;
  return (
    <svg width="100%" height="100%" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={text} data-label-text-status={ready ? 'ready' : 'pending'}>
      <title>{text}</title>
      <text fill="currentColor" fontFamily={LABEL_FONT} fontSize={size} textAnchor={align === 'center' ? 'middle' : align === 'right' ? 'end' : 'start'}>
        {lines.map((line, index) => <tspan key={index} x={x} y={size + index * size * 1.2}>{line}</tspan>)}
      </text>
    </svg>
  );
}

export default function LabelCanvas({ template, values, className = '', fieldProps, elementProps }: {
  template: CanvasTemplate;
  values: Record<LabelFieldKey, string>;
  className?: string;
  fieldProps?: (field: CanvasField) => HTMLAttributes<HTMLDivElement>;
  elementProps?: (element: CanvasElement) => HTMLAttributes<HTMLDivElement>;
}) {
  const size = labelDimensions(template);
  const fields = [...template.fields].filter((field) => field.visible).sort((a, b) => a.order - b.order);
  const free = template.layoutMode === 'free';
  return (
    <div className={`label-canvas relative shrink-0 overflow-hidden bg-white ${className}`} style={{ width: `${size.width}mm`, height: `${size.height}mm`, color: '#111111', fontFamily: LABEL_FONT, boxSizing: 'border-box', padding: free ? 0 : '2mm' }}>
      {fields.map((field) => {
        const box = labelFieldBox(field, template);
        return (
          <div key={field.key} data-label-field={field.key} {...fieldProps?.(field)} style={free
            ? { position: 'absolute', left: `${box.x}%`, top: `${box.y}%`, width: `${box.width}%`, height: `${box.height}%` }
            : { fontSize: `${field.fontSize}px`, textAlign: field.align, marginBottom: `${template.fieldGap}mm`, lineHeight: 1.2, overflowWrap: 'anywhere' }}>
            {free ? <FittedText text={values[field.key]} width={box.width / 100 * size.width * PIXELS_PER_MM} height={box.height / 100 * size.height * PIXELS_PER_MM} fontSize={field.fontSize} align={field.align} /> : values[field.key]}
          </div>
        );
      })}
      {free && template.elements.map((element) => (
        <div key={element.id} data-element-id={element.id} aria-label={element.type === 'line' ? '标签直线' : '标签条码'} {...elementProps?.(element)} style={{
          position: 'absolute', left: `${element.x}%`, top: `${element.y}%`, width: `${element.width}%`, height: `${element.height}%`,
          ...(element.type === 'line'
            ? { borderTop: `${element.style.strokeWidth || 1}px ${element.style.lineStyle || 'solid'} ${element.style.stroke || '#111111'}` }
            : { background: element.style.background || '#ffffff' }),
        }}>
          {element.type === 'barcode' && <BarcodePreview value={values[element.contentKey || 'sn']} foreground={element.style.foreground} background={element.style.background} showText={element.style.showText !== false} fontSize={element.style.fontSize || 7} className="h-full w-full" />}
        </div>
      ))}
      {fields.length === 0 && (!free || template.elements.length === 0) && <span className="absolute inset-0 flex items-center justify-center text-[11px]">尚未启用字段或设计元素</span>}
    </div>
  );
}
