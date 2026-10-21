"use client";

import { useEffect, useRef } from "react";
import { useWorkspace } from '@/components/WorkspaceContext';

interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  width?: string;
}

/**
 * 抽屉组件 - 从右侧滑入的玻璃拟态面板
 * 支持遮罩点击关闭、ESC 键关闭、流畅动画
 */
export default function Drawer({ open, onClose, title, children, width = "680px" }: DrawerProps) {
  const { active } = useWorkspace();
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || !active) return;

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };

    document.addEventListener("keydown", handleEscape);
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", handleEscape);
      document.body.style.overflow = "";
    };
  }, [active, open, onClose]);

  if (!open || !active) return null;

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-stretch justify-end drawer-overlay"
      onClick={(e) => {
        if (e.target === overlayRef.current) onClose();
      }}
    >
      {/* 遮罩层 */}
      <div className="absolute inset-0 bg-black/30 backdrop-blur-[2px] drawer-backdrop" />

      {/* 抽屉面板 */}
      <aside
        className="relative flex flex-col bg-white/95 backdrop-blur-xl shadow-2xl drawer-panel"
        style={{ width, maxWidth: "90vw" }}
      >
        {/* 头部 */}
        <header className="shrink-0 flex items-center justify-between px-8 py-5 border-b border-line/40">
          <h2 className="text-lg font-bold tracking-wide">{title}</h2>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-lg hover:bg-ink-soft/8 transition-colors flex items-center justify-center ripple-hover"
            aria-label="关闭"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        </header>

        {/* 内容区 */}
        <div className="flex-1 overflow-y-auto px-8 py-6">{children}</div>
      </aside>
    </div>
  );
}
