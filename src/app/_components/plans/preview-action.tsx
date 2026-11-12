"use client";
// 「先预览、再确认」的弹窗（ui-foundation §6.5：影响多个对象的操作先给预览）。
// 打开弹窗时调用 preview（只读）并把结果交给 children 渲染影响范围；确认时才调用 action。
// 预览失败（例如越权、计划已变化）留在弹窗里显示人话 + 稳定错误码，且不给确认按钮。
import { useRouter } from "next/navigation";
import { useState, useTransition, type ReactNode } from "react";
import type { ActionResult } from "../../_lib/result";
import { Dialog } from "../dialog";
import { Icon, type IconName } from "../icon";
import { useToast } from "../toast";

export function PreviewAction<P>({
  label,
  icon,
  buttonClass = "btn btn-sm",
  title,
  confirmLabel,
  danger = false,
  preview,
  action,
  doneMessage,
  after,
  children,
}: {
  label: ReactNode;
  icon?: IconName | undefined;
  buttonClass?: string;
  title: string;
  confirmLabel: string;
  danger?: boolean;
  preview: () => Promise<ActionResult<P>>;
  action: () => Promise<ActionResult<unknown>>;
  /** 成功提示；可以按结果生成（例如「已关闭 3 个账号的监控」）。 */
  doneMessage: string | ((result: unknown) => string);
  after?: string;
  children: (p: P) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<P | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [pending, start] = useTransition();
  const router = useRouter();
  const toast = useToast();

  const openIt = async () => {
    setOpen(true);
    setData(null);
    setError(null);
    setLoading(true);
    let r: ActionResult<P>;
    try {
      r = await preview();
    } catch {
      r = { ok: false, code: "network_error", message: "请求没有完成，请检查网络后重试" };
    }
    setLoading(false);
    if (r.ok) setData(r.data);
    else setError({ code: r.code, message: r.message });
  };
  const confirm = () =>
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
      toast(typeof doneMessage === "function" ? doneMessage(r.data) : doneMessage);
      if (after) router.push(after);
      else router.refresh();
    });
  return (
    <>
      <button type="button" className={buttonClass} onClick={openIt}>
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
            <button type="button" className={`btn ${danger ? "btn-danger" : "btn-primary"}`} onClick={confirm} disabled={pending || loading || data === null}>
              {pending ? "处理中…" : confirmLabel}
            </button>
          </>
        }
      >
        {loading ? <div className="skeleton skeleton-block" aria-busy="true" aria-label="正在计算影响范围" /> : null}
        {data !== null ? children(data) : null}
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
