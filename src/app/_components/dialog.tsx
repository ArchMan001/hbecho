"use client";
// 确认弹窗（ui-foundation §6.5）：写明影响范围，按钮文字写动作本身，失败时留在弹窗里显示人话 + 稳定错误码。
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, useTransition, type ReactNode } from "react";
import type { ActionResult } from "../_lib/result";
import { Icon, type IconName } from "./icon";
import { useToast } from "./toast";

export function Dialog({ open, title, onClose, children, foot }: { open: boolean; title: string; onClose: () => void; children: ReactNode; foot: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId(); // 同一页可能有多个弹窗，id 不能重复
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="modal"
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="modal-card">
        <div className="modal-head">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>
        <div className="modal-body">{children}</div>
        <div className="modal-foot">{foot}</div>
      </div>
    </dialog>
  );
}

/**
 * 一个按钮 + 一个确认弹窗 + 一个服务端动作。成功后刷新当前页面并提示；失败留在弹窗里。
 * `action` 是 `"use server"` 函数（可 bind 参数），在服务端再做一次 Capability 与范围判断。
 */
export function ConfirmAction({
  label,
  icon,
  buttonClass = "btn btn-sm",
  title,
  children,
  confirmLabel,
  danger = false,
  action,
  doneMessage,
  after,
}: {
  label: ReactNode;
  icon?: IconName | undefined;
  buttonClass?: string;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  action: () => Promise<ActionResult<unknown>>;
  doneMessage: string;
  /** 成功后的去处；缺省只刷新当前页面。 */
  after?: string;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const toast = useToast();
  const run = () =>
    start(async () => {
      setError(null);
      let r: ActionResult<unknown>;
      try {
        r = await action();
      } catch {
        r = { ok: false, code: "network_error", message: "请求没有完成，请检查网络后重试" };
      }
      if (!r.ok) {
        setError({ code: r.code, message: r.message });
        return;
      }
      setOpen(false);
      toast(doneMessage);
      if (after) router.push(after);
      else router.refresh();
    });
  return (
    <>
      <button type="button" className={buttonClass} onClick={() => setOpen(true)}>
        {icon ? <Icon name={icon} /> : null}
        {label}
      </button>
      <Dialog
        open={open}
        title={title}
        onClose={() => (pending ? undefined : setOpen(false))}
        foot={
          <>
            <button type="button" className="btn" onClick={() => setOpen(false)} disabled={pending}>
              取消
            </button>
            <button type="button" className={`btn ${danger ? "btn-danger" : "btn-primary"}`} onClick={run} disabled={pending}>
              {pending ? "处理中…" : confirmLabel}
            </button>
          </>
        }
      >
        {children}
        {error ? (
          <div className="callout danger" role="alert" style={{ marginTop: 12 }}>
            <Icon name="alert" />
            <span>
              {error.message}（错误码 {error.code}）
            </span>
          </div>
        ) : null}
      </Dialog>
    </>
  );
}
