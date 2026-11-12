"use server";
// 「账号与监控」页面的服务端动作。每个动作先用 Module 的 accounts.detail 确认账号在操作者的品牌 / 分公司范围内
// （越范围 = 未找到），再把范围收窄到这个账号的专员后交给监控开关 / 补抓命令；它们自己还会再查 Capability。
import { PlanError } from "../../modules/activity-plan";
import { idOf, run } from "../_lib/action";
import { ap, monitoringActor, planActorOf, planWeb } from "../_lib/plan";
import type { ActionResult } from "../_lib/result";

const LEVELS = ["branch", "dealer", "store", "staff", "account"] as const;
type Level = (typeof LEVELS)[number];

export async function confirmEmptyAccount(accountId: string): Promise<ActionResult<{ accountId: string }>> {
  return run(async (ctx) => ap().roster.maintenance.confirmEmpty(await planActorOf(ctx), idOf(accountId, "账号")).then((r) => ({ accountId: r.accountId })));
}

export interface SwitchResult {
  kind: "preview" | "applied" | "noop";
  affectedAccounts: number;
  currentEnabled: boolean | null;
}
/** 五级开关。anchor 是页面上正在看的账号；level 对应的节点必须就是该账号的上级链上的那个节点（不能借这个页面改别的节点）。 */
export async function setMonitoringSwitch(anchorAccountId: string, level: Level, nodeId: string, enabled: boolean, apply: boolean): Promise<ActionResult<SwitchResult>> {
  return run(async (ctx) => {
    if (!(LEVELS as readonly string[]).includes(level) || typeof enabled !== "boolean") throw new PlanError("input", "invalid_input", "开关参数不合法");
    const d = await ap().accounts.detail(await planActorOf(ctx), idOf(anchorAccountId, "账号"));
    const node = d.chain.find((n) => n.level === level);
    if (!node || node.id !== String(idOf(nodeId, "节点"))) throw new PlanError("not_found", "not_found", "未找到");
    const r = await planWeb().switches.set({ level, id: node.id, enabled, apply: level === "account" ? true : apply }, monitoringActor(ctx, BigInt(d.staff.id)));
    return { kind: r.kind, affectedAccounts: r.kind === "noop" ? 0 : r.affectedAccounts, currentEnabled: r.kind === "preview" ? r.currentEnabled : null };
  });
}

export interface SupplementOutcome {
  disposition: string;
  reason: string | null;
}
/** 单账号手工补抓：只创建任务（页面进程不发任何供应商请求），由 sync worker 在 capability 放行后执行。同一分钟内重复点击幂等。 */
export async function supplementAccount(accountId: string): Promise<ActionResult<SupplementOutcome>> {
  return run(async (ctx) => {
    const id = idOf(accountId, "账号");
    const d = await ap().accounts.detail(await planActorOf(ctx), id);
    const r = await planWeb().sync.createSupplement(
      { accountIds: [id.toString()], only: "full", onBusy: "run_now", apply: true, idempotencyKey: `page:${ctx.actor}:${id}:${Math.floor(Date.now() / 60_000)}` },
      monitoringActor(ctx, BigInt(d.staff.id)),
    );
    const disposition = r.dispositions[0];
    return { disposition: disposition?.disposition ?? r.kind, reason: disposition && "reason" in disposition ? disposition.reason : null };
  });
}
