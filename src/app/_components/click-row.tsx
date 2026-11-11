"use client";
// 整行可点（ui-foundation §4.1「行可点击下钻」）；行内的链接和按钮保持各自的行为。
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";

export function ClickRow({ href, children }: { href: string; children: ReactNode }) {
  const router = useRouter();
  return (
    <tr
      className="clickable"
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("a,button,input,select,dialog")) return;
        router.push(href);
      }}
    >
      {children}
    </tr>
  );
}
