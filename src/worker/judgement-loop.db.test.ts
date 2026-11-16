// d-rule-engine 任务 11：`judgement serve` 的常驻循环——JP-20 / acceptance T6：收到停止信号时当前 tick 做完、释放租约后退出。
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { judgementPlanVersions, judgementRuns } from "../db/schema";
import { useTestDb } from "../../tests/harness/db";
import { addContent, addListTask, judgementEnv, judgementWorld } from "../../tests/harness/judgement";
import { runJudgementLoop } from "./judgement-loop";
const t = useTestDb();
const day = (d: number) => new Date(Date.UTC(2026, 10, d, 4));
const CFG = { window: { from: "2026-11-01", to: "2026-11-30" }, kinds: ["video"], layer1: { text: [{ fields: ["title"], mode: "any", keywords: ["海信"] }] } };
async function twoExecutions() {
  const w = await judgementWorld(t);
  const e = judgementEnv(t, w);
  await addListTask(t.db, { accountId: w.accZhao, status: "succeeded", at: day(6) });
  const c = await addContent(t.db, { accountId: w.accZhao, platformContentId: "a", kind: "video", like: 1, publishedAt: day(5) });
  e.fake.setValue("text.title_normalized", c.contentId, { state: "valid", usable: true, value: "海信新品", normalizerVersion: 1 });
  const runs: bigint[] = [];
  for (const alias of ["计划 A", "计划 B"]) {
    const { planId } = await e.plans.create(e.creator, { activityPlanId: w.planId, alias });
    await e.versions.setConfig(e.creator, planId, CFG);
    await t.db.update(judgementPlanVersions).set({ wizardStep: "circled" }).where(eq(judgementPlanVersions.planId, planId));
    runs.push((await e.runs.execute(e.creator, planId, { key: alias })).runId);
  }
  return { e, runs };
}
describe("runJudgementLoop", () => {
  it("没有可领的运行时按 pollSeconds 休眠；启动先跑一次 maintain；停止信号结束循环", async () => {
    const w = await judgementWorld(t);
    const e = judgementEnv(t, w);
    const stop = new AbortController();
    const sleeps: number[] = [];
    const logs: string[] = [];
    await runJudgementLoop(
      { judgement: { runs: e.runs, outcomes: e.outcomes, config: { pollSeconds: 7 } as never }, workerId: "w1", nowMs: () => 0, log: (_e, m) => void logs.push(m), sleep: async (ms) => void (sleeps.push(ms), sleeps.length >= 3 && stop.abort()) },
      stop.signal,
    );
    expect(sleeps).toEqual([7000, 7000, 7000]);
    expect(logs.filter((m) => m === "judgement.maintain")).toHaveLength(1);
  });
  it("T6：停止信号到来时当前 tick 做完并释放租约，不再领取下一个运行", async () => {
    const { e, runs } = await twoExecutions();
    const stop = new AbortController();
    const orig = e.fake.readMany.bind(e.fake);
    e.fake.readMany = async (...a) => {
      stop.abort(); // 第一个运行的 tick 进行中收到 SIGTERM
      return orig(...a);
    };
    await runJudgementLoop({ judgement: { runs: e.runs, outcomes: e.outcomes, config: { pollSeconds: 1 } as never }, workerId: "w1", nowMs: () => 0, log: () => {}, sleep: async () => {} }, stop.signal);
    const rows = await t.db.select().from(judgementRuns).orderBy(judgementRuns.runId);
    expect(rows.every((r) => r.status !== "running" && r.leaseOwner === null && r.leaseExpiresAt === null)).toBe(true); // 租约已释放
    expect(rows[0]).toMatchObject({ runId: runs[0], status: "completed" }); // 信号到来时在进行的 tick 做完了
    expect(rows[1]).toMatchObject({ runId: runs[1], status: "planned", fencingToken: 0n }); // 第二个没被领取
  });
  it("某一步抛错只记日志，循环继续", async () => {
    const w = await judgementWorld(t);
    const e = judgementEnv(t, w);
    const stop = new AbortController();
    const logs: string[] = [];
    let n = 0;
    const runs = { serveOnce: async () => { throw new Error("数据库闪断"); } } as unknown as typeof e.runs;
    await runJudgementLoop({ judgement: { runs, outcomes: e.outcomes, config: { pollSeconds: 1 } as never }, workerId: "w1", nowMs: () => 0, log: (_e, m) => void logs.push(m), sleep: async () => void (++n >= 2 && stop.abort()) }, stop.signal);
    expect(logs.filter((m) => m === "judgement.step_failed").length).toBeGreaterThanOrEqual(2);
  });
});
