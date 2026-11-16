import type { ReactNode } from "react";
import "./judgement.css";
// 判定计划页面的专用样式（向导、能力条、阈值、试跑分布、证据抽屉）只在本路由下加载。
export default function JudgementLayout({ children }: { children: ReactNode }) {
  return children;
}
