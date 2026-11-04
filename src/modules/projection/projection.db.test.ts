// 任务 6：平台无关的完整页投影与类型保真检查点的契约（R8–R11、R18；acceptance D、E）。
// 直接对 projectContentPage / establishInitialCheckpoint 断言，不经过编排器。
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { resetData, useTestDb } from "../../../tests/harness/db";
import { decodedData } from "../../../tests/harness/decode-helpers";
import { insertAccount, insertAssignment, insertBatch, insertPreparedCall, insertTask } from "../../../tests/harness/factories";
import { listBytes, type SyntheticEntry } from "../../../tests/harness/list-bytes";
import { seedOrg } from "../../../tests/harness/seed";
import { platformIdOf, providerIdOf } from "../../../tests/harness/seed";
import { contentDiscoveries, contentSnapshots, contents, syncCheckpoints, syncTasks } from "../../db/schema";
import { decodeVideoList, type TypedCursor } from "../provider-adapter";
import { establishInitialCheckpoint, projectContentPage } from "./index";

const t = useTestDb();
const NOW = new Date("2026-11-04T08:00:00.000Z");

async function world() {
  const org = await seedOrg(t.db, NOW);
  const platformId = await platformIdOf(t.db, "douyin");
  const providerId = await providerIdOf(t.db);
  const batchId = await insertBatch(t.db, NOW);
  const callId = await insertPreparedCall(t.db, await insertTask(t.db, { batchId, platform: "douyin", now: NOW }), "douyin", NOW);
  const mk = async (staffId: bigint) => {
    const accountId = await insertAccount(t.db, "douyin", NOW);
    const assignmentId = await insertAssignment(t.db, { accountId, platform: "douyin", staffId, now: NOW });
    return { accountId, assignmentId };
  };
  const a = await mk(org.staffA);
  const b = await mk(org.staffB);
  const page = (entries: SyntheticEntry[], o: Parameters<typeof listBytes>[1] = {}) => decodedData(decodeVideoList("douyin", listBytes(entries, o)));
  const project = (acct: { accountId: bigint; assignmentId: bigint }, entries: SyntheticEntry[], over: { batchId?: bigint; o?: Parameters<typeof listBytes>[1] } = {}) =>
    t.db.transaction((tx) =>
      projectContentPage(tx, {
        batchId: over.batchId ?? batchId,
        platformId,
        accountId: acct.accountId,
        assignmentId: acct.assignmentId,
        owner: { staffId: org.staffA, storeId: org.storeId, brandId: org.hitachiBrandId },
        sourceProviderCallId: callId,
        adapterVersion: "aimaster-adapter.v1",
        receivedAt: NOW,
        pageNo: 0,
        page: page(entries, over.o),
        now: NOW,
      }),
    );
  return { org, platformId, providerId, batchId, callId, a, b, project, page };
}

