// Runner 与框架的合同。框架（worker）负责：领取、资格复核、in_flight 恢复、失败映射、重试 / 死信 / 熔断记账；
// Runner（任务 5–7）负责：一个动作的业务流程——调网关、解码、整页投影、封口，并在自己的 fenced 事务里写成功终态。
import type { Db, DbTx } from "../../db/client";
import type { TaskRow } from "../orchestrator";
import type { Clock } from "../raw-capture";
import type { FailureCode } from "./failure-map";

export interface TaskContext {
  readonly task: TaskRow;
  /** 本次领取的 fencing token；所有写入都必须带它（withFences）。 */
  readonly token: bigint;
  readonly db: Db;
  readonly clock: Clock;
  /** 每次供应商调用 / 每页 / 每个下载分片之前调用：续租；cancelled / stale 时必须立即停止，不再发起调用。 */
  heartbeat(): Promise<"ok" | "cancelled" | "stale">;
  /** 优雅停机已开始：在两页之间 / 两次调用之间检查，返回 abandoned("shutdown")。 */
  shouldStop(): boolean;
}

export type RunnerOutcome =
  /** Runner 已在 fenced 事务里写好成功终态（含封口、检查点）。 */
  | { kind: "done" }
  /** 失败：由框架按 FAILURE_SPECS 映射到 retry_wait / failed / dead / cancelled，并记熔断。 */
  | { kind: "failure"; code: FailureCode; retryAfterMs?: number; detail?: Record<string, unknown>; onTerminal?: TerminalHook }
  /** 放弃：不改任务状态（已取消、被取代、停机）。 */
  | { kind: "abandoned"; reason: "cancelled" | "stale" | "shutdown" };

/**
 * 失败路径的终态钩子（design-task5 §2）：只有本次失败使任务进入 failed / dead / cancelled 时才执行，
 * 且与终态写入**同一个 fenced 事务**（封口、条件清除 building、记问题）；retry_wait 不执行。
 * 钩子抛错 → 整笔回滚，框架记日志后**不带钩子**重写终态，所以一个确定性抛错的钩子不会让任务永远停在 running。
 * 钩子没做成的收尾（例如封口）由孤儿清扫补上。
 */
export type TerminalHook = (tx: DbTx, ctx: { status: "failed" | "dead" | "cancelled"; now: Date }) => Promise<void>;

export type TaskRunner = (ctx: TaskContext) => Promise<RunnerOutcome>;
/** 动作 → Runner。worker 只领取已注册 Runner 的动作。 */
export type RunnerRegistry = Readonly<Record<string, TaskRunner>>;
