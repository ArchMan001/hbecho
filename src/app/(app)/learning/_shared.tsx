// 学习页面共用：页内标签（按 Capability 裁剪）、封面、错误转换。页面里没有 SQL，也没有角色判断。
import Link from "next/link";
import type { ReactNode } from "react";
import { DeniedState } from "../../_components/ui";
import { isLearningError } from "../../_lib/learning-labels";

export function LearningTabs({ caps, active }: { caps: ReadonlySet<string>; active: "center" | "manage" | "summary" | "tags" }) {
  const items: Array<[typeof active, string, boolean, string]> = [
    ["center", "学习中心", true, "/learning"],
    ["manage", "课程管理", caps.has("learning.manage"), "/learning/manage"],
    ["summary", "学习汇总", caps.has("learning.report.read"), "/learning/summary"],
    ["tags", "标签管理", caps.has("learning.tag.manage"), "/learning/tags"],
  ];
  return (
    <div className="tabs learning-tabs" role="tablist" aria-label="学习页面">
      {items.filter(([, , ok]) => ok).map(([key, label, , href]) => (
        <Link key={key} className={`tab ${active === key ? "active" : ""}`} href={href} aria-current={active === key ? "page" : undefined}>
          {label}
        </Link>
      ))}
    </div>
  );
}

export function Cover({ url, className = "cover-img" }: { url: string; className?: string }) {
  // 封面是短期签名地址（私有桶），不走 next/image 的优化代理
  // eslint-disable-next-line @next/next/no-img-element
  return <img className={className} src={url} alt="" loading="lazy" />;
}

/** 无权限 / 范围外 / 不存在 → 页面内的「无权访问」；其余错误交给 error.tsx（带稳定错误码）。 */
export function denied(e: unknown, text: string, home = "/learning"): ReactNode {
  if (isLearningError(e) && (e.category === "authorization" || e.category === "not_found")) return <DeniedState text={text} home={home} />;
  throw e;
}

export const qs = (base: string, params: Record<string, string | undefined>): string => {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v && v !== "all") sp.set(k, v);
  const s = sp.toString();
  return s ? `${base}?${s}` : base;
};