describe("按账号的内容 grain", () => {
  it("同一作品出现在两个账号的列表：各一条内容、一份快照、一条发现，不跨账号合并", async () => {
    const w = await world();
    await w.project(w.a, [{ postId: "same-post" }]);
    await w.project(w.b, [{ postId: "same-post" }]);
    const cs = await t.db.select().from(contents);
    expect(cs).toHaveLength(2);
    expect(new Set(cs.map((c) => c.accountId))).toEqual(new Set([w.a.accountId, w.b.accountId]));
    expect(await t.db.select().from(contentSnapshots)).toHaveLength(2);
    const ds = await t.db.select().from(contentDiscoveries);
    expect(ds).toHaveLength(2);
    expect(new Set(ds.map((d) => d.assignmentId))).toEqual(new Set([w.a.assignmentId, w.b.assignmentId]));
  });

  it("同一 batch + 账号的重复条目：全部被处理，只有一个内容 / 快照 / 发现，发现记录首次位置，重复位置在结果里", async () => {
    const w = await world();
    const r = await w.project(w.a, [{ postId: "a" }, { postId: "b" }, { postId: "a" }, { postId: "a" }]);
    expect(r.returnedEntries).toBe(4);
    expect(r.processedEntries).toBe(4); // 重复条目也算已处理
    expect(r.projectedContents).toBe(2);
    expect(r.duplicates).toEqual([{ platformContentId: "a", positions: [0, 2, 3] }]);
    const ds = await t.db.select().from(contentDiscoveries).orderBy(contentDiscoveries.absolutePosition);
    expect(ds.map((d) => d.absolutePosition)).toEqual([0, 1]);
    expect(await t.db.select().from(contentSnapshots)).toHaveLength(2);
  });

  it("合并后的值落库：后到真实 0 覆盖先到的 5；后到 missing 不擦除先到的有效标题", async () => {
    const w = await world();
    await w.project(w.a, [
      { postId: "a", like: 5, title: "有标题" },
      { postId: "a", like: 0, title: null },
    ]);
    const [s] = await t.db.select().from(contentSnapshots);
    expect(s).toMatchObject({ likeState: "value", likeValue: 0n, title: "有标题", playState: "unsupported", forwardState: "unsupported" });
  });

  it("没有可用 post_id 的条目计入已处理（不阻塞其余条目）；超长 post_id 同样不可投影", async () => {
    const w = await world();
    const r = await w.project(w.a, [{ postId: null }, { postId: "x".repeat(3000) }, { postId: "ok" }]);
    expect(r.returnedEntries).toBe(3);
    expect(r.processedEntries).toBe(3);
    expect(r.unprojectable.map((u) => u.reason)).toEqual(["post_id_missing", "post_id_too_long"]);
    expect(await t.db.select().from(contents)).toHaveLength(1);
  });

  it("内容身份按原文：19 位 ID、大小写、前导零都不被归一", async () => {
    const w = await world();
    await w.project(w.a, [{ postId: "7680127373081070848" }, { postId: "AbC" }, { postId: "abc" }, { postId: "007" }, { postId: "7" }]);
    const ids = (await t.db.select().from(contents)).map((c) => c.platformContentId).sort();
    expect(ids).toEqual(["007", "7", "7680127373081070848", "AbC", "abc"].sort());
  });

  it("整页原子：第 N 条写入失败时整页回滚，一行都不留（检查点因此不会越过缺失数据）", async () => {
    const w = await world();
    await expect(
      t.db.transaction(async (tx) => {
        const r = await projectContentPage(tx, {
          batchId: w.batchId,
          platformId: w.platformId,
          accountId: w.a.accountId,
          assignmentId: w.a.assignmentId,
          owner: null,
          sourceProviderCallId: w.callId,
          adapterVersion: "v",
          receivedAt: NOW,
          pageNo: 0,
          page: w.page(Array.from({ length: 5 }, (_, i) => ({ postId: `p${i}` }))),
          now: NOW,
        });
        expect(r.projectedContents).toBe(5);
        throw new Error("第 6 步失败");
      }),
    ).rejects.toThrow("第 6 步失败");
    expect(await t.db.select().from(contents)).toHaveLength(0);
    expect(await t.db.select().from(contentDiscoveries)).toHaveLength(0);
  });
});

