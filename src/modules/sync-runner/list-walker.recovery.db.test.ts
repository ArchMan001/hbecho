// ListWalker 的崩溃恢复、故障注入、身份校验、终态封口与孤儿清扫（FS-5.9–5.13、FS-6；acceptance E14–E16、E20–E21、F2、F4）。
// 多页用例的页内容是**合成**的（tests/harness/list-bytes.ts，结构取自 raw3 形态）。
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { useTestDb } from "../../../tests/harness/db";
import { loadFixtureBytes } from "../../../tests/harness/fixtures";
import { sha } from "../../../tests/harness/factories";
import { listBytes, type SyntheticEntry } from "../../../tests/harness/list-bytes";
import { providerIdOf } from "../../../tests/harness/seed";
import { LIST_PATH, SLOT, setupSync, type SyncEnv } from "../../../tests/harness/sync-env";
import { contentSnapshots, contents, dataQualityIssues, externalAccountIdentifiers, syncBatches, syncCheckpoints, syncTasks } from "../../db/schema";
import { contentListProjector } from "../projection";
import { createListWalker } from "./list-walker";
import { sweepOrphanBuilding } from "./seal";

const t = useTestDb();
const run = (env: SyncEnv) => env.worker({ fetch_content_list: createListWalker(env.deps) }).run({ untilIdle: true });
const listTask = async (env: SyncEnv, accountId: bigint) => (await env.tasks("fetch_content_list")).find((x) => x.accountId === accountId)!;
const snaps = () => t.db.select().from(contentSnapshots);
const checkpoint = async () => (await t.db.select().from(syncCheckpoints))[0];
const issues = (code?: string) => t.db.select().from(dataQualityIssues).then((r) => (code ? r.filter((i) => i.issueCode === code) : r));
const retryLater = (env: SyncEnv) => env.clock.advance(10 * 60_000);

async function putCheckpoint(env: SyncEnv, accountId: bigint, ids = ["OLD"]) {
  await t.db.insert(syncCheckpoints).values({ accountId, providerId: await providerIdOf(t.db), anchorMode: "id_window", highWatermarkPublishedAt: null, highWatermarkContentIds: ids, continuityStatus: "ready", version: 1n, updatedAt: env.clock.now() });
}
const syn = (prefix: string, n: number, o: { ids?: Record<number, string>; user?: string } = {}): SyntheticEntry[] =>
  Array.from({ length: n }, (_, i) => ({ postId: o.ids?.[i] ?? `${prefix}${i}`, userId: o.user ?? "HITACHI1", createdMs: 1788169004000 - i * 1000 }));
const page = (entries: SyntheticEntry[], hasMore: boolean, cursor: number) => listBytes(entries, { hasMore, cursorJson: String(cursor) });
const once = (fn: () => void) => {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    fn();
  };
};

