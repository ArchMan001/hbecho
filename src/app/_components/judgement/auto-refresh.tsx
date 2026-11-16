"use client";
// 在途的执行 / 试跑由后台推进：页面按固定间隔刷新服务端数据，到终态后自动停止。
import { useRouter } from "next/navigation";
import { useEffect } from "react";
export function AutoRefresh({ active, seconds = 5 }: { active: boolean; seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => router.refresh(), seconds * 1000);
    return () => clearInterval(t);
  }, [active, seconds, router]);
  return null;
}
