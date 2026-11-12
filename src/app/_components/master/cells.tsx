// 主数据导入表格的单元格：原因 = 人话在上、稳定码在下的小字。
import { REASON_TEXT } from "../../../modules/master-data-import/return-file";
import { MD_CHANGE_TEXT, MD_CLASS, MD_OUTCOME } from "../../_lib/master-labels";
import { Badge } from "../ui";

export function MdReason({ code, detail }: { code: string | null; detail: string | null }) {
  if (!code) return <>—</>;
  const text = (c: string): string => REASON_TEXT[c] ?? MD_CHANGE_TEXT[c] ?? c;
  // 更新类行的 detail 是逗号分隔的附加变化码（译成人话）；错误类行的 detail 是原文说明（原样显示）
  const extra = detail ? (MD_CHANGE_TEXT[detail.split(",")[0]!] ? detail.split(",").map(text).join("；") : detail) : null;
  return (
    <>
      <div className="reason-text">{text(code)}</div>
      {extra ? <div className="cell-sub">{extra}</div> : null}
      <div className="reason-code">{code}</div>
    </>
  );
}
export function MdClassBadge({ cls }: { cls: string | null }) {
  if (!cls) return <>—</>;
  const c = MD_CLASS[cls] ?? { label: cls, tone: "plain" as const };
  return <Badge tone={c.tone}>{c.label}</Badge>;
}
export function MdOutcomeBadge({ outcome }: { outcome: string | null }) {
  if (!outcome) return <>—</>;
  const o = MD_OUTCOME[outcome] ?? { label: outcome, tone: "plain" as const };
  return <Badge tone={o.tone}>{o.label}</Badge>;
}
