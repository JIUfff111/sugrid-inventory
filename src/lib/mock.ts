import type { Machine } from "@/components/TagCard";

/** 静态样例数据 —— 仅用于样式验收，后续接入 SQLite */

export const MACHINES: Machine[] = [
  { imei: "868231062363405", brandModel: "联想 ThinkPad T480", spec: "8G+256G · 黑色", grade: "i5-8350U · 电池>90% · 准新机", price: 3240, source: "中关通讯", date: "2026-10-08", status: "in_stock" },
  { imei: "356789104512338", brandModel: "苹果 MacBook Air 2020", spec: "8G+256G · 深空灰", grade: "M1 · 循环128次 · 国行", price: 4688, source: "淘宝-松诚", date: "2026-10-08", status: "in_stock" },
  { imei: "869941050312774", brandModel: "小米笔记本 Pro 15", spec: "16G+512G · 月岩灰", grade: "i7-11370H · MX450 · 95新", price: 3888, source: "拍机堂", date: "2026-10-09", status: "on_way" },
  { imei: "354190928477561", brandModel: "戴尔 Latitude 5400", spec: "16G+512G · 黑色", grade: "i5-8365U · 小磕碰 · 二手良品", price: 2288, source: "雷总线下", date: "2026-10-07", status: "in_stock" },
  { imei: "864230091825530", brandModel: "华为 MateBook 14 2023", spec: "16G+1T · 深空灰", grade: "i5-1340P · 触控屏 · 98新", price: 4299, source: "曹总", date: "2026-10-06", status: "sold" },
  { imei: "358771094412883", brandModel: "ThinkPad X1 Carbon G10", spec: "32G+1T · 黑色", grade: "i7-1260P · 电池>90% · 99新", price: 5900, source: "凌雄", date: "2026-10-09", status: "in_stock" },
  { imei: "861234051799612", brandModel: "惠普 战66 六代", spec: "16G+512G · 银色", grade: "R5-7640U · 保修至27年", price: 3199, source: "王会枝", date: "2026-10-05", status: "after_sale" },
  { imei: "352098114566274", brandModel: "联想 小新 Pro 16", spec: "16G+512G · 卷云灰", grade: "R7-7735HS · 120Hz · 96新", price: 3799, source: "诚讯", date: "2026-10-08", status: "on_way" },
];

export type Order = {
  no: string;              // CG2026100942220046
  status: "unshipped" | "on_way" | "arrived" | "received";
  payment: "unpaid" | "paid";
  supplier: string;
  buyer: string;
  qty: number;
  inQty: number;
  returned: number;
  dueAmount: number;
  amount: number;
  time: string;
  isComplete?: boolean;    // 订单是否完成（已收货且机器全部录入）
};

const ORDER_STATUS: Record<Order["status"], string> = {
  unshipped: "未发货",
  on_way: "在路上",
  arrived: "已到货",
  received: "已收货",
};

export function orderStatusText(s: Order["status"]) {
  return ORDER_STATUS[s];
}

export const ORDERS: Order[] = [
  { no: "CG2026100942220046", status: "received", payment: "unpaid", supplier: "中关通讯", buyer: "管理员", qty: 1, inQty: 1, returned: 0, dueAmount: 3240.9, amount: 3240.9, time: "2026-10-09 09:22:57", isComplete: true },
  { no: "CG2026100942220045", status: "received", payment: "unpaid", supplier: "拍机堂", buyer: "管理员", qty: 1, inQty: 1, returned: 0, dueAmount: 3888, amount: 3888, time: "2026-10-09 09:17:05", isComplete: true },
  { no: "CG2026100842220044", status: "on_way", payment: "paid", supplier: "淘宝-松诚科技", buyer: "管理员", qty: 2, inQty: 0, returned: 0, dueAmount: 8699, amount: 8699, time: "2026-10-08 17:22:10", isComplete: false },
  { no: "CG2026100842220043", status: "arrived", payment: "unpaid", supplier: "雷总线下", buyer: "管理员", qty: 1, inQty: 0, returned: 0, dueAmount: 2288, amount: 2288, time: "2026-10-08 15:37:04", isComplete: false },
  { no: "CG2026100842220042", status: "received", payment: "paid", supplier: "凌雄", buyer: "管理员", qty: 3, inQty: 3, returned: 1, dueAmount: 9288, amount: 12888, time: "2026-10-08 11:35:26", isComplete: true },
  { no: "CG2026100842220041", status: "unshipped", payment: "unpaid", supplier: "曹总", buyer: "管理员", qty: 5, inQty: 0, returned: 0, dueAmount: 15995, amount: 15995, time: "2026-10-08 11:33:42", isComplete: false },
  { no: "CG2026100742220040", status: "received", payment: "paid", supplier: "诚讯", buyer: "管理员", qty: 2, inQty: 2, returned: 0, dueAmount: 6398, amount: 6398, time: "2026-10-07 11:32:09", isComplete: true },
  { no: "CG2026100742220039", status: "received", payment: "unpaid", supplier: "王会枝", buyer: "管理员", qty: 1, inQty: 1, returned: 0, dueAmount: 1600, amount: 1600, time: "2026-10-07 10:29:26", isComplete: true },
];

export function fmtMoney(n: number) {
  return n.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
