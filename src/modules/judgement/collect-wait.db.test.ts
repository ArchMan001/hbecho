// d-wait-collection：执行前等待参与账号的列表采集完成；「未获取成功」拆成「采集中」与「采集失败」。离线，真实 MySQL。
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { judgementPlanVersions, judgementRuns, runParticipants, syncTasks } from "../../db/schema";
import { useTestDb } from "../../../tests/harness/db";
import { addContent, addListTask, judgementEnv, judgementWorld } from "../../../tests/harness/judgement";
const t = useTestDb();
const day = (d: number) => new Date(Date.UTC(2026, 10, d, 4));
const CFG = { window: { from: "2026-11-01", to: "2026-11-30" }, kinds: ["video"], layer1: { text: [{ fields: ["title"], mode: "any", keywords: ["海信"] }], quantity: { n: 1 } } };
async function setup(config: Record<string, number> = {}) {
  const w = await judgementWorld(t);
  const e = judgementEnv(t, w, { config });
  const { planId } = await e.plans.create(e.creator, { activityPlanId: w.planId, alias: "等待采集" });
  await e.versions.setConfig(e.creator, planId, CFG);
  await t.db.update(judgementPlanVersions).set({ wizardStep: "compared" }).where(and(eq(judgementPlanVersions.planId, planId), eq(judgementPlanVersions.status, "draft")));
  return { w, e, planId };
}
const partOf = async (runId: bigint) => (await t.db.select().from(runParticipants).where(eq(runParticipants.runId, runId)))[0]!;
describe("执行前等待列表采集", () => {
  it("没有「采集中」的账号：不进入等待，直接判定（零内容账号 + 列表已成功 → 完整）", async () => {
    const { w, e, planId } = await setup();
    await addListTask(t.db, { accountId: w.accZhao, status: "succeeded", at: day(6) });
    const waits: string[] = [];
    e.onSleep.fn = () => {
      waits.push("slept");
    };
    const r = await e.runs.execute(e.creator, planId, { key: "k1" });
    const done = await e.runs.drive(r.runId, "w", e.sleep);
    expect(done.status).toBe("completed");
    expect(waits).toEqual([]);
    expect((await partOf(r.runId)).syncComplete).toBe(true);
  });
  it("有账号的列表任务还在排队：先进入「等待列表采集」，任务终态后继续；最终结果基于最新数据（不再误报）", async () => {
    const { w, e, planId } = await setup();
    await addListTask(t.db, { accountId: w.accZhao, status: "pending", at: day(6) });
    const seen: Array<{ status: string; waitingOn: string | null; pending: number | null }> = [];
    let finished = false;
    e.onSleep.fn = async () => {
      const [run] = await t.db.select().from(judgementRuns);
      const brief = (await e.views.detail(e.creator, run!.planId)).executions.find((x) => x.runId === String(run!.runId))!;
      seen.push({ status: run!.status, waitingOn: brief.waitingOn, pending: brief.collectWait?.pendingAccounts ?? null });
      if (!finished && seen.length >= 2) {
        finished = true;
        await t.db.update(syncTasks).set({ status: "succeeded", finishedAt: e.clock.now() }).where(eq(syncTasks.requestedAction, "fetch_content_list"));
      }
    };
    const r = await e.runs.execute(e.creator, planId, { key: "k2" });
    const done = await e.runs.drive(r.runId, "w", e.sleep);
    expect(done.status).toBe("completed");
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen[0]).toMatchObject({ waitingOn: "collection", pending: 1 });
    const p = await partOf(r.runId);
    expect(p.syncComplete).toBe(true); // 等到任务终态后才判，不是「采集中」
    expect(p.syncReason).toBeNull();
  });
  it("等待超时：继续判定，仍在采集的账号记 sync_pending（采集中），不是 sync_failed", async () => {
    const { w, e, planId } = await setup({ waitCollectSeconds: 60 });
    await addListTask(t.db, { accountId: w.accZhao, status: "pending", at: day(6) });
    const r = await e.runs.execute(e.creator, planId, { key: "k3" });
    const done = await e.runs.drive(r.runId, "w", e.sleep);
    expect(done.status).toBe("completed");
    const p = await partOf(r.runId);
    expect(p.syncComplete).toBe(false);
    expect(p.syncReason).toBe("sync_pending");
    const detail = await e.views.executionDetail(e.creator, r.runId);
    expect(detail.syncPending).toBe(1);
  });
  it("终态失败的账号不阻塞：不等待，原因 sync_failed（采集失败）", async () => {
    const { w, e, planId } = await setup();
    await addListTask(t.db, { accountId: w.accZhao, status: "failed", at: day(6) });
    let slept = 0;
    e.onSleep.fn = () => void slept++;
    const r = await e.runs.execute(e.creator, planId, { key: "k4" });
    await e.runs.drive(r.runId, "w", e.sleep);
    expect(slept).toBe(0);
    const p = await partOf(r.runId);
    expect(p.syncReason).toBe("sync_failed");
  });
  it("等待上限为 0：不等待，直接判定", async () => {
    const { w, e, planId } = await setup({ waitCollectSeconds: 0 });
    await addListTask(t.db, { accountId: w.accZhao, status: "pending", at: day(6) });
    let slept = 0;
    e.onSleep.fn = () => void slept++;
    const r = await e.runs.execute(e.creator, planId, { key: "k5" });
    await e.runs.drive(r.runId, "w", e.sleep);
    expect(slept).toBe(0);
    expect((await partOf(r.runId)).syncReason).toBe("sync_pending");
  });
});
void addContent;
