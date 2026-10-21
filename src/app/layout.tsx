import type { Metadata } from "next";
import "@/app/globals.css";
import ClientLayout from "@/app/ClientLayout";

export const metadata: Metadata = {
  title: { default: "溯格 SUGRID · 进销存工作台", template: "%s · 溯格 SUGRID" },
  description: "溯格 SUGRID，让每台机器的采购、库存、销售与售后都有迹可循。",
  icons: { icon: '/icon.svg', apple: '/brand/apple-touch-icon.png' },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" className="h-full antialiased">
      <body className="min-h-full">
        {/* 雾蓝顶光背景 */}
        <div className="fixed inset-0 -z-10 bg-gradient-to-b from-[#dce9f7] via-paper to-paper"></div>

        <ClientLayout>{children}</ClientLayout>
      </body>
    </html>
  );
}