describe("检查点：类型保真的游标与三种初始锚点", () => {
  const entries = (spec: Array<[string, bigint | null]>) =>
    spec.map(([platformContentId, ms]) => ({ platformContentId, publishedAtMs: ms === null ? ({ state: "missing" } as const) : ({ state: "value", value: ms } as const) }));

  async function establish(cursor: TypedCursor, es = entries([["a", 1000n]])) {
    await resetData(t.pool); // 同一用例里会多次调用
    const w = await world();
    const [task] = await t.db.insert(syncTasks).values({
      batchId: w.batchId, providerId: w.providerId, platformId: w.platformId, requestedAction: "fetch_content_list", subjectType: "external_account",
      taskParameters: {}, idempotencyKey: Buffer.alloc(32, 7), status: "pending", attemptCount: 0, maxAttempts: 3, expiresAt: new Date(NOW.getTime() + 1e9), createdAt: NOW, updatedAt: NOW,
    });
    const taskId = BigInt(task.insertId);
    const res = await t.db.transaction((tx) =>
      establishInitialCheckpoint(tx, { accountId: w.a.accountId, providerId: w.providerId, batchId: w.batchId, taskId, cursor, entries: es, now: NOW }),
    );
    const rows = await t.db.select().from(syncCheckpoints);
    return { w, res, row: rows[0] };
  }

  it("整数游标：原文保存（超过 2^53 不丢精度），不转字符串", async () => {
    const { row } = await establish({ kind: "integer", lexeme: "9007199254740993" });
    expect(row!.cursorEnvelope).toEqual({ kind: "integer", lexeme: "9007199254740993" });
  });

  it("字符串游标：原样保存，包括空串；null 游标是 {kind:null}；缺失 / 非法游标不存（NULL）", async () => {
    expect((await establish({ kind: "string", value: "6a5098aa" })).row!.cursorEnvelope).toEqual({ kind: "string", value: "6a5098aa" });
    expect((await establish({ kind: "string", value: "" })).row!.cursorEnvelope).toEqual({ kind: "string", value: "" });
    expect((await establish({ kind: "null" })).row!.cursorEnvelope).toEqual({ kind: "null" });
    const absent = (await establish({ kind: "absent" })).row!;
    expect([absent.cursorEnvelope, absent.cursorSha256]).toEqual([null, null]);
    const invalid = (await establish({ kind: "invalid", raw: "1.5" })).row!;
    expect([invalid.cursorEnvelope, invalid.cursorSha256]).toEqual([null, null]);
  });

  it("超长游标（8000 字符）往返不变", async () => {
    const value = "x".repeat(8000);
    const { row } = await establish({ kind: "string", value });
    expect(row!.cursorEnvelope).toEqual({ kind: "string", value });
    expect(row!.cursorSha256).not.toBeNull();
  });

  it("time 锚点：最大发布时间 + 同刻 ID；id_window：第一页全部 ID；empty：空集合", async () => {
    const time = (await establish({ kind: "integer", lexeme: "0" }, entries([["a", 1000n], ["b", 3000n], ["c", 3000n]]))).row!;
    expect(time).toMatchObject({ anchorMode: "time", highWatermarkContentIds: ["b", "c"] });
    expect(time.highWatermarkPublishedAt!.getTime()).toBe(3000);
    const idw = (await establish({ kind: "integer", lexeme: "0" }, entries([["z", null], ["y", null]]))).row!;
    expect(idw).toMatchObject({ anchorMode: "id_window", highWatermarkPublishedAt: null, highWatermarkContentIds: ["z", "y"] });
    const empty = (await establish({ kind: "integer", lexeme: "0" }, [])).row!;
    expect(empty).toMatchObject({ anchorMode: "empty", highWatermarkPublishedAt: null, highWatermarkContentIds: [] });
  });

  it("元数据：continuity ready、version 1、批次与任务引用；has_more / 页数不进检查点", async () => {
    const { row, w } = await establish({ kind: "integer", lexeme: "0" });
    expect(row).toMatchObject({ continuityStatus: "ready", version: 1n, lastSuccessfulBatchId: w.batchId, action: "fetch_content_list", checkpointScope: "default" });
    expect(Object.keys(row!).sort()).toEqual(
      ["accountId", "action", "anchorMode", "checkpointId", "checkpointScope", "continuityStatus", "cursorEnvelope", "cursorSha256", "cursorTaskId", "highWatermarkContentIds", "highWatermarkPublishedAt", "lastGapAt", "lastSuccessfulBatchId", "lastSuccessfulTaskId", "providerId", "updatedAt", "version"].sort(),
    );
  });

  it("已存在检查点：不改写（版本、游标、锚点都不变），旧批次迟到也不倒退", async () => {
    const first = await establish({ kind: "integer", lexeme: "111" }, entries([["a", 5000n]]));
    const again = await t.db.transaction((tx) =>
      establishInitialCheckpoint(tx, { accountId: first.w.a.accountId, providerId: first.w.providerId, batchId: first.w.batchId, taskId: first.row!.cursorTaskId!, cursor: { kind: "integer", lexeme: "999" }, entries: entries([["z", 1n]]), now: NOW }),
    );
    expect(again).toEqual({ established: false, reason: "exists" });
    const [row] = await t.db.select().from(syncCheckpoints).where(eq(syncCheckpoints.checkpointId, first.row!.checkpointId));
    expect(row).toMatchObject({ version: 1n, cursorEnvelope: { kind: "integer", lexeme: "111" }, highWatermarkContentIds: ["a"] });
  });
});
