// 阶段共用的小工具。
import { eq } from "drizzle-orm";
import { judgementRuns } from "../../../db/schema";
import type { Env, RunnerDeps } from "./types";

export const chunk = <T,>(xs: readonly T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
export const hex = (b: Buffer | Uint8Array): string => Buffer.from(b).toString("hex");

/** 把键并入运行的 phase_detail（不覆盖别的键）；同时更新内存里的 env.run，使同一 tick 内后续阶段读到新值。 */
export async function mergeDetail(deps: Pick<RunnerDeps, "claim" | "clock" | "db">, env: Env, patch: Record<string, unknown>): Promise<void> {
  const next = { ...((env.run.phaseDetail as object | null) ?? {}), ...patch };
  await deps.claim.withFence(env.run, async (tx) => void (await tx.update(judgementRuns).set({ phaseDetail: next as never, updatedAt: deps.clock.now() }).where(eq(judgementRuns.runId, env.run.runId))));
  env.run = { ...env.run, phaseDetail: next as never };
}

/** 保留期延长（C 的约定：读取时刻 + 3 个月）：每个求值块写证据**之前**调用，失败则整块重试；resultId 去重。 */
export async function retainUntilOf(deps: Pick<RunnerDeps, "clock" | "signals">, env: Env, ids: ReadonlyArray<bigint | undefined>): Promise<void> {
  const unique = [...new Set(ids.filter((x): x is bigint => x !== undefined))];
  if (unique.length === 0) return;
  const until = deps.clock.now();
  until.setUTCMonth(until.getUTCMonth() + 3);
  await deps.signals.retainUntil(env.actor, unique, until);
}
