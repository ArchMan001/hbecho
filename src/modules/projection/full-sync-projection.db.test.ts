// a-full-sync 任务 5：building 模式的多页投影与检查点推进（design-task5 §7.2、§10）。
// tracer 单页路径（mode 默认 final）的行为由 projection.db.test.ts 与 tracer-flow.*.db.test.ts 守住。
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { useTestDb } from "../../../tests/harness/db";
import { decodedData } from "../../../tests/harness/decode-helpers";
import { insertAccount, insertAssignment, insertBatch, insertPreparedCall, insertTask } from "../../../tests/harness/factories";
import { listBytes, type SyntheticEntry } from "../../../tests/harness/list-bytes";
import { platformIdOf, providerIdOf, seedOrg } from "../../../tests/harness/seed";
import { contentDiscoveries, contentSnapshots, contents, mediaReferences, syncCheckpoints, syncTasks } from "../../db/schema";
import { decodeVideoList } from "../provider-adapter";
import { advanceCheckpoint, projectContentPage, type CheckpointNext, type InitialAnchor } from "./index";

const t = useTestDb();
const NOW = new Date("2026-11-04T08:00:00.000Z");
const LATER = new Date(NOW.getTime() + 60_000);

async function world() {
  const org = await seedOrg(t.db, NOW);
  const platformId = await platformIdOf(t.db, "douyin");
  const providerId = await providerIdOf(t.db);
  const batchId = await insertBatch(t.db, NOW);
  const taskId = await insertTask(t.db, { batchId, platform: "douyin", now: NOW, action: "fetch_content_list" });
  // 一个持有租约的列表任务：fencing token = 1
  await t.db.update(syncTasks).set({ status: "running", leaseOwner: "w1", leaseExpiresAt: new Date(NOW.getTime() + 3_600_000), fencingToken: 1n }).where(eq(syncTasks.taskId, taskId));
  const callId = await insertPreparedCall(t.db, taskId, "douyin", NOW);
  const accountId = await insertAccount(t.db, "douyin", NOW);
  const assignmentId = await insertAssignment(t.db, { accountId, platform: "douyin", staffId: org.staffA, now: NOW });
  const page = (entries: SyntheticEntry[]) => decodedData(decodeVideoList("douyin", listBytes(entries)));
  const project = (entries: SyntheticEntry[], o: { pageNo: number; offset?: number; mode?: "building" | "final"; skipCover?: boolean }) =>
    t.db.transaction((tx) =>
      projectContentPage(tx, {
        batchId,
        platformId,
        accountId,
        assignmentId,
        owner: { staffId: org.staffA, storeId: org.storeId, brandId: org.hitachiBrandId },
        sourceProviderCallId: callId,
        adapterVersion: "aimaster-adapter.v1",
        receivedAt: NOW,
        pageNo: o.pageNo,
        page: page(entries),
        now: NOW,
        ...(o.mode ? { mode: o.mode } : {}),
        ...(o.offset === undefined ? {} : { positionOffset: o.offset }),
        ...(o.skipCover ? { skipCover: async () => true } : {}),
      }),
    );
  return { batchId, taskId, providerId, accountId, project };
}

