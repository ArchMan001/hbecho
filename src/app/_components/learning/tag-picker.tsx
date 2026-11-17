"use client";
// 课程表单的标签选择：两栏（左一级标签、右二级标签复选），悬停 / 聚焦展开，移开收起；触屏点击固定展开。
// 已选标签以「一级 / 二级」小条显示在下方，可逐个移除。标签集合由超管在「标签管理」维护，这里只能选择。
import { useEffect, useRef, useState } from "react";
import { Icon } from "../icon";

export interface TagOption { id: string; name: string }
export interface TagCategoryOption { id: string; name: string; tags: TagOption[] }

export function TagPicker({ categories, selected, onToggle }: { categories: TagCategoryOption[]; selected: string[]; onToggle: (tagId: string) => void }) {
  const [pinned, setPinned] = useState(false);
  const [level, setLevel] = useState(categories[0]?.id ?? "");
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!pinned) return;
    const off = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setPinned(false);
    };
    document.addEventListener("pointerdown", off);
    return () => document.removeEventListener("pointerdown", off);
  }, [pinned]);

  const active = categories.find((c) => c.id === level) ?? categories[0];
  const countIn = (c: TagCategoryOption) => c.tags.filter((t) => selected.includes(t.id)).length;
  const chips = categories.flatMap((c) => c.tags.filter((t) => selected.includes(t.id)).map((t) => ({ ...t, category: c.name })));
  return (
    <>
      <div ref={root} className={`hf${pinned ? " pinned" : ""}`}>
        <button
          type="button"
          className={`hf-btn${selected.length ? " on" : ""}`}
          aria-haspopup="true"
          aria-expanded={pinned}
          onClick={() => {
            if (window.matchMedia("(hover: none)").matches) setPinned((v) => !v);
          }}
        >
          <Icon name="tag" />
          <span>选择标签</span>
          {selected.length ? <span className="hf-count">{selected.length}</span> : null}
          <Icon name="chevron" />
        </button>
        <div className="hf-pop">
          <div className="hf-panel tp-panel" role="group" aria-label="选择标签">
            <div className="tp-levels">
              {categories.map((c) => (
                <button key={c.id} type="button" className={`tp-level${c.id === active?.id ? " on" : ""}`} onMouseEnter={() => setLevel(c.id)} onFocus={() => setLevel(c.id)} onClick={() => setLevel(c.id)}>
                  <span>{c.name}</span>
                  {countIn(c) ? <span className="hf-count">{countIn(c)}</span> : null}
                </button>
              ))}
            </div>
            <div className="tp-pane on">
              {active && active.tags.length ? (
                <div className="hf-list">
                  {active.tags.map((t) => {
                    const on = selected.includes(t.id);
                    return (
                      <button key={t.id} type="button" className={`hf-opt${on ? " on" : ""}`} role="checkbox" aria-checked={on} onClick={() => onToggle(t.id)}>
                        <span className="hf-box">{on ? <Icon name="check" /> : null}</span>
                        <span>{t.name}</span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <p className="hint" style={{ padding: 8 }}>这个一级标签下还没有二级标签。</p>
              )}
            </div>
            <div className="tp-foot"><span>移开鼠标收起</span><span>已选 {selected.length}</span></div>
          </div>
        </div>
      </div>
      {chips.length ? (
        <div className="tp-chips">
          {chips.map((t) => (
            <button key={t.id} type="button" className="tp-chip" onClick={() => onToggle(t.id)} aria-label={`移除 ${t.category} / ${t.name}`}>
              <small>{t.category} /</small>{t.name}<Icon name="x" />
            </button>
          ))}
        </div>
      ) : (
        <span className="hint">还没选择标签。</span>
      )}
    </>
  );
}
