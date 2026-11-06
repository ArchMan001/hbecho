// 自比对（FS-5.14；acceptance E22）：两周真实流程——第 1 周首次基线 + 主页，第 2 周增量 + 主页。
// 第 2 周的页内容是**合成**的（tests/harness/list-bytes.ts，结构取自 raw3 形态）。
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { resetData, useTestDb } from "../../../tests/harness/db";
import { envelope } from "../../../tests/harness/decode-helpers";
import { listBytes, type SyntheticEntry } from "../../../tests/harness/list-bytes";
import { PROFILE_PATH, SLOT, setupSync, type SyncEnv } from "../../../tests/harness/sync-env";
import { dataQualityIssues, syncTasks } from "../../db/schema";
import { createAccountRunners } from "./account-runners";

const t = useTestDb();
const WEEK = 7 * 24 * 3600 * 1000;
const run = (env: SyncEnv) => env.worker(createAccountRunners(env.deps)).run({ untilIdle: true });
const issues = () => t.db.select().from(dataQualityIssues).then((r) => r.filter((i) => i.issueCode === "suspected_missing_content"));

const entry = (postId: string, createdMs: number): SyntheticEntry => ({ postId, userId: "HITACHI1", createdMs });
const profile = (post: number | null | "absent") =>
  envelope("media_user_info", `{"user_id":"HITACHI1","follower_number":10${post === "absent" ? "" : `,"post_number":${post}`}}`);

/** 第 1 周：首次基线（w0、w1、w2，时间递减）。第 2 周：n0..n(new-1) 是新内容（时间更晚），后面接 w0、w1、w2（w1 在位置 ≥3 → 命中旧边界）。 */
async function twoWeeks(o: { post1: number | "absent"; post2: number; newContents: number; order?: "profile_first" | "list_first" }) {
  await resetData(t.pool); // 同一用例里会多次调用
  const env = await setupSync(t);
  const a = await env.addAccount("douyin", env.org.staffA, { identifier: "HITACHI1" });
  const loc = env.locatorOf(a.accountId);
  const w = [entry("w0", 1788100000000), entry("w1", 1788000000000), entry("w2", 1787900000000)];

  env.routeBy(PROFILE_PATH, { [loc]: profile(o.post1) });
  env.routeList(() => listBytes(w, { hasMore: false, cursorJson: "0" }));
  await env.scheduler.tick(SLOT);
  await run(env);

  const next = new Date(SLOT.getTime() + WEEK);
  env.clock.set(next);
  env.transport.clearRoutes();
  env.routeBy(PROFILE_PATH, { [loc]: profile(o.post2) });
  const fresh = Array.from({ length: o.newContents }, (_, i) => entry(`n${i}`, 1788500000000 - i * 1000));
  // 位置 0–2 是置顶位置，不作边界证据：新内容 2 条 + w0（位置 2），w1 在位置 3 → 命中旧边界
  env.routeList(() => listBytes([...fresh, ...w], { hasMore: true, cursorJson: "1000" }));
  await env.scheduler.tick(next);
  if (o.order === "list_first") {
    const [listTask] = (await env.tasks("fetch_content_list")).filter((x) => x.requestedAction === "fetch_content_list").slice(-1);
    await t.db.update(syncTasks).set({ priority: 50 }).where(eq(syncTasks.taskId, listTask!.taskId)); // 列表先领取
  }
  await run(env);
  const finishOrder = env.transport.calls.slice(-2).map((c) => (c.request.path === PROFILE_PATH ? "profile" : "list"));
  return { env, a, finishOrder };
}

describe("suspected_missing_content", () => {
  it("作品数 +5、本批次首次发现 2 条 → 警告级问题（k=5、discovered=2）；任务与检查点不受影响（E22）", async () => {
    const { env, a } = await twoWeeks({ post1: 100, post2: 105, newContents: 2 });
    const found = await issues();
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ severity: "warning", status: "open", accountId: a.accountId });
    expect(found[0]!.detail).toMatchObject({ k: "5", discovered: 2 });
    const lists = (await env.tasks("fetch_content_list")).slice(-1);
    expect(lists[0]).toMatchObject({ status: "succeeded", stopReason: "boundary_hit", continuityGapDetected: false }); // 不使任务失败或带缺口
  });

  it("两个任务谁先结束都只报一次：列表先结束 → 由主页事务触发；主页先结束 → 由列表封口事务触发", async () => {
    const profileFirst = await twoWeeks({ post1: 100, post2: 105, newContents: 2, order: "profile_first" });
    expect(profileFirst.finishOrder).toEqual(["profile", "list"]);
    expect(await issues()).toHaveLength(1);
    const listFirst = await twoWeeks({ post1: 100, post2: 105, newContents: 2, order: "list_first" });
    expect(listFirst.finishOrder).toEqual(["list", "profile"]);
    expect(await issues()).toHaveLength(1);
  });

  it("不报：+0；负增长；发现数不少于增量；上周主页作品数缺失；首次基线", async () => {
    for (const c of [
      { post1: 100, post2: 100, newContents: 2 },
      { post1: 100, post2: 98, newContents: 2 },
      { post1: 100, post2: 102, newContents: 2 }, // k=2，发现 2
      { post1: "absent" as const, post2: 105, newContents: 2 }, // 上周 missing
    ]) {
      await twoWeeks(c);
      expect(await issues(), JSON.stringify(c)).toHaveLength(0);
    }
  });

  it("第一周（首次基线，只有一份主页快照）：没有「上一份更早的主页」，不比对", async () => {
    const env = await setupSync(t);
    const a = await env.addAccount("douyin", env.org.staffA, { identifier: "HITACHI1" });
    env.routeBy(PROFILE_PATH, { [env.locatorOf(a.accountId)]: profile(500) });
    env.routeList(() => listBytes([entry("w0", 1788100000000)], { hasMore: false, cursorJson: "0" }));
    await env.scheduler.tick(SLOT);
    await run(env);
    expect(await issues()).toHaveLength(0);
  });
});
