"use client";

import { X } from "lucide-react";
import { useEffect, useId, useRef } from "react";
import { createPortal } from 'react-dom';
import { useWorkspace } from '@/components/WorkspaceContext';

interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  onConfirm: () => void;
  onCancel: () => void;
  danger?: boolean;
}

/**
 * 自定义确认对话框组件
 * 替代原生 confirm() 弹窗
 */
export default function ConfirmDialog({
  isOpen,
  title,
  message,
  confirmText = "确定",
  cancelText = "取消",
  onConfirm,
  onCancel,
  danger = false
}: ConfirmDialogProps) {
  const { active, user } = useWorkspace();
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!isOpen || !active) return;
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, [active, isOpen]);
  // ESC 键关闭
  useEffect(() => {
    if (!active || !isOpen) return;
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        e.stopPropagation();
        onCancel();
      }
      if (e.key === 'Tab' && isOpen) {
        const buttons = dialogRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
        if (!buttons?.length) return;
        const first = buttons[0];
        const last = buttons[buttons.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [active, isOpen, onCancel]);

  if (!isOpen || !active || typeof document === 'undefined') return null;

  return createPortal(
    <div 
      className="fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-black/30 backdrop-blur-sm animate-fade-in"
      style={{ top: user ? 100 : 0 }}
      onClick={onCancel}
    >
      <div 
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="glass max-w-md w-full rounded-2xl shadow-2xl animate-scale-in"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-6 pt-6 pb-4 border-b border-line/50">
          <h3 id={titleId} className="text-[15px] font-semibold text-ink-deep">{title}</h3>
          <button
            type="button"
            aria-label="关闭确认弹窗"
            onClick={onCancel}
            className="p-1.5 hover:bg-ink-soft/5 rounded-lg transition-colors"
          >
            <X className="w-4 h-4 text-ink-soft" />
          </button>
        </div>

        {/* 内容 */}
        <div className="px-6 py-5">
          <p className="text-[13px] text-ink leading-relaxed whitespace-pre-wrap">
            {message}
          </p>
        </div>

        {/* 操作按钮 */}
        <div className="flex items-center justify-end gap-3 px-6 pb-6">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 text-[13px] font-medium text-ink-deep hover:bg-ink-soft/5 
                     rounded-lg transition-all"
          >
            {cancelText}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={`px-4 py-2 text-[13px] font-medium text-white rounded-lg 
                     transition-all shadow-sm hover:shadow-md
                     ${danger 
                       ? 'bg-danger hover:bg-danger-hover' 
                       : 'bg-primary hover:bg-primary-hover'
                     }`}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>, document.body
  );
}
