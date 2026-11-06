// 领取时资格复核（FS-2.6）：任务被领取、发出任何付费调用之前，复核账号当前是否仍是有效监控目标。
// 失效 → cancelled / monitoring_closed，零调用。媒资下载不调供应商，不复核；tracer 的根任务不归本 worker。
import type { MonitoringResolver } from "../monitoring";
import type { TaskRow } from "../orchestrator";

const CHECKED_ACTIONS = new Set(["fetch_profile", "fetch_content_list", "fetch_content_detail", "fetch_comments"]);

export type Eligibility = { ok: true } | { ok: false; reason: string };

export async function checkEligibility(resolver: Pick<MonitoringResolver, "explain">, task: Pick<TaskRow, "requestedAction" | "accountId">): Promise<Eligibility> {
  if (!CHECKED_ACTIONS.has(task.requestedAction)) return { ok: true };
  // fail closed：需要复核却不知道复核哪个账号，就不能调用供应商（FS-2.6）。按需任务创建时必须写 account_id。
  if (task.accountId === null) return { ok: false, reason: "no_account_reference" };
  const e = await resolver.explain(task.accountId);
  return e.effective ? { ok: true } : { ok: false, reason: e.reason ?? "unknown" };
}
