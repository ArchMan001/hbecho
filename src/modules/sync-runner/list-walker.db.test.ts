// ListWalker（FS-5、FS-6、FS-7；acceptance E/F/G）：真实调度器规划 + 真实 worker + fixture transport，全程离线。
// 多页用例的页内容是**合成**的（tests/harness/list-bytes.ts，结构取自 raw3 形态），文件里每处都标明；真实条目用 raw3 / raw12 / raw13 fixture。
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { resetData, useTestDb } from "../../../tests/harness/db";
import { loadFixtureBytes } from "../../../tests/harness/fixtures";
import { listBytes, type SyntheticEntry } from "../../../tests/harness/list-bytes";
import { providerIdOf } from "../../../tests/harness/seed";
import { SLOT, setupSync, type SyncEnv } from "../../../tests/harness/sync-env";
import { contentSnapshots, contents, dataQualityIssues, externalAccountIdentifiers, externalAccounts, syncCheckpoints, syncSettings } from "../../db/schema";
import { decodeVideoList } from "../provider-adapter";
import { createListWalker } from "./list-walker";

const t = useTestDb();
const run = (env: SyncEnv) => env.worker({ fetch_content_list: createListWalker(env.deps) }).run({ untilIdle: true });
const listTask = async (env: SyncEnv, accountId: bigint) => (await env.tasks("fetch_content_list")).find((x) => x.accountId === accountId)!;
const snaps = () => t.db.select().from(contentSnapshots);
const checkpoint = async () => (await t.db.select().from(syncCheckpoints))[0];
const issues = (code?: string) => t.db.select().from(dataQualityIssues).then((r) => (code ? r.filter((i) => i.issueCode === code) : r));
const summary = (x: { resultSummary: unknown }) => x.resultSummary as { pages_done: number; entries_done: number; identity_check: { state: string; known_author_entries: number; matched_entries: number; baseline_has_registered: boolean }; final?: Record<string, unknown> };

async function putCheckpoint(
  env: SyncEnv,
  accountId: bigint,
  a: { mode: "time" | "id_window" | "empty"; ids?: string[]; hw?: Date; continuity?: string; version?: bigint },
) {
  await t.db.insert(syncCheckpoints).values({
    accountId,
    providerId: await providerIdOf(t.db),
    anchorMode: a.mode,
    highWatermarkPublishedAt: a.mode === "time" ? (a.hw ?? new Date(1788169004000)) : null,
    highWatermarkContentIds: a.mode === "empty" ? [] : (a.ids ?? ["OLD"]),
    continuityStatus: a.continuity ?? "ready",
    version: a.version ?? 1n,
    updatedAt: env.clock.now(),
  });
}
const setSafety = (n: number) => t.db.update(syncSettings).set({ listSafetyPageLimit: n });

/** 合成条目：作者默认 HITACHI1（与 raw3 抖音主页 user_id 一致）；时间递减，id 前缀区分页。 */
const syn = (prefix: string, n: number, o: { base?: number; ids?: Record<number, string> } = {}): SyntheticEntry[] =>
  Array.from({ length: n }, (_, i) => ({ postId: o.ids?.[i] ?? `${prefix}${i}`, userId: "HITACHI1", createdMs: (o.base ?? 1788169004000) - i * 1000 }));
const page = (entries: SyntheticEntry[], hasMore: boolean, cursor: number) => listBytes(entries, { hasMore, cursorJson: String(cursor) });

