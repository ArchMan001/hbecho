// 任务 5 端到端：真实调度器规划 → 真实 worker 领取 → 两个 Runner → 批次由 tick 汇总。三个平台、失败隔离。全程离线。
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { useTestDb } from "../../../tests/harness/db";
import { loadFixtureBytes } from "../../../tests/harness/fixtures";
import { PROFILE_PATH, SLOT, setupSync } from "../../../tests/harness/sync-env";
import { providerIdOf } from "../../../tests/harness/seed";
import { accountProfileSnapshots, contentSnapshots, contents, externalAccounts, syncBatches, syncCheckpoints, syncSettings } from "../../db/schema";
import { createAccountRunners } from "./account-runners";

const t = useTestDb();

async function threePlatforms() {
  const env = await setupSync(t);
  const d = await env.addAccount("douyin", env.org.staffA);
  const x = await env.addAccount("xiaohongshu", env.org.staffB);
  const k = await env.addAccount("kuaishou", env.org.staffC);
  const loc = (a: { accountId: bigint }) => env.locatorOf(a.accountId);
  return { env, d, x, k, loc };
}

describe("周期批次：三平台账号主页 + 列表", () => {
  it("每个账号一份主页快照 + 整页内容 + 检查点；批次终态由 tick 汇总为 succeeded（无缺口）", async () => {
    const { env, d, x, k, loc } = await threePlatforms();
    env.routeBy(PROFILE_PATH, { [loc(d)]: "raw3.douyin.media_user_info", [loc(x)]: "raw3.xiaohongshu.media_user_info", [loc(k)]: "raw12.K1" });
    const listFixture: Record<string, string> = { [loc(d)]: "raw3.douyin.user_video_list", [loc(x)]: "raw3.xiaohongshu.user_video_list", [loc(k)]: "raw12.K3" };
    env.routeList(({ url }) => loadFixtureBytes(listFixture[url]!));
    await env.scheduler.tick(SLOT);
    const stats = await env.worker(createAccountRunners(env.deps)).run({ untilIdle: true });
    expect(stats.done).toBe(6);

    expect(await t.db.select().from(accountProfileSnapshots)).toHaveLength(3);
    const perAccount = async (id: bigint) => (await t.db.select().from(contents).where(eq(contents.accountId, id))).length;
    expect([await perAccount(d.accountId), await perAccount(x.accountId), await perAccount(k.accountId)]).toEqual([20, 21, 20]);
    const snaps = await t.db.select().from(contentSnapshots);
    expect(snaps).toHaveLength(61);
    expect(snaps.every((s) => s.snapshotStatus === "finalized")).toBe(true);
    expect(await t.db.select().from(syncCheckpoints)).toHaveLength(3);
    for (const a of [d, x, k]) {
      const [acct] = await t.db.select().from(externalAccounts).where(eq(externalAccounts.accountId, a.accountId));
      expect(acct).toMatchObject({ status: "active" });
      expect(acct!.currentProfileSnapshotId).not.toBeNull();
    }
    expect((await env.tasks()).every((x) => x.status === "succeeded")).toBe(true);

    await env.scheduler.tick(SLOT); // 汇总
    const [batch] = await t.db.select().from(syncBatches);
    expect(batch).toMatchObject({ status: "succeeded", plannedTaskCount: 6, succeededTaskCount: 6, failedTaskCount: 0, gapTaskCount: 0 });
    expect(env.transport.calls).toHaveLength(6); // 每个任务恰好一次调用
  });

  it("失败隔离：一个账号的主页反复 5xx 直至 dead，其余账号不受影响；批次 partial_succeeded；失败账号没有空快照、状态不变", async () => {
    const { env, d, x, k, loc } = await threePlatforms();
    const down = { httpStatus: 503, body: new TextEncoder().encode('{"code":"UNAVAILABLE"}') };
    env.routeBy(PROFILE_PATH, { [loc(d)]: down, [loc(x)]: "raw3.xiaohongshu.media_user_info", [loc(k)]: "raw12.K1" });
    const listFixture: Record<string, string> = { [loc(d)]: "raw3.douyin.user_video_list", [loc(x)]: "raw3.xiaohongshu.user_video_list", [loc(k)]: "raw12.K3" };
    env.routeList(({ url }) => loadFixtureBytes(listFixture[url]!));
    await env.scheduler.tick(SLOT);
    for (let i = 0; i < 3; i++) {
      await env.worker(createAccountRunners(env.deps)).run({ untilIdle: true });
      env.clock.advance(10 * 60_000);
    }
    const tasks = await env.tasks();
    const dead = tasks.filter((x) => x.status === "dead");
    expect(dead.map((x) => [x.accountId, x.requestedAction])).toEqual([[d.accountId, "fetch_profile"]]);
    expect(tasks.filter((x) => x.status === "succeeded")).toHaveLength(5);
    const profiles = await t.db.select().from(accountProfileSnapshots);
    expect(profiles.map((p) => p.accountId).sort()).toEqual([x.accountId, k.accountId].sort());
    const [acct] = await t.db.select().from(externalAccounts).where(eq(externalAccounts.accountId, d.accountId));
    expect(acct).toMatchObject({ status: "active", currentProfileSnapshotId: null });

    await env.scheduler.tick(env.clock.now());
    const [batch] = await t.db.select().from(syncBatches);
    expect(batch).toMatchObject({ status: "partial_succeeded", succeededTaskCount: 5, failedTaskCount: 1 });
  });

  it("带缺口的列表任务使批次至少为 partial_succeeded，即使没有失败任务（v2 §9.4 第 14 条）", async () => {
    const { env, d, x, k, loc } = await threePlatforms();
    env.routeBy(PROFILE_PATH, { [loc(d)]: "raw3.douyin.media_user_info", [loc(x)]: "raw3.xiaohongshu.media_user_info", [loc(k)]: "raw12.K1" });
    const listFixture: Record<string, string> = { [loc(d)]: "raw3.douyin.user_video_list", [loc(x)]: "raw3.xiaohongshu.user_video_list", [loc(k)]: "raw12.K3" };
    env.routeList(({ url }) => loadFixtureBytes(listFixture[url]!));
    // 抖音账号有旧锚点且第 1 页不命中、has_more=true、安全页数 1 → 缺口
    await t.db.update(syncSettings).set({ listSafetyPageLimit: 1 });
    await t.db.insert(syncCheckpoints).values({ accountId: d.accountId, providerId: await providerIdOf(t.db), anchorMode: "id_window", highWatermarkContentIds: ["NOT-ON-PAGE"], continuityStatus: "ready", version: 1n, updatedAt: env.clock.now() });
    await env.scheduler.tick(SLOT);
    await env.worker(createAccountRunners(env.deps)).run({ untilIdle: true });
    await env.scheduler.tick(SLOT);
    const [batch] = await t.db.select().from(syncBatches);
    expect(batch).toMatchObject({ status: "partial_succeeded", failedTaskCount: 0, gapTaskCount: 1, succeededTaskCount: 6 });
  });
});
