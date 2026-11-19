"use client";
// 视频广场里需要浏览器状态的三块：下拉筛选（改动立即跳转）、「AI分析」弹窗、灰色标签的提示。其余都是服务端渲染。
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Dialog } from "./dialog";
import { Icon } from "./icon";
import { useToast } from "./toast";

export interface SquareSelectOption {
  value: string;
  label: string;
  /** 选中它之后的地址（URL 即状态）。 */
  href: string;
}

/** 单选下拉：改动立即跳转；disabled 时整个控件置灰并给出原因。 */
export function SquareSelect({ label, value, options, disabled = false, hint }: { label: string; value: string; options: SquareSelectOption[]; disabled?: boolean; hint?: string }) {
  const router = useRouter();
  return (
    <label className={`filter-select ${disabled ? "is-disabled" : ""}`} {...(hint ? { title: hint } : {})}>
      <span>{label}</span>
      <select
        value={value}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => {
          const o = options.find((x) => x.value === e.target.value);
          if (o) router.push(o.href, { scroll: false });
        }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** 「AI分析」：只弹「功能正在开发中」，不发请求、不写数据（R5.4）；弹窗里可以进入界面示意页。 */
export function AiButton({ contentId, className = "btn btn-sm btn-primary", withIcon = false }: { contentId: string; className?: string; withIcon?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)}>
        {withIcon ? <Icon name="sparkles" /> : null} AI分析
      </button>
      {open ? (
        <Dialog
          open
          title="AI分析"
          onClose={() => setOpen(false)}
          foot={
            <>
              <Link className="btn" href={`/square/${contentId}/ai`}>
                查看界面示意
              </Link>
              <button type="button" className="btn btn-primary" onClick={() => setOpen(false)}>
                知道了
              </button>
            </>
          }
        >
          <div className="callout">
            <Icon name="sparkles" />
            <span>AI分析功能正在开发中，敬请期待。</span>
          </div>
        </Dialog>
      ) : null}
    </>
  );
}

/** 灰色大块标签（官媒阵地）：不可选，点击只提示。 */
export function OffTab({ title, sub }: { title: string; sub: string }) {
  const toast = useToast();
  return (
    <button type="button" className="sq-bigtab is-off" role="tab" aria-selected="false" aria-disabled="true" onClick={() => toast(`${title}${sub}`)}>
      <span className="sq-bigtab-title">{title}</span>
      <span className="sq-bigtab-sub">{sub}</span>
    </button>
  );
}