describe("崩溃恢复", () => {
  it("第 1 页提交后丢进程：重新领取后只请求第 2 页，已提交的页不重复请求（E14）", async () => {
    const crash = once(() => {
      throw new Error("进程丢失");
    });
    const env = await setupSync(t, { runnerHooks: { afterPageProjection: crash } });
    const a = await env.addAccount("douyin", env.org.staffA, { identifier: "HITACHI1" });
    await putCheckpoint(env, a.accountId);
    env.routeList(({ cursor }) => (cursor === "0" ? page(syn("a", 5), true, 1000) : page(syn("b", 3, { ids: { 1: "OLD" } }), false, 2000)));
    await env.scheduler.tick(SLOT);

    await run(env);
    expect(await listTask(env, a.accountId)).toMatchObject({ status: "retry_wait", lastErrorCode: "runner_error", pageCount: 1, attemptCount: 1 });
    expect(await snaps()).toHaveLength(5);
    expect((await snaps()).every((s) => s.snapshotStatus === "building")).toBe(true); // 还没封口

    retryLater(env);
    await run(env);
    expect(env.listCursors()).toEqual(["0", "1000"]); // 没有第二次 "0"
    expect(await listTask(env, a.accountId)).toMatchObject({ status: "succeeded", stopReason: "boundary_hit", pageCount: 2 });
    expect((await snaps()).every((s) => s.snapshotStatus === "finalized")).toBe(true);
    expect(await snaps()).toHaveLength(8);
  });

  it("判定已落进度、封口前丢进程：重新领取后不再发任何请求，直接封口", async () => {
    const crash = once(() => {
      throw new Error("进程丢失");
    });
    const env = await setupSync(t, { runnerHooks: { beforeSeal: crash } });
    const a = await env.addAccount("douyin", env.org.staffA, { identifier: "HITACHI1" });
    await putCheckpoint(env, a.accountId);
    env.routeList(() => page(syn("a", 5, { ids: { 4: "OLD" } }), false, 0));
    await env.scheduler.tick(SLOT);
    await run(env);
    expect(await listTask(env, a.accountId)).toMatchObject({ status: "retry_wait", pageCount: 1 });
    retryLater(env);
    await run(env);
    expect(env.listCursors()).toEqual(["0"]); // 一次请求
    expect(await listTask(env, a.accountId)).toMatchObject({ status: "succeeded", stopReason: "boundary_hit" });
    expect((await snaps()).every((s) => s.snapshotStatus === "finalized")).toBe(true);
    expect(await checkpoint()).toMatchObject({ version: 2n, continuityStatus: "ready" });
  });

  it("响应已落 ODS 但页事务没提交就丢进程：同一次尝试重放时复用已捕获的响应，不再付费", async () => {
    const crash = once(() => {
      throw new Error("进程丢失");
    });
    const env = await setupSync(t, { runnerHooks: { beforePageProjection: crash }, leaseMs: 1000 });
    const a = await env.addAccount("douyin", env.org.staffA, { identifier: "HITACHI1" });
    env.routeList(() => page(syn("a", 5), false, 0));
    await env.scheduler.tick(SLOT);
    await run(env);
    expect(env.transport.calls).toHaveLength(1);
    // 失败消耗了 attempt，下一次尝试是新调用（attempt 2）——这是「失败后重试」，不是崩溃重放
    retryLater(env);
    await run(env);
    expect(await listTask(env, a.accountId)).toMatchObject({ status: "succeeded" });
    expect(env.transport.calls).toHaveLength(2);
  });
});

