// 名单导入的表格单元格：原因 = 人话在上、稳定码在下的小字（ui-foundation §0 2026-11-11：稳定错误码可以在界面显示）。
import { REASON_TEXT } from "../../../modules/activity-plan/roster/return-file";
import { OUTCOME_LABEL, PRECHECK_LABEL } from "../../_lib/plan-labels";
import { Badge } from "../ui";

export function ReasonCell({ code }: { code: string | null | undefined }) {
  if (!code) return <>—</>;
  return (
    <>
      <div className="reason-text">{REASON_TEXT[code] ?? code}</div>
      <div className="reason-code">{code}</div>
    </>
  );
}
export function PrecheckBadge({ cls }: { cls: string | null }) {
  if (!cls) return <>—</>;
  const p = PRECHECK_LABEL[cls] ?? { label: cls, tone: "plain" as const };
  return <Badge tone={p.tone}>{p.label}</Badge>;
}
export function OutcomeBadge({ outcome }: { outcome: string | null }) {
  if (!outcome) return <>—</>;
  const o = OUTCOME_LABEL[outcome] ?? { label: outcome, tone: "plain" as const };
  return <Badge tone={o.tone}>{o.label}</Badge>;
}
