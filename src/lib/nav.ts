/** 页面注册表 —— Sidebar / TabBar 共用，新增页面在这里登记 */

export type NavPage = {
  path: string;
  title: string;
  /** 固定标签：不可关闭（如首页） */
  pinned?: boolean;
};

export const NAV_PAGES: NavPage[] = [
  { path: "/", title: "首页", pinned: true },
  { path: "/orders", title: "采购订单" },
  { path: "/orders/new", title: "新增采购单" },
];

/** 根据 pathname 解析页面标题（支持未来动态路由，如 /orders/:id） */
export function resolvePage(pathname: string): NavPage | null {
  const hit = NAV_PAGES.find((p) => p.path === pathname);
  if (hit) return hit;
  // 动态路由前缀匹配（按最长前缀）
  const prefix = NAV_PAGES.filter((p) => pathname.startsWith(p.path + "/")).sort(
    (a, b) => b.path.length - a.path.length,
  )[0];
  return prefix ?? null;
}