describe("故障注入", () => {
  it("第 N 条投影抛错：整页回滚（无内容 / 快照 / 发现），进度与检查点不推进；修复后幂等重做（E15）", async () => {
    let broken = true;
    const env = await setupSync(t);
    env.deps.projector = {
      projectCompletePage: async (tx, input) => {
        const r = await contentListProjector.projectCompletePage(tx, input);
        if (broken) throw new Error("第 3 条失败");
        return r;
      },
    };
    const a = await env.addAccount("douyin", env.org.staffA, { identifier: "HITACHI1" });
    env.routeList(() => page(syn("a", 5), false, 0));
    await env.scheduler.tick(SLOT);
    await run(env);
    expect(await listTask(env, a.accountId)).toMatchObject({ status: "retry_wait", lastErrorCode: "page_projection_failed", pageCount: 0, resultSummary: null });
    expect(await t.db.select().from(contents)).toHaveLength(0);
    expect(await snaps()).toHaveLength(0);
    expect(await checkpoint()).toBeUndefined();

    broken = false;
    retryLater(env);
    await run(env);
    expect(await listTask(env, a.accountId)).toMatchObject({ status: "succeeded" });
    expect(await snaps()).toHaveLength(5);
    expect(await checkpoint()).toMatchObject({ version: 1n });
  });

  it("技术失败不会变成空列表：200 但 result 不是数组 → schema_drift，没有快照也没有 empty 锚点", async () => {
    const env = await setupSync(t);
    const a = await env.addAccount("douyin", env.org.staffA, { identifier: "HITACHI1" });
    env.routeList(() => new TextEncoder().encode('{"code":0,"data":{"task_id":"t","action":"user_video_list","status":"succeeded","result":{"result":"oops","has_more":false},"error":null},"request_id":"t"}'));
    await env.scheduler.tick(SLOT);
    await run(env);
    expect(await listTask(env, a.accountId)).toMatchObject({ status: "failed", lastErrorCode: "schema_drift" });
    expect(await snaps()).toHaveLength(0);
    expect(await checkpoint()).toBeUndefined();
  });

  it("预算封口：网关返回 not_sent → budget_exhausted，不消耗 attempt，没有快照", async () => {
    const env = await setupSync(t, { policy: { check: async () => "call_budget" } });
    const a = await env.addAccount("douyin", env.org.staffA, { identifier: "HITACHI1" });
    env.routeList(() => page(syn("a", 5), false, 0));
    await env.scheduler.tick(SLOT);
    await run(env);
    expect(await listTask(env, a.accountId)).toMatchObject({ status: "failed", lastErrorCode: "budget_exhausted", attemptCount: 0 });
    expect(env.transport.calls).toHaveLength(0);
    expect(await snaps()).toHaveLength(0);
  });

  it("production 的 capability 全部 disabled：capability_disabled，零调用", async () => {
    const env = await setupSync(t);
    const a = await env.addAccount("douyin", env.org.staffA, { identifier: "HITACHI1" });
    env.routeList(() => page(syn("a", 5), false, 0));
    await env.scheduler.tick(SLOT);
    await env.worker({ fetch_content_list: createListWalker({ ...env.deps, environment: "production" }) }).run({ untilIdle: true });
    expect(env.transport.calls).toHaveLength(0);
    expect(await listTask(env, a.accountId)).toMatchObject({ status: "failed", lastErrorCode: "capability_disabled" });
  });
});

