"use client";
// 向导三页共用的小部件：步骤条、保存状态、能力条表头、关键词输入、动作错误提示。
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { Icon, type IconName } from "../icon";
import type { SaveState } from "./use-config-editor";

const STEPS = [
  { n: 1, label: "第 1 页 · 圈定", desc: "条数与未获取原因" },
  { n: 2, label: "第 2 页 · 比对", desc: "分布、样例与阈值" },
  { n: 3, label: "第 3 页 · 理解与执行", desc: "ASR、评论与确认" },
  { n: 4, label: "执行与结果", desc: "记录、证据与 E" },
] as const;

/** 步骤条：已能进入的页可点（草稿的进度 current 之前）；「执行与结果」在草稿阶段不可点。 */
export function Stepbar({ planId, current, viewing }: { planId: string; current: 1 | 2 | 3; viewing: 1 | 2 | 3 }) {
  return (
    <div className="stepbar" aria-label="向导进度">
      {STEPS.map((s) => {
        const status = s.n < current ? "done" : s.n === current ? "next" : "todo";
        const link = s.n <= current && s.n <= 3;
        const inner = (
          <>
            <div className="step-dot">{status === "done" ? <Icon name="check" /> : s.n}</div>
            <div>
              <div className="step-label">{s.label}</div>
              <div className="step-desc">{s.desc}</div>
            </div>
          </>
        );
        const cls = `step ${status} ${s.n === viewing ? "viewing" : ""} ${link ? "link" : ""}`;
        return link ? (
          <Link key={s.n} className={cls} href={`/judgement/${planId}/wizard/${s.n}`} aria-current={s.n === viewing ? "step" : undefined}>
            {inner}
          </Link>
        ) : (
          <div key={s.n} className={cls}>
            {inner}
          </div>
        );
      })}
    </div>
  );
}

export function SaveBadge({ state }: { state: SaveState }) {
  if (state.kind === "saving") return <span className="save-state" role="status">保存中…</span>;
  if (state.kind === "dirty") return <span className="save-state" role="status">有改动，稍后自动保存</span>;
  if (state.kind === "error") return <span className="save-state err" role="alert">未保存：{state.message}（{state.code}）</span>;
  return <span className="save-state ok" role="status"><Icon name="check" /> 已保存到草稿</span>;
}

/** 能力条表头：序号 / 图标 / 名称 / 别名 / 附加区 / 删除。别名随版本保存，只用于显示，不参与配置哈希。 */
export function CapHead({ idx, icon, name, alias, onAlias, onRemove, disabled, placeholder, children }: { idx: number; icon: IconName; name: string; alias: string; onAlias: (v: string) => void; onRemove: () => void; disabled: boolean; placeholder: string; children?: ReactNode }) {
  return (
    <div className="insp-head">
      <span className="idx">{String(idx + 1).padStart(2, "0")}</span>
      <div className="insp-id">
        <span className="capability-icon"><Icon name={icon} /></span>
        <span className="name-pill">{name}</span>
        <label className="alias-pill">
          <span>能力别名（可选）</span>
          <input className="input alias-input" value={alias} onChange={(e) => onAlias(e.target.value)} disabled={disabled} maxLength={200} aria-label="能力别名" placeholder={placeholder} title="能力别名，显示在配置页、证据与导出明细中" />
        </label>
        {children}
      </div>
      <button type="button" className="icon-btn cap-remove" onClick={onRemove} disabled={disabled} title="删除能力" aria-label={`删除${name}`}>
        <Icon name="x" />
      </button>
    </div>
  );
}

/** 关键词 / 话题 / 评论词：回车或点「添加」；已有的可点 × 移除。 */
export function WordEditor({ words, prefix = "", onAdd, onRemove, disabled, placeholder, label }: { words: readonly string[]; prefix?: string; onAdd: (v: string) => void; onRemove: (v: string) => void; disabled: boolean; placeholder: string; label: string }) {
  const [text, setText] = useState("");
  const add = () => {
    if (!text.trim()) return;
    onAdd(prefix === "#" ? text.trim().replace(/^#+/, "") : text.trim());
    setText("");
  };
  return (
    <div className="field">
      <label>{label}</label>
      <div className="kw-list">
        {words.map((w) => (
          <span key={w} className="kw">
            {prefix}
            {w}
            <button type="button" onClick={() => onRemove(w)} disabled={disabled} aria-label={`移除 ${w}`}>
              <Icon name="x" />
            </button>
          </span>
        ))}
        {words.length === 0 ? <span className="hint">还没有，至少添加一个。</span> : null}
      </div>
      <div className="inline-field" style={{ marginTop: 8, maxWidth: 420 }}>
        <input
          className="input"
          style={{ flex: 1 }}
          value={text}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          aria-label={label}
        />
        <button type="button" className="btn btn-sm" onClick={add} disabled={disabled || !text.trim()}>添加</button>
      </div>
    </div>
  );
}

/** 添加能力的下拉菜单：点外部或选择后关闭。 */
export function AddMenu({ label, disabled, items }: { label: string; disabled: boolean; items: Array<{ key: string; title: string; text: string; disabled?: boolean; onPick: () => void }> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="capability-add">
      <button type="button" className="btn" disabled={disabled} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Icon name="plus" /> {label}
      </button>
      {open ? (
        <>
          <div style={{ position: "fixed", inset: 0, zIndex: 39 }} onClick={() => setOpen(false)} aria-hidden="true" />
          <div className="capability-menu" role="menu" aria-label={label}>
            {items.map((it) => (
              <button
                key={it.key}
                type="button"
                role="menuitem"
                disabled={it.disabled}
                onClick={() => {
                  setOpen(false);
                  it.onPick();
                }}
              >
                <b>{it.title}</b>
                <span>{it.text}</span>
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

export function ErrorLine({ error }: { error: { code: string; message: string } | null }) {
  if (!error) return null;
  return (
    <div className="callout danger" role="alert" style={{ marginTop: 12 }}>
      <Icon name="alert" />
      <span>{error.message}（错误码 {error.code}）</span>
    </div>
  );
}
