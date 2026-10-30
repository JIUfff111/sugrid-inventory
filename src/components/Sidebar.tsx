"use client";

import Link from "next/link";
import { BrandLogo } from "@/components/Brand";
import { usePathname } from "next/navigation";
import { useState } from "react";

interface NavItem {
  label: string;
  href?: string;
  icon: string;
  badge?: string;
  children?: { label: string; href: string; icon: string }[];
}

const NAV: NavItem[] = [
  {
    label: "采购",
    icon: "M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z",
    children: [
      {
        label: "采购订单",
        href: "/orders",
        icon: "M2.05 2.05 1.099-.028a1 1 0 0 1 1.008.815l2.69 14.347A1 1 0 0 0 7.83 18H18M4.563 5h16.435a1 1 0 0 1 .981 1.204l-1.026 6.226A2 2 0 0 1 18.962 14H6.25M18 20a2 2 0 100-4 2 2 0 000 4zM8 20a2 2 0 100-4 2 2 0 000 4z",
      },
      { label: "供应商", href: "/suppliers", icon: "M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" },
      { label: "供应商退货", href: "/sales/return", icon: "M4 4v6h6M20 20v-6h-6M5.5 15a7 7 0 0012 2M18.5 9a7 7 0 00-12-2" },
    ],
  },
  {
    label: "库存",
    icon: "M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01",
    children: [
      { label: "在库清单", href: "/inventory", icon: "M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" },
      { label: "库存分析", href: "/inventory/analysis", icon: "M4 19V5m0 14h16M8 16v-5m4 5V7m4 9v-9" },
    ],
  },
  {
    label: "销售",
    badge: "v0.2",
    icon: "M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z",
    children: [
      { label: "销售出库", href: "/sales/out", icon: "M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" },
      { label: "销售渠道", href: "/sales/channels", icon: "M13 10V3L4 14h7v7l9-11h-7z" },
      { label: "售后处理", href: "/after-sales", icon: "M16 15v-1a4 4 0 00-4-4H8m0 0l3 3m-3-3l3-3m9 14V5a2 2 0 00-2-2H6a2 2 0 00-2 2v16l4-2 4 2 4-2 4 2z" },
    ],
  },
  {
    label: "设置",
    badge: "v0.2",
    icon: "M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z",
    children: [
      { label: "手工 SKU 库", href: "/settings/manual-skus", icon: "M4 5h16M4 12h16M4 19h10M7 5v14M17 16l2 2 4-4" },
      { label: "打印标签", href: "/settings/print", icon: "M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" }],
  },
];

export default function Sidebar() {
  const pathname = usePathname();
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    采购: true,
    库存: true,
    销售: true,
    设置: true,
  });

  const toggleSection = (label: string) => {
    setOpenSections((prev) => ({ ...prev, [label]: !prev[label] }));
  };

  return (
    <aside className="w-56 shrink-0 flex flex-col bg-white/60 backdrop-blur-xl border-r border-line/60">
      {/* Logo */}
      <div className="px-5 pt-5 pb-4 shrink-0">
        <BrandLogo />
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto px-3 pb-3">
        {NAV.map((section) => (
          <div key={section.label} className="mb-1">
            <button
              onClick={() => toggleSection(section.label)}
              className="w-full flex items-center gap-2 px-3 py-2.5 rounded-lg hover:bg-ink-soft/5 transition-colors group"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-ink-soft group-hover:text-primary transition-colors"
              >
                <path d={section.icon} />
              </svg>
              <span className="flex-1 text-left text-[13.5px] font-medium text-ink">{section.label}</span>
              {section.badge && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-ink-soft/10 text-ink-soft font-medium">
                  {section.badge}
                </span>
              )}
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className={`text-ink-soft transition-transform ${openSections[section.label] ? "rotate-180" : ""}`}
              >
                <path d="m6 9 6 6 6-6" />
              </svg>
            </button>

            {/* Children */}
            <div
              className={`collapse-wrap ${openSections[section.label] ? "open" : ""}`}
            >
              <div className="collapse-inner">
                <div className="ml-[22px] pl-3 border-l-2 border-line/60">
                  {section.children?.map((child) => (
                    <Link
                      key={child.href}
                      href={child.href}
                      className={`side-link gap-2 rounded-lg px-3 py-2 text-[13px] transition-all ripple-hover ${
                        pathname === child.href ? "active" : ""
                      }`}
                    >
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="15"
                        height="15"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="opacity-80"
                        aria-hidden="true"
                      >
                        <path d={child.icon} />
                      </svg>
                      {child.label}
                    </Link>
                  ))}
                </div>
              </div>
            </div>
          </div>
        ))}
      </nav>

      {/* User Info */}
      <div className="px-4 py-4 border-t border-line flex items-center gap-2.5">
        <div className="w-8 h-8 rounded-full bg-primary-soft text-primary flex items-center justify-center text-[13px] font-bold">
          U
        </div>
        <div className="min-w-0">
          <div className="text-[13px] font-medium truncate">当前用户</div>
          <div className="text-[11px] text-ink-soft">系统管理</div>
        </div>
      </div>
    </aside>
  );
}