describe("终态封口（FS-6.2）", () => {
  it("第 2 页反复失败直至 dead：第 1 页的可靠条目被定稿并切换 current；检查点未推进；没有残留 building 行；已提交的页不重复请求（F2）", async () => {
    const env = await setupSync(t);
    const a = await env.addAccount("douyin", env.org.staffA, { identifier: "HITACHI1" });
    await putCheckpoint(env, a.accountId);
    env.routeList(({ cursor }) => (cursor === "0" ? page(syn("a", 5), true, 1000) : { httpStatus: 503, body: new TextEncoder().encode('{"code":"UNAVAILABLE"}') }));
    await env.scheduler.tick(SLOT);
    for (let i = 0; i < 3; i++) {
      await run(env);
      retryLater(env);
    }
    expect(await listTask(env, a.accountId)).toMatchObject({ status: "dead", lastErrorCode: "provider_server_error", pageCount: 1 });
    expect(env.listCursors()).toEqual(["0", "1000", "1000", "1000"]); // 第 1 页只请求一次
    const rows = await snaps();
    expect(rows).toHaveLength(5);
    expect(rows.every((s) => s.snapshotStatus === "finalized")).toBe(true);
    expect((await t.db.select().from(contents)).every((c) => c.currentSnapshotId !== null)).toBe(true);
    expect(await checkpoint()).toMatchObject({ version: 1n, highWatermarkContentIds: ["OLD"] }); // 未推进
  });

  it("旧批次迟到：保留历史，current 与检查点都不倒退（F4、E16）", async () => {
    const env = await setupSync(t);
    const a = await env.addAccount("douyin", env.org.staffA, { identifier: "HITACHI1" });
    env.routeList(() => page(syn("a", 5), false, 0));
    await env.scheduler.tick(SLOT);
    // 一个 logical_at 更早的补抓批次：任务 id 更大，所以排在新批次之后完成
    const now = env.clock.now();
    const [b] = await t.db.insert(syncBatches).values({ batchKey: sha("older"), triggerType: "manual", purpose: "supplement", logicalAt: new Date(SLOT.getTime() - 7 * 86_400_000), status: "running", settingsVersion: 1n, settingsSnapshot: {}, createdAt: now, updatedAt: now });
    const [newer] = await env.tasks("fetch_content_list");
    const [ot] = await t.db.insert(syncTasks).values({
      batchId: BigInt(b.insertId),
      providerId: newer!.providerId,
      platformId: newer!.platformId,
      assignmentId: newer!.assignmentId,
      accountId: a.accountId,
      requestedAction: "fetch_content_list",
      subjectType: "external_account",
      subjectId: a.accountId,
      taskParameters: { schema_version: "sync-list-task.v1", mode: "synchronous", initial_content_limit: 20, safety_page_limit: 5, anchor_snapshot: null },
      idempotencyKey: sha("older-task"),
      status: "pending",
      attemptCount: 0,
      maxAttempts: 3,
      expiresAt: new Date(now.getTime() + 1e10),
      createdAt: now,
      updatedAt: now,
    });
    await run(env);
    const cs = await t.db.select().from(contents);
    const all = await snaps();
    expect(all).toHaveLength(10); // 两个批次各一份，历史都在
    const newerBatchSnap = (contentId: bigint) => all.find((s) => s.contentId === contentId && s.batchId === newer!.batchId)!.contentSnapshotId;
    expect(cs.every((c) => c.currentSnapshotId === newerBatchSnap(c.contentId))).toBe(true); // current 仍是新批次的
    const olderTask = (await t.db.select().from(syncTasks).where(eq(syncTasks.taskId, BigInt(ot.insertId))))[0]!;
    expect(olderTask.status).toBe("succeeded");
    expect((olderTask.resultSummary as { final: { checkpoint: string } }).final.checkpoint).toBe("stale_rejected");
    expect(await checkpoint()).toMatchObject({ version: 1n, lastSuccessfulBatchId: newer!.batchId });
  });
});

describe("身份校验（FS-5.13）", () => {
  it("20 条中没有一条由登记作者创作：list_author_mismatch——本批次该账号 building 快照被清除，检查点不推进，任务 failed，登记标识不变，只请求了一页（E20）", async () => {
    const env = await setupSync(t);
    const a = await env.addAccount("douyin", env.org.staffA, { identifier: "SOMEONE-ELSE" });
    env.routeList(() => loadFixtureBytes("raw3.douyin.user_video_list"));
    await env.scheduler.tick(SLOT);
    await run(env);
    const task = await listTask(env, a.accountId);
    expect(task).toMatchObject({ status: "failed", lastErrorCode: "list_author_mismatch" });
    expect(task.resultSummary).toMatchObject({ identity_check: { state: "mismatch", known_author_entries: 20, matched_entries: 0 } });
    expect(await snaps()).toHaveLength(0);
    expect(await checkpoint()).toBeUndefined();
    expect(await issues("list_author_mismatch")).toHaveLength(1);
    const ids = await t.db.select().from(externalAccountIdentifiers).where(eq(externalAccountIdentifiers.accountId, a.accountId));
    expect(ids.map((i) => i.identifierValue)).toEqual(["SOMEONE-ELSE"]);
    expect(env.listCursors()).toEqual(["0"]); // 不再为同一个错号翻页付费
  });

  it("mismatch 在第 1 页就确定：即使 has_more=true 且未命中旧边界，也不再请求第 2 页", async () => {
    const env = await setupSync(t);
    const a = await env.addAccount("douyin", env.org.staffA, { identifier: "SOMEONE-ELSE" });
    await putCheckpoint(env, a.accountId);
    env.routeList(() => page(syn("a", 6), true, 1000));
    await env.scheduler.tick(SLOT);
    await run(env);
    expect(env.listCursors()).toEqual(["0"]);
    expect(await listTask(env, a.accountId)).toMatchObject({ status: "failed", lastErrorCode: "list_author_mismatch" });
    expect(await snaps()).toHaveLength(0);
  });

  it("3 条列表（< 5）→ unverifiable，不判错，任务成功（E21）", async () => {
    const env = await setupSync(t);
    const a = await env.addAccount("douyin", env.org.staffA, { identifier: "SOMEONE-ELSE" });
    env.routeList(() => page(syn("a", 3), false, 0));
    await env.scheduler.tick(SLOT);
    await run(env);
    const task = await listTask(env, a.accountId);
    expect(task.status).toBe("succeeded");
    expect(task.resultSummary).toMatchObject({ identity_check: { state: "unverifiable", known_author_entries: 3, matched_entries: 0 } });
  });

  it("作者字段整体缺失（契约漂移）不算串号：不判 mismatch", async () => {
    const env = await setupSync(t);
    const a = await env.addAccount("douyin", env.org.staffA, { identifier: "HITACHI1" });
    const body = new TextDecoder().decode(page(syn("a", 8), false, 0)).replaceAll('"user_id":"HITACHI1",', "");
    env.routeList(() => new TextEncoder().encode(body));
    await env.scheduler.tick(SLOT);
    await run(env);
    const task = await listTask(env, a.accountId);
    expect(task.status).toBe("succeeded");
    expect(task.resultSummary).toMatchObject({ identity_check: { state: "unverifiable", known_author_entries: 0 } });
  });
});

