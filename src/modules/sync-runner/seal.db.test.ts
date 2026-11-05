// 封口的三条事务边界（design-task5 §7）：封口与终态同一事务；检查点 fencing；building 清除只在条件内。
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { useTestDb } from "../../../tests/harness/db";
import { decodedData } from "../../../tests/harness/decode-helpers";
import { insertAccount, insertAssignment, insertBatch, insertPreparedCall, insertTask } from "../../../tests/harness/factories";
import { listBytes, type SyntheticEntry } from "../../../tests/harness/list-bytes";
import { platformIdOf, providerIdOf, seedOrg } from "../../../tests/harness/seed";
import { SLOT, setupSync } from "../../../tests/harness/sync-env";
import { contentSnapshots, contents, dataQualityIssues, mediaReferences, syncCheckpoints, syncTasks } from "../../db/schema";
import { claimTask, withFences } from "../orchestrator";
import { projectContentPage } from "../projection";
import { decodeVideoList } from "../provider-adapter";
import { createListWalker } from "./list-walker";
import { parseProgress } from "./list-progress";
import { purgeBuilding, sealSuccess } from "./seal";

const t = useTestDb();
const NOW = new Date("2026-11-04T08:00:00.000Z");

describe("purgeBuilding：只清 snapshot_status='building' AND batch_id=B 且内容属于该账号的快照（边界 3）", () => {
  it("不误删已定稿的快照、其他批次的快照、其他账号的快照；pending 封面引用随之清除", async () => {
    const org = await seedOrg(t.db, NOW);
    const platformId = await platformIdOf(t.db, "douyin");
    const b1 = await insertBatch(t.db, NOW);
    const b2 = await insertBatch(t.db, NOW);
    const callId = await insertPreparedCall(t.db, await insertTask(t.db, { batchId: b1, platform: "douyin", now: NOW }), "douyin", NOW);
    const mk = async (staffId: bigint) => {
      const accountId = await insertAccount(t.db, "douyin", NOW);
      return { accountId, assignmentId: await insertAssignment(t.db, { accountId, platform: "douyin", staffId, now: NOW }) };
    };
    const A = await mk(org.staffA);
    const B = await mk(org.staffB);
    const project = (acct: { accountId: bigint; assignmentId: bigint }, batchId: bigint, ids: string[], mode: "building" | "final") =>
      t.db.transaction((tx) =>
        projectContentPage(tx, {
          batchId,
          platformId,
          accountId: acct.accountId,
          assignmentId: acct.assignmentId,
          owner: null,
          sourceProviderCallId: callId,
          adapterVersion: "v",
          receivedAt: NOW,
          pageNo: 0,
          page: decodedData(decodeVideoList("douyin", listBytes(ids.map((postId): SyntheticEntry => ({ postId }))))),
          now: NOW,
          mode,
        }),
      );
    await project(A, b1, ["a1", "a2"], "building"); // 目标
    await project(A, b2, ["a1"], "building"); // 同账号、其他批次
    await project(B, b1, ["b1"], "building"); // 同批次、其他账号
    await project(A, b1, ["done"], "final"); // 同批次同账号，但已定稿
    const before = await t.db.select().from(contentSnapshots);
    expect(before).toHaveLength(5);

    const removed = await t.db.transaction((tx) => purgeBuilding(tx, { batchId: b1, accountId: A.accountId }));
    expect(removed).toBe(2);
    const after = await t.db.select().from(contentSnapshots);
    expect(after).toHaveLength(3);
    const cs = new Map((await t.db.select().from(contents)).map((c) => [c.contentId, c]));
    const label = (s: (typeof after)[number]) => `${cs.get(s.contentId)!.platformContentId}@${s.batchId === b1 ? "b1" : "b2"}:${s.snapshotStatus}`;
    expect(after.map(label).sort()).toEqual(["a1@b2:building", "b1@b1:building", "done@b1:finalized"]);
    // 被清除快照的 pending 封面引用一并清除，其余快照的保留
    expect(await t.db.select().from(mediaReferences)).toHaveLength(3);
  });
});

