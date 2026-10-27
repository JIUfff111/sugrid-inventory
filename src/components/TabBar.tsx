"use client";

import Link from "next/link";
import { X } from "lucide-react";

export interface Tab {
  id: string;
  label: string;
  href: string;
  pinned?: boolean;
}

interface TabBarProps {
  tabs?: Tab[];
  activeTabId?: string;
  onTabClose?: (id: string) => void;
  dirtyIds?: Set<string>;
  className?: string;
}

/**
 * 浏览器风格的标签栏
 * 支持多标签页导航和关闭
 */
export function TabBar({ tabs = [], activeTabId, onTabClose, dirtyIds, className = "" }: TabBarProps) {
  if (!tabs || tabs.length === 0) {
    return null;
  }

  return (
    <div className={`glass px-1.5 py-1.5 flex items-center gap-1 border-b border-line/50 ${className}`}>
      <div className="flex items-center gap-1 overflow-x-auto scrollbar-hide" role="tablist" aria-label="工作标签">
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          return (
            <div
              key={tab.id}
              className={`group/tab flex items-center gap-1.5 rounded-full pr-2 text-[13px] whitespace-nowrap select-none transition-all ${
                isActive
                  ? "bg-white/90 text-ink-deep font-medium shadow-sm"
                  : "text-ink-medium hover:bg-white/40 hover:text-ink-deep"
              }`}
            >
              <Link href={tab.href} role="tab" aria-selected={isActive} className="flex items-center gap-1.5 py-[7px] pl-3.5 no-underline outline-none focus-visible:ring-2 focus-visible:ring-primary/30 rounded-full">
                <span>{tab.label}</span>
                {dirtyIds?.has(tab.id) && <span className="h-1.5 w-1.5 rounded-full bg-primary" aria-label="有未保存内容" />}
              </Link>
              {onTabClose && !tab.pinned && (
                <button
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onTabClose(tab.id);
                  }}
                  className={`w-4 h-4 rounded-full flex items-center justify-center transition-colors ${
                    isActive
                      ? "hover:bg-ink-soft/10 text-ink-medium hover:text-ink-deep"
                      : "opacity-60 group-hover/tab:opacity-100 hover:bg-ink-soft/10 text-ink-soft hover:text-ink-deep"
                  }`}
                  aria-label={`关闭 ${tab.label}`}
                  type="button"
                >
                  <X className="w-3 h-3" strokeWidth={2.5} />
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