describe("三平台首次基线（真实 fixture）", () => {
  it("抖音 raw3：20 条含 1 条异作者整页处理；current 已切换；检查点 time/ready/version 1；第二标识 sec_uid 绑定；异作者不建账号；身份 verified", async () => {
    const env = await setupSync(t);
    const a = await env.addAccount("douyin", env.org.staffA);
    env.routeList(() => loadFixtureBytes("raw3.douyin.user_video_list"));
    await env.scheduler.tick(SLOT);
    expect((await run(env)).done).toBe(1);

    const task = await listTask(env, a.accountId);
    expect(task).toMatchObject({ status: "succeeded", stopReason: "initial_limit", pageCount: 1, fetchedItemCount: 20, continuityGapDetected: false });
    const rows = await snaps();
    expect(rows).toHaveLength(20);
    expect(rows.every((s) => s.snapshotStatus === "finalized" && s.finalizedAt !== null)).toBe(true);
    const cs = await t.db.select().from(contents);
    expect(cs.every((c) => c.currentSnapshotId !== null)).toBe(true);
    expect(await checkpoint()).toMatchObject({ anchorMode: "time", continuityStatus: "ready", version: 1n, lastSuccessfulBatchId: task.batchId });
    const ids = await t.db.select().from(externalAccountIdentifiers).where(eq(externalAccountIdentifiers.accountId, a.accountId));
    expect(ids.map((i) => i.namespaceCode).sort()).toEqual(["douyin.sec_uid", "douyin.user_id"]);
    expect(await t.db.select().from(externalAccounts)).toHaveLength(1); // HITACHI2023 的内容保留，但不建账号
    const s = summary(task);
    expect(s.identity_check.state).toBe("verified");
    expect(s.identity_check.matched_entries).toBeGreaterThan(0);
    expect(s.identity_check.matched_entries).toBeLessThan(s.identity_check.known_author_entries);
    expect(s.final).toMatchObject({ checkpoint: "created", finalized_snapshots: 20 });
  });

  it("小红书 raw3：21 条首页全部处理（不为凑 20 条丢第 21 条）；主导作者绑定；没有登记作者标识 → unverifiable，不判错", async () => {
    const env = await setupSync(t);
    const a = await env.addAccount("xiaohongshu", env.org.staffB);
    env.routeList(() => loadFixtureBytes("raw3.xiaohongshu.user_video_list"));
    await env.scheduler.tick(SLOT);
    await run(env);
    expect(await snaps()).toHaveLength(21);
    const bound = await t.db.select().from(externalAccountIdentifiers).where(and(eq(externalAccountIdentifiers.accountId, a.accountId), eq(externalAccountIdentifiers.namespaceCode, "xiaohongshu.content.user_id")));
    expect(bound).toHaveLength(1);
    expect(bound[0]!.bindingMethod).toBe("dominant_list_author");
    const s = summary(await listTask(env, a.accountId));
    expect(s.identity_check).toMatchObject({ state: "unverifiable", baseline_has_registered: false });
    expect((await listTask(env, a.accountId)).status).toBe("succeeded");
  });

  it("快手 raw12 K3：20 条 + has_more=true + max_cursor=no_more → 整页处理；记 cursor_no_more_with_has_more；请求里从没有 no_more（G5）", async () => {
    const env = await setupSync(t);
    const a = await env.addAccount("kuaishou", env.org.staffC);
    env.routeList(() => loadFixtureBytes("raw12.K3"));
    await env.scheduler.tick(SLOT);
    await run(env);
    expect(await snaps()).toHaveLength(20);
    expect(await issues("cursor_no_more_with_has_more")).toHaveLength(1);
    expect(env.listCursors()).toEqual(["0"]);
    expect(env.listCursors().join("")).not.toContain("no_more");
    expect((await listTask(env, a.accountId)).status).toBe("succeeded");
    expect(await t.db.select().from(externalAccountIdentifiers).where(eq(externalAccountIdentifiers.namespaceCode, "kuaishou.sec_uid"))).toHaveLength(0); // 快手无第二标识
  });

  it("快手 K3 + 旧 id_window 锚点：命中（旧 ID 在第 4 位之后）→ 成功且仍记游标异常；未命中 → succeeded_with_gap / cursor_anomaly_rebased、window_overflow=FALSE；都不回发 no_more（E26）", async () => {
    const k3 = decodeVideoList("kuaishou", loadFixtureBytes("raw12.K3"));
    const ids = k3.outcome === "decoded" ? k3.data.entries.map((e) => (e.postId.state === "value" ? e.postId.value : "")) : [];
    for (const [anchorIds, expected] of [
      [[ids[6]!], { status: "succeeded", stopReason: "boundary_hit", gap: false }],
      [["NOT-ON-THE-PAGE"], { status: "succeeded_with_gap", stopReason: "cursor_anomaly_rebased", gap: true }],
    ] as const) {
      await resetData(t.pool);
      const env = await setupSync(t);
      const a = await env.addAccount("kuaishou", env.org.staffC);
      await putCheckpoint(env, a.accountId, { mode: "id_window", ids: [...anchorIds] });
      env.routeList(() => loadFixtureBytes("raw12.K3"));
      await env.scheduler.tick(SLOT);
      await run(env);
      expect(await listTask(env, a.accountId)).toMatchObject({ status: expected.status, stopReason: expected.stopReason, continuityGapDetected: expected.gap, windowOverflowDetected: false, pageCount: 1 });
      expect(await issues("cursor_no_more_with_has_more")).toHaveLength(1);
      expect(env.listCursors()).toEqual(["0"]);
    }
  });

  it("快手 K6：0 条 + has_more=true + no_more。首次 → 建 empty 锚点（记游标异常）；有旧锚点 → blocked 且旧锚点不被覆盖（G6、E10）", async () => {
    const first = await setupSync(t);
    const a = await first.addAccount("kuaishou", first.org.staffC);
    first.routeList(() => loadFixtureBytes("raw12.K6"));
    await first.scheduler.tick(SLOT);
    await run(first);
    expect(await listTask(first, a.accountId)).toMatchObject({ status: "succeeded", stopReason: "empty_list" });
    expect(await checkpoint()).toMatchObject({ anchorMode: "empty", continuityStatus: "ready", highWatermarkContentIds: [] });
    expect(await issues("cursor_no_more_with_has_more")).toHaveLength(1);
  });

  it("快手 K6 + 旧 time 锚点：succeeded_with_gap / empty_window_not_rebased；检查点 blocked，旧锚点原样", async () => {
    const env = await setupSync(t);
    const a = await env.addAccount("kuaishou", env.org.staffC);
    await putCheckpoint(env, a.accountId, { mode: "time", ids: ["K-OLD"], hw: new Date(1789000000000) });
    env.routeList(() => loadFixtureBytes("raw12.K6"));
    await env.scheduler.tick(SLOT);
    await run(env);
    expect(await listTask(env, a.accountId)).toMatchObject({ status: "succeeded_with_gap", stopReason: "empty_window_not_rebased", continuityGapDetected: true, windowOverflowDetected: false });
    expect(await checkpoint()).toMatchObject({ anchorMode: "time", highWatermarkContentIds: ["K-OLD"], continuityStatus: "blocked", version: 2n });
    expect((await checkpoint())!.highWatermarkPublishedAt!.getTime()).toBe(1789000000000);
    expect(await issues("empty_window_not_rebased")).toHaveLength(1);
  });

  it("快手 raw13 L3（23 条）+ L4（20 条）两页：游标 1.785394950371E12 作为字符串原样回发；安全页数 2 → 缺口并重建锚点（G4、E7、E9）", async () => {
    const env = await setupSync(t);
    await setSafety(2);
    const a = await env.addAccount("kuaishou", env.org.staffC, { identifier: "3x8en3bfsqc7qyk" }); // L3 / L4 的作者
    await putCheckpoint(env, a.accountId, { mode: "id_window", ids: ["NOT-ON-ANY-PAGE"] });
    env.routeList(({ cursor }) => loadFixtureBytes(cursor === "0" ? "raw13.L3" : "raw13.L4"));
    await env.scheduler.tick(SLOT);
    await run(env);
    expect(env.listCursors()).toEqual(["0", '"1.785394950371E12"']);
    const task = await listTask(env, a.accountId);
    expect(task).toMatchObject({ status: "succeeded_with_gap", stopReason: "safety_limit_rebased", continuityGapDetected: true, windowOverflowDetected: true, pageCount: 2, fetchedItemCount: 43, hasMoreAtStop: true });
    expect(await snaps()).toHaveLength(43);
    expect(await checkpoint()).toMatchObject({ anchorMode: "time", continuityStatus: "rebased_after_gap", version: 2n });
    expect((await checkpoint())!.lastGapAt).not.toBeNull();
    expect(await issues("continuity_gap")).toHaveLength(1);
    expect(await issues("window_overflow")).toHaveLength(1);
  });
});

