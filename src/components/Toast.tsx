"use client";

import { CheckCircle, XCircle, AlertCircle, Info, X } from "lucide-react";
import { useEffect } from "react";

export type ToastType = 'success' | 'error' | 'warning' | 'info';

interface ToastProps {
  isOpen: boolean;
  type: ToastType;
  message: string;
  duration?: number;
  onClose: () => void;
}

/**
 * Toast 提示组件
 * 替代原生 alert() 弹窗
 */
export default function Toast({
  isOpen,
  type,
  message,
  duration = 3000,
  onClose
}: ToastProps) {
  // 自动关闭
  useEffect(() => {
    if (isOpen && duration > 0) {
      const timer = setTimeout(onClose, duration);
      return () => clearTimeout(timer);
    }
  }, [isOpen, duration, onClose]);

  if (!isOpen) return null;

  const icons = {
    success: <CheckCircle className="w-5 h-5 text-success" />,
    error: <XCircle className="w-5 h-5 text-danger" />,
    warning: <AlertCircle className="w-5 h-5 text-warning" />,
    info: <Info className="w-5 h-5 text-primary" />
  };

  const bgColors = {
    success: 'bg-success/10 border-success/20',
    error: 'bg-danger/10 border-danger/20',
    warning: 'bg-warning/10 border-warning/20',
    info: 'bg-primary/10 border-primary/20'
  };

  return (
    <div className="fixed top-4 right-4 z-[9999] animate-slide-in-right">
      <div className={`glass min-w-[320px] max-w-md rounded-xl shadow-lg border ${bgColors[type]} p-4`}>
        <div className="flex items-start gap-3">
          <div className="shrink-0 mt-0.5">
            {icons[type]}
          </div>
          <p className="flex-1 text-[13px] text-ink-deep leading-relaxed">
            {message}
          </p>
          <button
            onClick={onClose}
            className="shrink-0 p-1 hover:bg-ink-soft/10 rounded transition-colors"
          >
            <X className="w-4 h-4 text-ink-soft" />
          </button>
        </div>
      </div>
    </div>
  );
}
