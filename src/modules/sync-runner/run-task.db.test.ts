// 失败路径的 onTerminal 钩子（design-task5 §2）：只在终态执行、与终态同一事务、抛错时回滚并不带钩子重写终态。
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { useTestDb } from "../../../tests/harness/db";
import { insertAccount, insertBatch, insertTask } from "../../../tests/harness/factories";
import { FakeClock } from "../../../tests/harness/fake-clock";
import { dataQualityIssues, syncTasks } from "../../db/schema";
import { claimTask, type ClaimedTask } from "../orchestrator";
import { recordIssue } from "../projection";
import { createTaskExecutor } from "./run-task";
import type { RunnerOutcome, TerminalHook } from "./types";

const t = useTestDb();
const NOW = new Date("2026-11-08T18:00:00Z");
const RETRY = { baseBackoffMs: 1000, maxBackoffMs: 8000 };

async function setup(attemptCount: number, outcome: (hook: TerminalHook) => RunnerOutcome, hook: TerminalHook, errors: unknown[] = []) {
  const clock = new FakeClock(NOW);
  const batchId = await insertBatch(t.db, NOW);
  const accountId = await insertAccount(t.db, "douyin", NOW);
  const taskId = await insertTask(t.db, { batchId, platform: "douyin", now: NOW, action: "fetch_content_list" });
  await t.db.update(syncTasks).set({ attemptCount, accountId }).where(eq(syncTasks.taskId, taskId));
  const claim = await claimTask(t.db, taskId, { workerId: "w1", leaseMs: 60_000, now: NOW });
  if (claim.kind !== "claimed") throw new Error("claim failed");
  const claimed: ClaimedTask = { task: claim.task, token: claim.token, tookOver: false, previous: { status: "pending", nextAttemptAt: null } };
  const executor = createTaskExecutor({
    db: t.db,
    clock,
    resolver: { explain: async () => ({ effective: true, reason: null }) },
    runners: { fetch_content_list: async () => outcome(hook) },
    breakerFor: () => ({ recordSuccess() {}, recordProviderFailure() {}, recordNeutral() {} }),
    retry: RETRY,
    leaseMs: 60_000,
    shouldStop: () => false,
    log: (e) => void errors.push(e),
  });
  const row = async () => (await t.db.select().from(syncTasks).where(eq(syncTasks.taskId, taskId)))[0]!;
  const issues = () => t.db.select().from(dataQualityIssues);
  return { executor, claimed, row, issues, batchId, accountId, errors };
}

const writeIssue =
  (marker: string): TerminalHook =>
  async (tx, ctx) => {
    const [b] = await tx.select({ id: syncTasks.batchId }).from(syncTasks).limit(1);
    await recordIssue(tx, { code: "hook_probe", severity: "info", batchId: b!.id, discriminator: marker, detail: { status: ctx.status }, now: ctx.now });
  };

describe("onTerminal", () => {
  it("不可重试失败 → failed：钩子在同一事务里执行（任务终态与钩子写入同时可见）", async () => {
    const s = await setup(0, (onTerminal) => ({ kind: "failure", code: "list_author_mismatch", onTerminal }), writeIssue("a"));
    expect(await s.executor.execute(s.claimed)).toBe("failed");
    expect(await s.row()).toMatchObject({ status: "failed", lastErrorCode: "list_author_mismatch" });
    expect((await s.issues()).map((i) => i.detail)).toEqual([{ status: "failed" }]);
  });

  it("额度耗尽 → dead：钩子带 dead 状态执行", async () => {
    const s = await setup(2, (onTerminal) => ({ kind: "failure", code: "page_projection_failed", onTerminal }), writeIssue("b"));
    expect(await s.executor.execute(s.claimed)).toBe("dead");
    expect((await s.issues()).map((i) => i.detail)).toEqual([{ status: "dead" }]);
  });

  it("retry_wait 不执行钩子（任务还要续跑，不能封口）", async () => {
    const s = await setup(0, (onTerminal) => ({ kind: "failure", code: "page_projection_failed", onTerminal }), writeIssue("c"));
    expect(await s.executor.execute(s.claimed)).toBe("retry_wait");
    expect((await s.row()).status).toBe("retry_wait");
    expect(await s.issues()).toHaveLength(0);
  });

  it("钩子抛错：钩子的写入整笔回滚，框架不带钩子重写终态，任务不会停在 running", async () => {
    const throwing: TerminalHook = async (tx, ctx) => {
      await writeIssue("d")(tx, ctx);
      throw new Error("封口失败");
    };
    const s = await setup(0, (onTerminal) => ({ kind: "failure", code: "list_author_mismatch", onTerminal }), throwing);
    expect(await s.executor.execute(s.claimed)).toBe("failed");
    expect(await s.row()).toMatchObject({ status: "failed", leaseOwner: null });
    expect(await s.issues()).toHaveLength(0); // 钩子写的问题随回滚消失
    expect(s.errors).toHaveLength(1); // 记了日志
  });

  it("陈旧 fencing token：终态和钩子都不写", async () => {
    const s = await setup(0, (onTerminal) => ({ kind: "failure", code: "list_author_mismatch", onTerminal }), writeIssue("e"));
    await t.db.update(syncTasks).set({ fencingToken: 99n }).where(eq(syncTasks.taskId, s.claimed.task.taskId));
    expect(await s.executor.execute(s.claimed)).toBe("abandoned");
    expect(await s.issues()).toHaveLength(0);
    expect((await s.row()).status).toBe("running");
  });
});
