// 引用的定义与事件映射（纯函数，design §7.7）。全仓库唯一的「什么算引用」。
// 引用 = 账号在某计划名单里（in_roster）∧ 计划 collecting（未删除）∧（无结束日 ∨ 北京时间今日 ≤ 结束日）。
// 暂停、归档、已删除、已过结束日的计划都不算引用。
import { UNREFERENCED_DAYS } from "../activity-plan/constants";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Asia/Shanghai 自 1991 年起无夏令时，按固定 UTC+8（同 sync-schedule/slots.ts）。 */
const BEIJING_OFFSET = 8 * HOUR;
export const UNREFERENCED_MS = UNREFERENCED_DAYS * DAY;

/** 北京时间的自然日，YYYY-MM-DD。 */
export const bjtDate = (t: Date): string => new Date(t.getTime() + BEIJING_OFFSET).toISOString().slice(0, 10);

/** 结束日（含）之后的第一个时刻：结束日次日北京时间 00:00，换算成 UTC。 */
export const endStopAt = (endsOn: string): Date => new Date(new Date(`${endsOn}T00:00:00+08:00`).getTime() + DAY);

export interface PlanFacts {
  status: string;
  endsOn: string | null;
  statusChangedAt: Date;
  deletedAt: Date | null;
}
export interface EntryFacts {
  entryState: string;
  removedAt: Date | null;
}

/** 计划自身是否「在引用」：采集中且未过结束日（结束日当天仍算）。 */
export const planReferencing = (p: Pick<PlanFacts, "status" | "endsOn">, today: string): boolean =>
  p.status === "collecting" && (p.endsOn === null || today <= p.endsOn);

export const entryReferencing = (e: EntryFacts, p: Pick<PlanFacts, "status" | "endsOn">, today: string): boolean =>
  e.entryState === "in_roster" && planReferencing(p, today);

/**
 * 一个名单项「不再被引用」的时刻：它仍在被引用时返回 null；否则取各个已发生原因里最早的一个
 * （移出、计划删除、暂停 / 归档、自然过结束日）。
 */
export function entryStopAt(e: EntryFacts, p: PlanFacts, now: Date): Date | null {
  const causes: Date[] = [];
  if (e.entryState === "removed" && e.removedAt) causes.push(e.removedAt);
  if (p.status === "deleted" && p.deletedAt) causes.push(p.deletedAt);
  if ((p.status === "paused" || p.status === "archived")) causes.push(p.statusChangedAt);
  if (p.endsOn !== null) {
    const stop = endStopAt(p.endsOn);
    if (stop.getTime() <= now.getTime()) causes.push(stop);
  }
  if (causes.length === 0) return null;
  return new Date(Math.min(...causes.map((d) => d.getTime())));
}

export type ReconcileTrigger = "import" | "explicit_remove" | "plan_state" | "scan" | "manual_enable";
export interface ReconcileEvent {
  trigger: ReconcileTrigger;
  /** immediate：引用为 0 时立即关；timer：只记起点，满 15 天才关。 */
  mode: "immediate" | "timer";
  /** 无引用起点：缺省 now；"stop_at" 表示逐账号取 computeStopAt。 */
  since?: "now" | "stop_at";
  /** manual_enable：无条件把起点重置为现在。 */
  resetSince?: boolean;
}
/** 事件到参数的映射（design §7.7 表）。调用方只说「发生了什么」，不拼参数。 */
export const EVENTS = {
  /** 解析成功或本地命中归并 */
  imported: { trigger: "import", mode: "timer" },
  /** 单条或批量移出名单 */
  removed: { trigger: "explicit_remove", mode: "immediate" },
  /** 分公司退出 */
  branchExit: { trigger: "explicit_remove", mode: "immediate" },
  planDeleted: { trigger: "plan_state", mode: "immediate" },
  planPaused: { trigger: "plan_state", mode: "timer", since: "stop_at" },
  planArchived: { trigger: "plan_state", mode: "timer", since: "stop_at" },
  planResumed: { trigger: "plan_state", mode: "timer", since: "stop_at" },
  planRestored: { trigger: "plan_state", mode: "timer", since: "stop_at" },
  endDateChanged: { trigger: "plan_state", mode: "timer", since: "stop_at" },
  dailyScan: { trigger: "scan", mode: "timer", since: "stop_at" },
  manualEnable: { trigger: "manual_enable", mode: "timer", resetSince: true },
} as const satisfies Record<string, ReconcileEvent>;
