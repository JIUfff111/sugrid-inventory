'use client';

import { useEffect, useRef } from 'react';
import JsBarcode from 'jsbarcode';

type BarcodePreviewProps = {
  value: string;
  foreground?: string;
  background?: string;
  showText?: boolean;
  fontSize?: number;
  className?: string;
};

export default function BarcodePreview({
  value,
  foreground = '#111827',
  background = '#ffffff',
  showText = true,
  fontSize = 7,
  className,
}: BarcodePreviewProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const textRef = useRef<SVGSVGElement>(null);
  const errorRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!svgRef.current || !rootRef.current || !errorRef.current) return;
    const node = svgRef.current;
    const root = rootRef.current;
    const error = errorRef.current;
    let cancelled = false;
    root.dataset.barcodeStatus = 'loading';
    node.replaceChildren();
    node.style.display = 'block';
    error.style.display = 'none';
    try {
      if (!value) throw new Error('缺少 SN，无法生成条码');
      // CODE128 supports ASCII. Never remove, replace, or truncate a machine's SN.
      if (/[^\x00-\x7F]/.test(value)) throw new Error('SN 含 CODE128 不支持的字符');
      JsBarcode(node, value, {
        format: 'CODE128',
        lineColor: foreground,
        background,
        displayValue: false,
        // Keep ten narrow modules clear on either side of the symbol.
        margin: 0,
        marginLeft: 13.5,
        marginRight: 13.5,
        width: 1.35,
        height: 36,
      });
      const width = Number.parseFloat(node.getAttribute('width') || '0');
      const height = Number.parseFloat(node.getAttribute('height') || '0');
      if (!(width > 0 && height > 0)) throw new Error('条码生成失败');
      // Scale only the bars to the design frame. The human-readable SN below
      // uses its own text node so changes in bar proportions cannot distort it.
      node.setAttribute('viewBox', `0 0 ${width} ${height}`);
      node.setAttribute('preserveAspectRatio', 'none');
      node.removeAttribute('width');
      node.removeAttribute('height');
      const finishText = async () => {
        await document.fonts.ready;
        if (cancelled) return;
        const label = textRef.current;
        if (showText && label) {
          // Measure the font without depending on layout. The print portal is
          // hidden on screen, so its DOM width is zero until printing begins.
          const context = document.createElement('canvas').getContext('2d');
          if (!context) throw new Error('无法计算条码文字尺寸');
          context.font = `${fontSize}px Arial, sans-serif`;
          const metrics = context.measureText(value);
          const naturalWidth = Math.max(1, metrics.width, metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight) + 2;
          const textHeight = fontSize * 1.25;
          label.setAttribute('viewBox', `0 0 ${naturalWidth} ${textHeight}`);
          label.style.maxWidth = `${naturalWidth}px`;
          root.dataset.barcodeStatus = 'ready';
        } else {
          root.dataset.barcodeStatus = 'ready';
        }
      };
      void finishText().catch(() => {
        if (cancelled) return;
        error.textContent = '无法准备条码文字';
        error.style.display = 'flex';
        root.dataset.barcodeStatus = 'error';
      });
    } catch (cause) {
      node.replaceChildren();
      node.style.display = 'none';
      error.textContent = cause instanceof Error ? cause.message : 'SN 无法生成 CODE128 条码';
      error.style.display = 'flex';
      root.dataset.barcodeStatus = 'error';
    }
    return () => { cancelled = true; };
  }, [background, fontSize, foreground, showText, value]);

  return (
    <div
      ref={rootRef}
      className={className}
      data-barcode-status="loading"
      role="img"
      aria-label={`条码 ${value}`}
      title={value}
      style={{ display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0, color: foreground, background }}
    >
      <svg ref={svgRef} aria-hidden="true" style={{ width: '100%', flex: '1 1 0', minHeight: 0 }} />
      <span ref={errorRef} role="status" style={{ display: 'none', flex: '1 1 0', alignItems: 'center', justifyContent: 'center', fontSize: 8, lineHeight: 1.2, textAlign: 'center', color: '#b91c1c' }} />
      {showText && (
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', flex: '0 0 auto', minWidth: 0, height: `${fontSize * 1.25}px`, marginTop: 1 }}>
          <svg ref={textRef} aria-hidden="true" preserveAspectRatio="xMidYMid meet" style={{ display: 'block', width: '100%', height: `${fontSize * 1.25}px`, flexShrink: 1 }}>
            <text x="50%" y="50%" dominantBaseline="central" textAnchor="middle" fontSize={fontSize} fontFamily="Arial, sans-serif" fill={foreground} xmlSpace="preserve" style={{ whiteSpace: 'pre' }}>{value}</text>
          </svg>
        </div>
      )}
    </div>
  );
}