describe("封口事务（边界 1、2）", () => {
  async function stoppedBeforeSeal() {
    let boom = true;
    const env = await setupSync(t, {
      runnerHooks: {
        beforeSeal: () => {
          if (boom) {
            boom = false;
            throw new Error("进程丢失");
          }
        },
      },
    });
    const a = await env.addAccount("douyin", env.org.staffA, { identifier: "HITACHI1" });
    await t.db.insert(syncCheckpoints).values({ accountId: a.accountId, providerId: await providerIdOf(t.db), anchorMode: "id_window", highWatermarkContentIds: ["OLD"], continuityStatus: "ready", version: 1n, updatedAt: env.clock.now() });
    const entries: SyntheticEntry[] = Array.from({ length: 5 }, (_, i) => ({ postId: i === 4 ? "OLD" : `a${i}`, userId: "HITACHI1", createdMs: 1788169004000 - i * 1000 }));
    env.routeList(() => listBytes(entries, { hasMore: false, cursorJson: "0" }));
    await env.scheduler.tick(SLOT);
    await env.worker({ fetch_content_list: createListWalker(env.deps) }).run({ untilIdle: true });
    env.clock.advance(10 * 60_000);
    const task = (await env.tasks("fetch_content_list"))[0]!;
    const claim = await claimTask(t.db, task.taskId, { workerId: "test", leaseMs: 60_000, now: env.clock.now() });
    if (claim.kind !== "claimed") throw new Error(`claim: ${claim.kind}`);
    const input = (row: typeof syncTasks.$inferSelect, token: bigint) => ({
      task: row,
      token,
      assignmentId: a.assignmentId,
      progress: parseProgress(row.resultSummary)!,
      oldAnchor: { mode: "id_window" as const, contentIds: new Set(["OLD"]) },
      expectedCheckpointVersion: 1n,
      now: env.clock.now(),
    });
    return { env, a, task, claim, input };
  }

  it("封口中途失败（同一事务里后面抛错）：快照仍 building、任务仍 running、检查点与质量问题都没变——封口与终态不可分", async () => {
    const s = await stoppedBeforeSeal();
    await expect(
      withFences(t.db, s.env.clock, [{ taskId: s.task.taskId, token: s.claim.token }], async (tx, tasks) => {
        const r = await sealSuccess(tx, s.input(tasks.get(s.task.taskId)!, s.claim.token));
        expect(r).toMatchObject({ taskStatus: "succeeded", checkpoint: "advanced", finalized: 5 }); // 事务内部确实做完了
        throw new Error("终态之后的步骤失败");
      }),
    ).rejects.toThrow("终态之后");
    expect((await t.db.select().from(contentSnapshots)).every((x) => x.snapshotStatus === "building")).toBe(true);
    expect((await t.db.select().from(contents)).every((c) => c.currentSnapshotId === null)).toBe(true);
    expect((await t.db.select().from(syncTasks).where(eq(syncTasks.taskId, s.task.taskId)))[0]!.status).toBe("running");
    expect((await t.db.select().from(syncCheckpoints))[0]).toMatchObject({ version: 1n, highWatermarkContentIds: ["OLD"] });

    // 同一个状态下再正常封口一次：全部一起生效
    const ok = await withFences(t.db, s.env.clock, [{ taskId: s.task.taskId, token: s.claim.token }], (tx, tasks) => sealSuccess(tx, s.input(tasks.get(s.task.taskId)!, s.claim.token)));
    expect(ok.ok).toBe(true);
    expect((await t.db.select().from(contentSnapshots)).every((x) => x.snapshotStatus === "finalized")).toBe(true);
    expect((await t.db.select().from(syncTasks).where(eq(syncTasks.taskId, s.task.taskId)))[0]).toMatchObject({ status: "succeeded", stopReason: "boundary_hit" });
    expect((await t.db.select().from(syncCheckpoints))[0]).toMatchObject({ version: 2n });
  });

  it("陈旧 fencing token：整笔封口不执行（快照、current、检查点都不动）", async () => {
    const s = await stoppedBeforeSeal();
    const r = await withFences(t.db, s.env.clock, [{ taskId: s.task.taskId, token: s.claim.token + 5n }], (tx, tasks) => sealSuccess(tx, s.input(tasks.get(s.task.taskId)!, s.claim.token + 5n)));
    expect(r).toMatchObject({ ok: false, reason: "stale_fence" });
    expect((await t.db.select().from(contentSnapshots)).every((x) => x.snapshotStatus === "building")).toBe(true);
    expect((await t.db.select().from(syncCheckpoints))[0]).toMatchObject({ version: 1n });
    expect(await t.db.select().from(dataQualityIssues)).toHaveLength(0);
  });

  it("被取代（token 作废）之后，旧 worker 即使绕过 withFences 直接调 sealSuccess，advanceCheckpoint 内部的 fencing 校验也挡住推进", async () => {
    const s = await stoppedBeforeSeal();
    await expect(
      t.db.transaction((tx) => sealSuccess(tx, { ...s.input(s.task, s.claim.token - 1n), task: { ...s.task, taskId: s.task.taskId } })),
    ).rejects.toThrow(/fencing 失效/);
    expect((await t.db.select().from(syncCheckpoints))[0]).toMatchObject({ version: 1n });
    expect((await t.db.select().from(contentSnapshots)).every((x) => x.snapshotStatus === "building")).toBe(true); // 抛错使整笔回滚
  });
});
