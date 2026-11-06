// 验收缺口补测（acceptance H5、I8、A17）：任务 10 对照 acceptance.md 发现原先没有对应用例的条目。
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { serviceActor } from "../../../tests/harness/actors";
import { useTestDb } from "../../../tests/harness/db";
import { insertBatch, insertContent, insertContentSnapshot } from "../../../tests/harness/factories";
import { FakeRuleSource, dispositionOf } from "../../../tests/harness/fake-rule-source";
import { loadFixtureBytes } from "../../../tests/harness/fixtures";
import { runPeriodic } from "../../../tests/harness/periodic";
import { setupSync } from "../../../tests/harness/sync-env";
import { externalAccountIdentifiers, externalAccounts, syncBatches } from "../../db/schema";
import { createAccountRunners, createDemandRunners } from "../sync-runner";

const t = useTestDb();
const DY_POST = "7676403385372904742";
async function world() {
  const env = await setupSync(t);
  const [dy] = await runPeriodic(t, env, [{ platform: "douyin", staffId: env.org.staffA, postIds: [DY_POST] }]);
  env.routeDetail(() => loadFixtureBytes("raw4.C05"));
  return { env, dy: dy!, cid: dy!.contentIds.get(DY_POST)!, source: new FakeRuleSource(env.demand, serviceActor()) };
}
const runAll = (env: Awaited<ReturnType<typeof world>>["env"]) => env.worker({ ...createAccountRunners(env.deps), ...createDemandRunners(env.deps) }).run({ untilIdle: true });

describe("H5：只有 building 快照的内容", () => {
  it("没有 finalized 快照 → content_not_found，不生成任务", async () => {
    const { env, dy, source } = await world();
    const batchId = await insertBatch(t.db, env.clock.now());
    const contentId = await insertContent(t.db, { platform: "douyin", accountId: dy.accountId, platformContentId: "ONLY-BUILDING", now: env.clock.now() });
    await insertContentSnapshot(t.db, { batchId, contentId, now: env.clock.now(), status: "building" });
    const r = await source.request([{ contentId, wants: ["detail"] }]);
    expect(dispositionOf(r, contentId, "detail")).toBe("content_not_found");
    expect(r.taskCount).toBe(0);
  });
});

describe("I8：详情作者不是被采集账号", () => {
  it("详情成功后不新建账号、不新增标识（返回作者按 tracer 规则保存，不建账号）", async () => {
    const { env, cid, source } = await world();
    const accounts = (await t.db.select().from(externalAccounts)).length;
    const identifiers = (await t.db.select().from(externalAccountIdentifiers)).length;
    await source.request([{ contentId: cid, wants: ["detail"] }]);
    await runAll(env);
    expect(await t.db.select().from(externalAccounts)).toHaveLength(accounts);
    expect(await t.db.select().from(externalAccountIdentifiers)).toHaveLength(identifiers);
  });
});

describe("A17：「本轮」以批次 started_at 为起点，不是 logical_at", () => {
  it("批次排队 1 小时才开始：在 logical_at 与 started_at 之间完成的详情，本轮不复用；用 logical_at 会误复用", async () => {
    const { env, cid, source } = await world();
    await source.request([{ contentId: cid, wants: ["detail"] }]);
    await runAll(env);
    const done = env.clock.now();
    // 把当前 full 批次改成「计划时点比详情早 1 小时、实际开始比详情晚 1 小时」
    await t.db
      .update(syncBatches)
      .set({ logicalAt: new Date(done.getTime() - 3600_000), startedAt: new Date(done.getTime() + 3600_000) })
      .where(eq(syncBatches.purpose, "full"));
    env.clock.advance(2 * 3600_000);
    const again = await source.request([{ contentId: cid, wants: ["detail"] }]);
    expect(dispositionOf(again, cid, "detail")).toBe("queued");
    // 对照：起点放回详情之前 → 复用
    await t.db.update(syncBatches).set({ startedAt: new Date(done.getTime() - 60_000) }).where(eq(syncBatches.purpose, "full"));
    const reused = await source.request([{ contentId: cid, wants: ["detail"] }]);
    expect(dispositionOf(reused, cid, "detail")).toBe("reused");
  });
});
