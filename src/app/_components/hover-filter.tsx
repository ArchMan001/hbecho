"use client";
// 悬停下拉筛选（借鉴 hbdam 素材库）：悬停 / 聚焦展开，移开收起；触屏没有悬停，点击固定展开，点空白处收起。
// 选项是服务端算好的链接（URL 即状态）：点一下就跳转，不在客户端存筛选值。
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Icon } from "./icon";

export interface HoverFilterOption {
  value: string;
  label: string;
  selected: boolean;
  /** 点击后的地址：已选项指向「取消该项」，未选项指向「选中」（单选还会替换同组已选）。 */
  href: string;
}

export function HoverFilter({ label, options, mode = "multi", clearHref }: { label: string; options: HoverFilterOption[]; mode?: "multi" | "single"; clearHref?: string }) {
  const [pinned, setPinned] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!pinned) return;
    const off = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setPinned(false);
    };
    document.addEventListener("pointerdown", off);
    return () => document.removeEventListener("pointerdown", off);
  }, [pinned]);

  const picked = options.filter((o) => o.selected);
  const text = mode === "single" && picked[0] ? `${label} · ${picked[0].label}` : label;
  return (
    <div ref={root} className={`hf${pinned ? " pinned" : ""}`}>
      <button
        type="button"
        className={`hf-btn${picked.length ? " on" : ""}`}
        aria-haspopup="true"
        aria-expanded={pinned}
        onClick={() => {
          if (window.matchMedia("(hover: none)").matches) setPinned((v) => !v);
        }}
      >
        <span>{text}</span>
        {mode === "multi" && picked.length ? <span className="hf-count">{picked.length}</span> : null}
        <Icon name="chevron" />
      </button>
      <div className="hf-pop">
        <div className="hf-panel" role="group" aria-label={label}>
          <div className="hf-list">
            {options.map((o) => (
              <Link
                key={o.value}
                className={`hf-opt${mode === "single" ? " radio" : ""}${o.selected ? " on" : ""}`}
                role={mode === "single" ? "radio" : "checkbox"}
                aria-checked={o.selected}
                href={o.href}
                scroll={false}
                onClick={() => mode === "single" && setPinned(false)}
              >
                <span className="hf-box">{o.selected ? <Icon name="check" /> : null}</span>
                <span>{o.label}</span>
              </Link>
            ))}
          </div>
          <div className="hf-foot">
            <span>移开鼠标收起</span>
            {picked.length && clearHref ? <Link className="hf-clear" href={clearHref} scroll={false}>清空</Link> : null}
          </div>
        </div>
      </div>
    </div>
  );
}
