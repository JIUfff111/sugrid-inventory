"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useEffect, useRef, type CSSProperties } from "react";
import { ChevronDown, House, LogOut, UserRound } from "lucide-react";
import { BrandLogo } from '@/components/Brand';
import { useRouter } from "next/navigation";
import { canVisit, type SessionUser } from "@/lib/access";

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
      { label: "租赁管理", href: "/rental", icon: "M3 7h18M5 7l1 13h12l1-13M9 7V4h6v3m-6 5h6" },
    ],
  },
  {
    label: "销售",
    badge: "v0.2",
    icon: "M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z",
    children: [
      { label: "销售出库", href: "/sales/out", icon: "M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" },
      { label: "销售出库管理", href: "/sales/records", icon: "M9 5H5v16h14V5h-4M9 3h6v4H9zM8 12h8m-8 4h5" },
      { label: "售后处理", href: "/after-sales", icon: "M12 8v4l3 2m6-2a9 9 0 11-18 0 9 9 0 0118 0z" },
      { label: "销售渠道", href: "/sales/channels", icon: "M13 10V3L4 14h7v7l9-11h-7z" },
    ],
  },
  {
    label: "财务",
    icon: "M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z",
    children: [],
  },
  {
    label: "文档",
    icon: "M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z",
    children: [],
  },
  {
    label: "设置",
    badge: "v0.2",
    icon: "M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z",
    children: [{ label: "账号与权限", href: "/settings/users", icon: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M20 8v6m-3-3h6" }, { label: "仓库管理", href: "/warehouses", icon: "M3 21V7l9-4 9 4v14M9 21V12h6v9M3 9h18" }, { label: "标签设计", href: "/settings/print", icon: "M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" }],
  },
];

export default function TopNav({ user }: { user: SessionUser }) {
  const router = useRouter();
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState('');
  async function logout() {
    setLoggingOut(true);
    setLogoutError('');
    try {
      const response = await fetch("/api/auth/logout", { method: "POST", signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error();
      for (const key of Object.keys(sessionStorage)) if (key.startsWith('app_tabs:')) sessionStorage.removeItem(key);
      router.replace("/login"); router.refresh();
    } catch { setLogoutError('退出失败，请检查连接后重试'); } finally { setLoggingOut(false); }
  }
  const pathname = usePathname();
  const [openDropdown, setOpenDropdown] = useState<string | null>(null);
  const [hoveredDropdown, setHoveredDropdown] = useState<string | null>(null);
  const [menuPosition, setMenuPosition] = useState({ left: 12, top: 56 });
  const [isScrolled, setIsScrolled] = useState(false);
  const navRef = useRef<HTMLElement>(null);
  const hoverCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverOpenTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const visibleDropdown = hoveredDropdown ?? openDropdown;
  const cancelHoverOpen = () => {
    if (hoverOpenTimer.current) clearTimeout(hoverOpenTimer.current);
    hoverOpenTimer.current = null;
  };
  const cancelHoverClose = () => {
    if (hoverCloseTimer.current) clearTimeout(hoverCloseTimer.current);
    hoverCloseTimer.current = null;
  };
  const scheduleHoverClose = (label: string) => {
    cancelHoverOpen();
    if (openDropdown === label) return;
    cancelHoverClose();
    hoverCloseTimer.current = setTimeout(() => {
      setHoveredDropdown(current => current === label ? null : current);
      hoverCloseTimer.current = null;
    }, 180);
  };
  useEffect(() => () => {
    if (hoverCloseTimer.current) clearTimeout(hoverCloseTimer.current);
    if (hoverOpenTimer.current) clearTimeout(hoverOpenTimer.current);
  }, []);

  // 监听滚动事件
  useEffect(() => {
    const handleScroll = () => {
      setIsScrolled(window.scrollY > 20);
    };
    
    window.addEventListener('scroll', handleScroll);
    const handleResize = () => { cancelHoverOpen(); cancelHoverClose(); setOpenDropdown(null); setHoveredDropdown(null); };
    window.addEventListener('resize', handleResize);
    return () => { window.removeEventListener('scroll', handleScroll); window.removeEventListener('resize', handleResize); };
  }, []);

  // Close an open menu when the user clicks elsewhere or presses Escape.
  useEffect(() => {
    if (!visibleDropdown) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && !navRef.current?.contains(target)) {
        cancelHoverOpen();
        cancelHoverClose();
        setOpenDropdown(null);
        setHoveredDropdown(null);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        cancelHoverOpen();
        cancelHoverClose();
        setOpenDropdown(null);
        setHoveredDropdown(null);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [visibleDropdown]);

  useEffect(() => {
    setOpenDropdown(null);
    setHoveredDropdown(null);
  }, [pathname]);

  // 判断当前路由是否在某个分组下
  const isActive = (item: NavItem) => {
    if (item.children) {
      return item.children.some(child => pathname === child.href || pathname.startsWith(`${child.href}/`));
    }
    return false;
  };

  return (
    <nav
      ref={navRef}
      style={{ '--nav-menu-left': `${menuPosition.left}px`, '--nav-menu-top': `${menuPosition.top}px` } as CSSProperties}
      className={`sticky top-0 z-[2000] isolate w-full overflow-visible transition-[background-color,box-shadow] duration-300 ${
        isScrolled 
          ? 'bg-white/95 backdrop-blur-xl shadow-sm border-b border-line/30' 
          : 'bg-white/80 backdrop-blur-md'
      }`}
    >
      <div className="max-w-[1600px] mx-auto px-3 sm:px-6">
        <div className="flex h-14 min-w-0 items-center justify-between gap-1">
          {/* Logo */}
          <Link href={user.role === 'admin' ? '/' : '/inventory'} aria-label="溯格 SUGRID 返回首页" className="flex shrink-0 items-center rounded-lg transition-transform hover:scale-[1.02] active:scale-[.98]">
            <BrandLogo className="[&>span:first-child]:h-9 [&>span:first-child]:w-9 [&>span:last-child]:hidden min-[480px]:[&>span:last-child]:flex [&>span:last-child>span:first-child]:text-[17px]" />
          </Link>

          {/* 主导航 */}
          <div className="flex shrink-0 items-center gap-0.5 lg:gap-1">
            {user.role === 'admin' && <Link href="/" aria-current={pathname === '/' ? 'page' : undefined} className={`flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-2 text-[12px] font-medium transition-colors lg:gap-2 lg:px-3 lg:text-[13px] ${pathname === '/' ? 'bg-primary/8 text-primary' : 'text-ink hover:bg-white/60 hover:text-ink-deep'}`}><House className="h-4 w-4" /><span>首页</span></Link>}
            {NAV.map(item => ({ ...item, children: item.children?.filter(child => canVisit(user.role, child.href)) })).filter(item => item.children?.length).map((item) => {
              const active = isActive(item);
              const children = item.children ?? [];
              const hasChildren = children.length > 0;

              return (
                <div
                  key={item.label}
                  className={"nav-item relative shrink-0" + (hasChildren ? "" : " hidden sm:block") + (visibleDropdown === item.label ? " is-open" : "")}
                  onMouseEnter={(event) => {
                    if (hasChildren) {
                      cancelHoverClose();
                      cancelHoverOpen();
                      const rect = event.currentTarget.getBoundingClientRect();
                      const open = () => {
                        setMenuPosition({ left: rect.left, top: rect.bottom });
                        setHoveredDropdown(item.label);
                        setOpenDropdown((current) => current === item.label ? current : null);
                        hoverOpenTimer.current = null;
                      };
                      if (visibleDropdown && visibleDropdown !== item.label) hoverOpenTimer.current = setTimeout(open, 100);
                      else open();
                    }
                  }}
                  onFocus={(event) => {
                    if (hasChildren) {
                      cancelHoverClose();
                      cancelHoverOpen();
                      const rect = event.currentTarget.getBoundingClientRect();
                      setMenuPosition({ left: rect.left, top: rect.bottom });
                      setHoveredDropdown(item.label);
                    }
                  }}
                  onMouseLeave={() => scheduleHoverClose(item.label)}
                  onBlur={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                      setOpenDropdown((current) => current === item.label ? null : current);
                      setHoveredDropdown((current) => current === item.label ? null : current);
                    }
                  }}
                >
                  {hasChildren ? (
                    <button
                      type="button"
                      aria-haspopup="menu"
                      aria-expanded={visibleDropdown === item.label}
                      onClick={() => {
                        cancelHoverOpen();
                        cancelHoverClose();
                        setOpenDropdown((current) => current === item.label ? null : item.label);
                        setHoveredDropdown(null);
                      }}
                      className={`flex items-center gap-1 lg:gap-2 whitespace-nowrap px-1.5 lg:px-4 py-2 rounded-lg text-[12px] lg:text-[13px] font-medium transition-colors
                        ${active 
                          ? 'text-primary bg-primary/8' 
                          : 'text-ink hover:text-ink-deep hover:bg-white/60'
                        }`}
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
                        className="hidden opacity-80 lg:block"
                      >
                        <path d={item.icon} />
                      </svg>
                      <span>{item.label}</span>
                      {item.badge && (
                        <span className="hidden lg:inline-flex text-[10px] px-1.5 py-0.5 rounded bg-ink-soft/10 text-ink-soft font-medium">
                          {item.badge}
                        </span>
                      )}
                      <ChevronDown className={`w-3.5 h-3.5 transition-transform ${
                        visibleDropdown === item.label ? 'rotate-180' : ''
                      }`} />
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled
                      className="flex items-center gap-1.5 sm:gap-2 whitespace-nowrap px-2 sm:px-4 py-2 rounded-lg text-[12px] sm:text-[13px] font-medium text-ink-soft/40 cursor-not-allowed"
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
                        className="opacity-80"
                      >
                        <path d={item.icon} />
                      </svg>
                      <span>{item.label}</span>
                      {item.badge && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-ink-soft/10 text-ink-soft font-medium">
                          {item.badge}
                        </span>
                      )}
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-ink-soft/10 text-ink-soft">
                        敬请期待
                      </span>
                    </button>
                  )}

                  {/* 下拉菜单 */}
                  {hasChildren && (
                    <div
                      className="nav-dropdown absolute left-0 top-full z-[var(--z-dropdown)] min-w-[180px] pt-1"
                      style={{
                        visibility: visibleDropdown === item.label ? "visible" : "hidden",
                        opacity: visibleDropdown === item.label ? 1 : 0,
                        pointerEvents: visibleDropdown === item.label ? "auto" : "none",
                        transform: visibleDropdown === item.label ? "translateY(0)" : "translateY(-4px)",
                      }}
                    >
                      <div className="dropdown-surface rounded-xl shadow-lg py-2 animate-scale-in" role="menu">
                        {children.map((child) => (
                          <Link
                            key={child.href}
                            href={child.href}
                            role="menuitem"
                            className={`flex items-center gap-3 px-4 py-2.5 text-[13px] hover:bg-white/60 transition-colors
                              ${pathname === child.href ? 'text-primary font-medium' : 'text-ink'}`}
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
                              className="opacity-70"
                            >
                              <path d={child.icon} />
                            </svg>
                            {child.label}
                          </Link>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* 右侧用户信息 */}
          <div className="relative shrink-0" onMouseEnter={() => { cancelHoverClose(); cancelHoverOpen(); setHoveredDropdown('user'); }} onMouseLeave={() => scheduleHoverClose('user')} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) { setOpenDropdown(null); setHoveredDropdown(null); } }}>
            <button type="button" aria-label="用户菜单" aria-haspopup="menu" aria-expanded={visibleDropdown === 'user'} onClick={() => { setOpenDropdown(current => current === 'user' ? null : 'user'); setHoveredDropdown(null); }} className="inline-flex items-center gap-2 rounded-lg p-2 text-xs text-ink-deep transition hover:bg-primary/8 active:scale-95"><UserRound className="h-4 w-4 text-primary" /><span className="hidden max-w-24 truncate lg:block">{user.realName || user.username}</span><ChevronDown className="hidden h-3 w-3 sm:block" /></button>
            <div className="nav-user-dropdown absolute right-0 top-full w-56 pt-1 transition-[opacity,transform,visibility] duration-150" style={{ visibility: visibleDropdown === 'user' ? 'visible' : 'hidden', opacity: visibleDropdown === 'user' ? 1 : 0, transform: visibleDropdown === 'user' ? 'translateY(0)' : 'translateY(-4px)', pointerEvents: visibleDropdown === 'user' ? 'auto' : 'none' }}><div role="menu" className="dropdown-surface overflow-hidden rounded-xl py-1.5 shadow-lg"><div className="border-b border-line px-4 py-3"><p className="truncate text-sm font-medium">{user.realName || user.username}</p><p className="mt-1 text-xs text-ink-soft">{user.username} · {user.role === 'admin' ? '管理员' : '分仓管'}</p></div><Link href="/settings/account" role="menuitem" className="flex items-center gap-2.5 px-4 py-3 text-sm transition hover:bg-primary/8"><UserRound className="h-4 w-4 text-primary" />个人账号</Link><button type="button" role="menuitem" disabled={loggingOut} onClick={logout} className="flex w-full items-center gap-2.5 px-4 py-3 text-left text-sm text-danger transition hover:bg-danger/5 disabled:opacity-50"><LogOut className="h-4 w-4" />{loggingOut ? '正在退出…' : '退出登录'}</button>{logoutError && <p role="alert" className="px-4 py-2 text-xs text-danger">{logoutError}</p>}</div></div>
          </div>
        </div>
      </div>
    </nav>
  );
}
