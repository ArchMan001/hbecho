"use client";
// 筛选卡片：桌面常驻；手机端收进「筛选」按钮，展开才显示（原型第二轮结论 5）。
import { useState, type ReactNode } from "react";
import { Icon } from "./icon";

export function FilterCard({ activeCount, children }: { activeCount: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn btn-sm filter-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Icon name="filter" /> 筛选{activeCount ? ` · ${activeCount}` : ""}
      </button>
      <section className={`filter-card ${open ? "open" : ""}`}>{children}</section>
    </>
  );
}