describe("building 模式（多页）", () => {
  it("写 building：未定稿、finalized_at 为空、不选 current；discovery 的绝对位置带页偏移", async () => {
    const w = await world();
    await w.project([{ postId: "a" }, { postId: "b" }], { pageNo: 0, mode: "building" });
    await w.project([{ postId: "c" }], { pageNo: 1, mode: "building", offset: 2 });
    const snaps = await t.db.select().from(contentSnapshots);
    expect(snaps).toHaveLength(3);
    expect(snaps.every((s) => s.snapshotStatus === "building" && s.finalizedAt === null)).toBe(true);
    expect((await t.db.select().from(contents)).every((c) => c.currentSnapshotId === null)).toBe(true);
    const ds = await t.db.select().from(contentDiscoveries).orderBy(contentDiscoveries.absolutePosition);
    expect(ds.map((d) => [d.pageNo, d.positionInPage, d.absolutePosition, d.isPotentiallyPinned])).toEqual([
      [0, 0, 0, true],
      [0, 1, 1, true],
      [1, 0, 2, false],
    ]);
  });

  it("跨页重复：一条内容、一份快照、一条 discovery（首次位置）；缺失不擦除有效值，后到真实 0 覆盖", async () => {
    const w = await world();
    await w.project([{ postId: "x" }, { postId: "a", like: 5, title: "有标题" }], { pageNo: 0, mode: "building" });
    const r2 = await w.project([{ postId: "a", like: null, title: null }], { pageNo: 1, mode: "building", offset: 2 });
    expect(r2.processedEntries).toBe(r2.returnedEntries); // 重复出现也算已处理
    let [a] = await t.db.select().from(contentSnapshots).innerJoin(contents, eq(contents.contentId, contentSnapshots.contentId)).where(eq(contents.platformContentId, "a"));
    expect(a!.content_snapshots).toMatchObject({ likeState: "value", likeValue: 5n, title: "有标题" }); // explicit_null / 缺失不擦除
    await w.project([{ postId: "a", like: 0, title: null }], { pageNo: 2, mode: "building", offset: 3 });
    [a] = await t.db.select().from(contentSnapshots).innerJoin(contents, eq(contents.contentId, contentSnapshots.contentId)).where(eq(contents.platformContentId, "a"));
    expect(a!.content_snapshots).toMatchObject({ likeState: "value", likeValue: 0n, title: "有标题", playState: "unsupported" });
    expect(await t.db.select().from(contents)).toHaveLength(2);
    expect(await t.db.select().from(contentSnapshots)).toHaveLength(2);
    const ds = await t.db.select().from(contentDiscoveries).innerJoin(contents, eq(contents.contentId, contentDiscoveries.contentId)).where(eq(contents.platformContentId, "a"));
    expect(ds).toHaveLength(1);
    expect(ds[0]!.content_discoveries).toMatchObject({ pageNo: 0, absolutePosition: 1 });
  });

  it("跨页重复只有一条 cover 引用；skipCover 钩子返回 true 则不建（任务 7 的封面首次规则挂在这里）", async () => {
    const w = await world();
    await w.project([{ postId: "a" }], { pageNo: 0, mode: "building" });
    await w.project([{ postId: "a" }], { pageNo: 1, mode: "building", offset: 1 });
    expect(await t.db.select().from(mediaReferences)).toHaveLength(1);
    await w.project([{ postId: "b" }], { pageNo: 2, mode: "building", offset: 2, skipCover: true });
    expect(await t.db.select().from(mediaReferences)).toHaveLength(1);
  });

  it("已定稿的快照不被 building 模式改写", async () => {
    const w = await world();
    await w.project([{ postId: "a", like: 5 }], { pageNo: 0 }); // 默认 final：tracer 路径
    const [before] = await t.db.select().from(contentSnapshots);
    expect(before!.snapshotStatus).toBe("finalized");
    await w.project([{ postId: "a", like: 99 }], { pageNo: 1, mode: "building", offset: 1 });
    const [after] = await t.db.select().from(contentSnapshots);
    expect(after).toMatchObject({ snapshotStatus: "finalized", likeValue: 5n });
  });

  it("默认 final：与 tracer 一致，写 finalized 并立刻选 current", async () => {
    const w = await world();
    await w.project([{ postId: "a" }], { pageNo: 0 });
    const [c] = await t.db.select().from(contents);
    const [s] = await t.db.select().from(contentSnapshots);
    expect(s).toMatchObject({ snapshotStatus: "finalized" });
    expect(c!.currentSnapshotId).toBe(s!.contentSnapshotId);
  });
});