describe("孤儿清扫（外部取消没有 fence）", () => {
  it("任务被取消、留下已提交页的 building 行：可靠条目定稿并切换 current，检查点不动", async () => {
    const crash = once(() => {
      throw new Error("进程丢失");
    });
    const env = await setupSync(t, { runnerHooks: { afterPageProjection: crash } });
    const a = await env.addAccount("douyin", env.org.staffA, { identifier: "HITACHI1" });
    await putCheckpoint(env, a.accountId);
    env.routeList(() => page(syn("a", 5), true, 1000));
    await env.scheduler.tick(SLOT);
    await run(env);
    const task = await listTask(env, a.accountId);
    await t.db.update(syncTasks).set({ status: "cancelled", leaseOwner: null, leaseExpiresAt: null }).where(eq(syncTasks.taskId, task.taskId));
    expect((await snaps()).every((s) => s.snapshotStatus === "building")).toBe(true);

    expect(await sweepOrphanBuilding(t.db, env.clock)).toMatchObject({ tasks: 1, finalized: 5, purged: 0 });
    expect((await snaps()).every((s) => s.snapshotStatus === "finalized")).toBe(true);
    expect((await t.db.select().from(contents)).every((c) => c.currentSnapshotId !== null)).toBe(true);
    expect(await checkpoint()).toMatchObject({ version: 1n, highWatermarkContentIds: ["OLD"] });
    // 幂等
    expect(await sweepOrphanBuilding(t.db, env.clock)).toMatchObject({ tasks: 0 });
  });

  it("仍在运行 / 重试等待的任务的 building 行不会被清扫（任务还要续跑）", async () => {
    const crash = once(() => {
      throw new Error("进程丢失");
    });
    const env = await setupSync(t, { runnerHooks: { afterPageProjection: crash } });
    const a = await env.addAccount("douyin", env.org.staffA, { identifier: "HITACHI1" });
    await putCheckpoint(env, a.accountId);
    env.routeList(() => page(syn("a", 5), true, 1000));
    await env.scheduler.tick(SLOT);
    await run(env);
    expect((await listTask(env, a.accountId)).status).toBe("retry_wait");
    expect(await sweepOrphanBuilding(t.db, env.clock)).toMatchObject({ tasks: 0, finalized: 0 });
    expect((await snaps()).every((s) => s.snapshotStatus === "building")).toBe(true);
  });
});

void LIST_PATH;