describe("多页走法（合成页，条目形态取自 raw3）", () => {
  it("命中边界在第 2 页：整页处理后停止，不请求第 3 页；第 2 次请求回发第 1 页的游标；锚点重建、版本 +1", async () => {
    const env = await setupSync(t);
    const a = await env.addAccount("douyin", env.org.staffA, { identifier: "HITACHI1" });
    await putCheckpoint(env, a.accountId, { mode: "id_window", ids: ["OLD"] });
    env.routeList(({ cursor }) => (cursor === "0" ? page(syn("a", 5), true, 1000) : page(syn("b", 4, { ids: { 1: "OLD" }, base: 1788000000000 }), true, 2000)));
    await env.scheduler.tick(SLOT);
    await run(env);
    expect(env.listCursors()).toEqual(["0", "1000"]);
    expect(await listTask(env, a.accountId)).toMatchObject({ status: "succeeded", stopReason: "boundary_hit", pageCount: 2, fetchedItemCount: 9, continuityGapDetected: false });
    expect(await snaps()).toHaveLength(9);
    expect(await checkpoint()).toMatchObject({ anchorMode: "time", continuityStatus: "ready", version: 2n });
    expect(await issues("continuity_gap")).toHaveLength(0);
  });

  it("命中边界在第 3 页", async () => {
    const env = await setupSync(t);
    const a = await env.addAccount("douyin", env.org.staffA, { identifier: "HITACHI1" });
    await putCheckpoint(env, a.accountId, { mode: "id_window", ids: ["OLD"] });
    env.routeList(({ cursor }) => (cursor === "0" ? page(syn("a", 5), true, 1000) : cursor === "1000" ? page(syn("b", 5), true, 2000) : page(syn("c", 3, { ids: { 2: "OLD" } }), true, 3000)));
    await env.scheduler.tick(SLOT);
    await run(env);
    expect(env.listCursors()).toEqual(["0", "1000", "2000"]);
    expect(await listTask(env, a.accountId)).toMatchObject({ status: "succeeded", stopReason: "boundary_hit", pageCount: 3 });
  });

  it("安全页数 = 2、三页都未命中且 has_more=true：停在第 2 页，缺口 + window_overflow，批次级别由 tick 汇总（E7、E9）", async () => {
    const env = await setupSync(t);
    await setSafety(2);
    const a = await env.addAccount("douyin", env.org.staffA, { identifier: "HITACHI1" });
    await putCheckpoint(env, a.accountId, { mode: "id_window", ids: ["OLD"] });
    env.routeList(({ cursor }) => (cursor === "0" ? page(syn("a", 5), true, 1000) : page(syn("b", 5), true, 2000)));
    await env.scheduler.tick(SLOT);
    await run(env);
    expect(env.listCursors()).toEqual(["0", "1000"]); // 不请求第 3 页
    expect(await listTask(env, a.accountId)).toMatchObject({ status: "succeeded_with_gap", stopReason: "safety_limit_rebased", windowOverflowDetected: true });
    expect(await checkpoint()).toMatchObject({ continuityStatus: "rebased_after_gap", version: 2n });
    // 重建的锚点来自本轮已获取的全部内容：最大时间 = 第 1 页首条
    expect((await checkpoint())!.highWatermarkPublishedAt!.getTime()).toBe(1788169004000);
  });

  it("has_more=false 仍未命中：end_of_list_rebased，window_overflow=false（E8）", async () => {
    const env = await setupSync(t);
    const a = await env.addAccount("douyin", env.org.staffA, { identifier: "HITACHI1" });
    await putCheckpoint(env, a.accountId, { mode: "id_window", ids: ["OLD"] });
    env.routeList(({ cursor }) => (cursor === "0" ? page(syn("a", 5), true, 1000) : page(syn("b", 2), false, 2000)));
    await env.scheduler.tick(SLOT);
    await run(env);
    expect(await listTask(env, a.accountId)).toMatchObject({ status: "succeeded_with_gap", stopReason: "end_of_list_rebased", windowOverflowDetected: false, continuityGapDetected: true });
    expect(await issues("window_overflow")).toHaveLength(0);
  });

  it("旧 time 锚点：高水位 ID 出现在首页位置 0–1（置顶）不停止，继续到第 2 页；等于高水位时间但 ID 不在集合内也继续（E2、E4）", async () => {
    const env = await setupSync(t);
    const a = await env.addAccount("douyin", env.org.staffA, { identifier: "HITACHI1" });
    const hw = new Date(1788000000000);
    await putCheckpoint(env, a.accountId, { mode: "time", ids: ["HW"], hw });
    env.routeList(({ cursor }) =>
      cursor === "0"
        ? // 位置 0 命中高水位 ID（置顶位置，不作证据）；位置 3 与高水位同时间但 ID 不同（不命中）
          page([{ postId: "HW", userId: "HITACHI1", createdMs: 1788000000000 }, ...syn("a", 3, { base: 1788100000000 }), { postId: "SAME-TIME", userId: "HITACHI1", createdMs: 1788000000000 }], true, 1000)
        : page([{ postId: "OLDER", userId: "HITACHI1", createdMs: 1787000000000 }], false, 2000),
    );
    await env.scheduler.tick(SLOT);
    await run(env);
    expect(env.listCursors()).toEqual(["0", "1000"]);
    // 第 2 页的 OLDER 严格早于高水位 → 命中
    expect(await listTask(env, a.accountId)).toMatchObject({ status: "succeeded", stopReason: "boundary_hit", pageCount: 2 });
  });

  it("第 1 页不足 4 条、has_more=false、置顶位置的 ID 命中旧集合：完整处理，不误判缺口（E19）", async () => {
    const env = await setupSync(t);
    const a = await env.addAccount("douyin", env.org.staffA, { identifier: "HITACHI1" });
    await putCheckpoint(env, a.accountId, { mode: "id_window", ids: ["OLD"] });
    env.routeList(() => page(syn("a", 2, { ids: { 1: "OLD" } }), false, 0));
    await env.scheduler.tick(SLOT);
    await run(env);
    expect(await listTask(env, a.accountId)).toMatchObject({ status: "succeeded", stopReason: "boundary_hit", continuityGapDetected: false });
  });

  it("empty 锚点 + 首页 5 条：重建锚点、成功、没有缺口；has_more=true 也不翻页（E24）", async () => {
    const env = await setupSync(t);
    const a = await env.addAccount("douyin", env.org.staffA, { identifier: "HITACHI1" });
    await putCheckpoint(env, a.accountId, { mode: "empty" });
    env.routeList(() => page(syn("a", 5), true, 1000));
    await env.scheduler.tick(SLOT);
    await run(env);
    expect(env.listCursors()).toEqual(["0"]);
    expect(await listTask(env, a.accountId)).toMatchObject({ status: "succeeded", stopReason: "baseline", continuityGapDetected: false });
    expect(await checkpoint()).toMatchObject({ anchorMode: "time", continuityStatus: "ready", version: 2n });
    expect(await issues("continuity_gap")).toHaveLength(0);
  });

  it("empty 锚点 + 仍返回空：保持 empty，ready（不是 blocked）；首次采集空列表：建立 empty（E11、E25）", async () => {
    const env = await setupSync(t);
    const a = await env.addAccount("douyin", env.org.staffA, { identifier: "HITACHI1" });
    await putCheckpoint(env, a.accountId, { mode: "empty" });
    env.routeList(() => page([], false, 0));
    await env.scheduler.tick(SLOT);
    await run(env);
    expect(await listTask(env, a.accountId)).toMatchObject({ status: "succeeded", stopReason: "empty_list" });
    expect(await checkpoint()).toMatchObject({ anchorMode: "empty", continuityStatus: "ready" });
  });

  it("首次采集（没有检查点）返回空列表且 has_more=false：建立 empty 锚点，任务成功（E11）", async () => {
    const env = await setupSync(t);
    const a = await env.addAccount("douyin", env.org.staffA, { identifier: "HITACHI1" });
    env.routeList(() => page([], false, 0));
    await env.scheduler.tick(SLOT);
    await run(env);
    expect(await listTask(env, a.accountId)).toMatchObject({ status: "succeeded", stopReason: "empty_list" });
    expect(await checkpoint()).toMatchObject({ anchorMode: "empty", continuityStatus: "ready", version: 1n });
  });

  it("旧非空锚点 + 首页 0 条：旧锚点未被覆盖；检查点 blocked；任务 succeeded_with_gap / empty_window_not_rebased（E10）", async () => {
    const env = await setupSync(t);
    const a = await env.addAccount("douyin", env.org.staffA, { identifier: "HITACHI1" });
    await putCheckpoint(env, a.accountId, { mode: "id_window", ids: ["OLD"] });
    env.routeList(() => page([], false, 0));
    await env.scheduler.tick(SLOT);
    await run(env);
    expect(await listTask(env, a.accountId)).toMatchObject({ status: "succeeded_with_gap", stopReason: "empty_window_not_rebased" });
    expect(await checkpoint()).toMatchObject({ anchorMode: "id_window", highWatermarkContentIds: ["OLD"], continuityStatus: "blocked" });
  });

  it("blocked 之后只抓首页：有效页数上限 1（design-task5 §13.3）", async () => {
    const env = await setupSync(t);
    const a = await env.addAccount("douyin", env.org.staffA, { identifier: "HITACHI1" });
    await putCheckpoint(env, a.accountId, { mode: "id_window", ids: ["OLD"], continuity: "blocked" });
    env.routeList(() => page(syn("a", 5), true, 1000));
    await env.scheduler.tick(SLOT);
    await run(env);
    expect(env.listCursors()).toEqual(["0"]);
    expect(await listTask(env, a.accountId)).toMatchObject({ status: "succeeded_with_gap", stopReason: "safety_limit_rebased" });
  });

  it("同一内容在第 1 页与第 2 页各出现一次（分页漂移）：一条内容、一份快照、一条 discovery，两次出现都被处理（E17）", async () => {
    const env = await setupSync(t);
    const a = await env.addAccount("douyin", env.org.staffA, { identifier: "HITACHI1" });
    await putCheckpoint(env, a.accountId, { mode: "id_window", ids: ["OLD"] });
    env.routeList(({ cursor }) => (cursor === "0" ? page(syn("a", 3, { ids: { 2: "DRIFT" } }), true, 1000) : page([{ postId: "DRIFT", userId: "HITACHI1" }, { postId: "OLD", userId: "HITACHI1" }], false, 2000)));
    await env.scheduler.tick(SLOT);
    await run(env);
    const drift = (await t.db.select().from(contents)).filter((c) => c.platformContentId === "DRIFT");
    expect(drift).toHaveLength(1);
    expect((await snaps()).filter((s) => s.contentId === drift[0]!.contentId)).toHaveLength(1);
    expect(await listTask(env, a.accountId)).toMatchObject({ pageCount: 2, fetchedItemCount: 5 });
  });
});