describe("advanceCheckpoint：任务 fencing 与 version 乐观比较缺一不可", () => {
  const anchorA: InitialAnchor = { mode: "time", highWatermarkPublishedAt: new Date(5000), highWatermarkContentIds: ["a"] };
  const ready: CheckpointNext = { anchor: anchorA, continuity: "ready", cursor: { kind: "string", value: "1.78E12" }, gapAt: null };
  const advance = (w: Awaited<ReturnType<typeof world>>, expectedVersion: bigint | null, next: CheckpointNext, token = 1n, now = NOW) =>
    t.db.transaction((tx) => advanceCheckpoint(tx, { accountId: w.accountId, providerId: w.providerId, expectedVersion, batchId: w.batchId, fence: { taskId: w.taskId, token }, next, now }));
  const row = async () => (await t.db.select().from(syncCheckpoints))[0]!;

  it("规划时没有检查点：创建（version 1）；已有人创建过则拒绝，不覆盖", async () => {
    const w = await world();
    expect(await advance(w, null, ready)).toEqual({ kind: "created", version: 1n });
    expect(await row()).toMatchObject({ version: 1n, anchorMode: "time", continuityStatus: "ready", cursorEnvelope: { kind: "string", value: "1.78E12" } });
    const other: CheckpointNext = { ...ready, anchor: { mode: "empty", highWatermarkPublishedAt: null, highWatermarkContentIds: [] } };
    expect(await advance(w, null, other)).toEqual({ kind: "stale_rejected" });
    expect(await row()).toMatchObject({ version: 1n, anchorMode: "time" });
  });

  it("version 相符才推进；同一规划版本第二次推进被拒（较旧批次迟到不倒退）", async () => {
    const w = await world();
    await advance(w, null, ready);
    const newer: CheckpointNext = { anchor: { mode: "time", highWatermarkPublishedAt: new Date(9000), highWatermarkContentIds: ["z"] }, continuity: "ready", cursor: null, gapAt: null };
    expect(await advance(w, 1n, newer)).toEqual({ kind: "advanced", version: 2n });
    expect(await row()).toMatchObject({ version: 2n, highWatermarkContentIds: ["z"], cursorEnvelope: null, cursorSha256: null });
    // 另一个以 version 1 规划的旧批次迟到
    expect(await advance(w, 1n, ready)).toEqual({ kind: "stale_rejected" });
    expect(await row()).toMatchObject({ version: 2n, highWatermarkContentIds: ["z"] });
  });

  it("陈旧 fencing token：即使 version 相符也什么都不写", async () => {
    const w = await world();
    await advance(w, null, ready);
    expect(await advance(w, 1n, { ...ready, continuity: "rebased_after_gap", gapAt: NOW }, 99n)).toMatchObject({ kind: "fence_lost", reason: "stale_fence" });
    expect(await row()).toMatchObject({ version: 1n, continuityStatus: "ready", lastGapAt: null });
  });

  it("任务已取消或租约过期：fence_lost，什么都不写", async () => {
    const w = await world();
    await advance(w, null, ready);
    expect(await advance(w, 1n, ready, 1n, new Date(NOW.getTime() + 2 * 3_600_000))).toMatchObject({ kind: "fence_lost", reason: "lease_expired" });
    await t.db.update(syncTasks).set({ status: "cancelled" }).where(eq(syncTasks.taskId, w.taskId));
    expect(await advance(w, 1n, ready)).toMatchObject({ kind: "fence_lost", reason: "cancelled" });
    expect((await row()).version).toBe(1n);
  });

  it("缺口：重建锚点、rebased_after_gap、写 last_gap_at", async () => {
    const w = await world();
    await advance(w, null, ready);
    const gap: CheckpointNext = { anchor: { mode: "id_window", highWatermarkPublishedAt: null, highWatermarkContentIds: ["m", "n"] }, continuity: "rebased_after_gap", cursor: null, gapAt: LATER };
    await advance(w, 1n, gap, 1n, NOW);
    expect(await row()).toMatchObject({ anchorMode: "id_window", highWatermarkContentIds: ["m", "n"], continuityStatus: "rebased_after_gap", version: 2n });
    expect((await row()).lastGapAt!.getTime()).toBe(LATER.getTime());
  });

  it("blocked（keep）：旧锚点、游标、last_successful 都不动，只改状态并 +1 版本；规划时无检查点则不凭空创建", async () => {
    const w = await world();
    await advance(w, null, ready);
    const before = await row();
    expect(await advance(w, 1n, { anchor: "keep", continuity: "blocked", cursor: null, gapAt: null })).toEqual({ kind: "advanced", version: 2n });
    const after = await row();
    expect(after).toMatchObject({ anchorMode: "time", highWatermarkContentIds: ["a"], continuityStatus: "blocked", version: 2n, cursorEnvelope: before.cursorEnvelope, lastSuccessfulTaskId: before.lastSuccessfulTaskId });
    await t.db.delete(syncCheckpoints);
    expect(await advance(w, null, { anchor: "keep", continuity: "blocked", cursor: null, gapAt: null })).toEqual({ kind: "stale_rejected" });
    expect(await t.db.select().from(syncCheckpoints)).toHaveLength(0);
  });
});
