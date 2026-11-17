import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { ToastHost } from "./_components/toast";
import "./globals.css";

// 所有页面都按请求渲染：会话、备案号等运行时环境在构建期不存在，不能被静态化。
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Echo · 新媒体营销平台" };
export const viewport: Viewport = { width: "device-width", initialScale: 1, colorScheme: "light" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <ToastHost>{children}</ToastHost>
      </body>
    </html>
  );
}
