// 任务 10：能力升级、stale 与显式受控重算（SG-10、SG-11）。真实 MySQL；"升级"通过临时改版本表实现。
import { asc, count, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDb } from "../../../db/client";
import { contentFeatures, monitoringSegments, signalHistory, signalRecomputeRuns, signalResults, signalTasks, staffAccountAssignments } from "../../../db/schema";
import { resetData, useTestDb } from "../../../../tests/harness/db";
import { insertAccount, insertAssignment } from "../../../../tests/harness/factories";
import { insertStaff } from "../../../../tests/harness/plan";
import { seedOrg } from "../../../../tests/harness/seed";
import { QueryCounter, SIGNALS_T0 as T0, insertComment, insertFeature, seedContent } from "../../../../tests/harness/signals";
import { actor, content, createWorld, drain, makeSubject, type World } from "../../../../tests/harness/signals-world";
import { CAP_SEGMENT_MANAGE, CAP_SEGMENT_READ, type SignalActor } from "../authz";
import { CAPABILITY_VERSIONS } from "../catalog";
import { ingestComment } from "../features/ingest";
import { scanContents } from "../features/scan";
import { createFacts } from "../facts";
import { NORMALIZERS } from "../text/normalize";
import { claim } from "../tasks/queue";

const t = useTestDb();
const versions = CAPABILITY_VERSIONS as Record<string, number>;
const normalizers = NORMALIZERS as Record<number, (s: string) => string>;
/** 把 text.normalize 升到 2（保留 1 的实现，新增 2）；返回恢复函数。 */
function upgradeText(): () => void {
  versions["text.normalize"] = 2;
  normalizers[2] = (s) => NORMALIZERS[1]!(s);
  return () => {
    versions["text.normalize"] = 1;
    delete normalizers[2];
  };
}
const scanCfg = { scanBatch: 100, lookbackMs: 60_000 };
const cfgOf = (w: World) => ({ db: t.db, clock: w.clock, config: scanCfg });
const rows = async (table: typeof signalHistory | typeof signalRecomputeRuns | typeof signalTasks | typeof signalResults | typeof monitoringSegments) => (await t.db.select({ n: count() }).from(table))[0]!.n;
const readTitle = async (w: World, id: bigint, policy: "use_stale" | "as_unknown" = "use_stale") => w.signals.reader.read(actor, content(id), "text.title_normalized", { stalePolicy: policy });
const run = async (w: World, runId: bigint) => (await t.db.select().from(signalRecomputeRuns).where(eq(signalRecomputeRuns.runId, runId)))[0]!;

/** n 个内容，各有一行 v1 的特征行（通过真实扫描写入）。 */
async function scanned(w: World, n: number, accountId?: bigint): Promise<{ account: bigint; ids: bigint[] }> {
  const account = accountId ?? (await insertAccount(t.db, "douyin", T0));
  const ids: bigint[] = [];
  for (let i = 0; i < n; i++) ids.push((await seedContent(t.db, { accountId: account, pcid: `r${Math.random()}`, title: `标题${i} #t${i}`, selectedAt: new Date(T0.getTime() + i * 1000) })).contentId);
  await scanContents(cfgOf(w));
  return { account, ids };
}
const scopeOf = (ids: bigint[]) => ({ contentIds: ids });

describe("能力升级：旧值读作 stale，什么都不自动重算", () => {
  it("升版本后读作 stale（use_stale 带旧值、as_unknown 不可用不带值）；没有新任务、没有新的监控段版本、扫描器不重算素材未变的内容", async () => {
    const w = await createWorld(t);
    const { ids } = await scanned(w, 2);
    const segments = await rows(monitoringSegments);
    const restore = upgradeText();
    try {
      expect(await readTitle(w, ids[0]!)).toMatchObject({ state: "stale", usable: true, value: "标题0 #t0", normalizerVersion: 1 });
      const hidden = await readTitle(w, ids[0]!, "as_unknown");
      expect(hidden).toMatchObject({ state: "stale", usable: false });
      expect("value" in hidden).toBe(false);
      await scanContents(cfgOf(w)); // 正常扫描：素材未变 → 不重算历史
      expect(await readTitle(w, ids[0]!)).toMatchObject({ state: "stale" });
      expect([await rows(signalTasks), await rows(monitoringSegments), await rows(signalHistory)]).toEqual([0, segments, 0]);
    } finally {
      restore();
    }
  });
});

describe("preview / apply：范围、授权、记录", () => {
  it("没有范围或只有 segmentRef：scope_required；范围展开为空：scope_empty；目录外信号：signal_unregistered", async () => {
    const w = await createWorld(t);
    const r = w.signals.recompute;
    await expect(r.apply(actor, { signal: "text.title_normalized", scope: {} })).rejects.toMatchObject({ code: "scope_required" });
    await expect(r.apply(actor, { signal: "text.title_normalized", scope: { segmentRef: { planId: 1n, version: 1 } } })).rejects.toMatchObject({ code: "scope_required" });
    await expect(r.preview(actor, { signal: "text.title_normalized", scope: {} })).rejects.toMatchObject({ code: "scope_required" });
    await expect(r.apply(actor, { signal: "text.title_normalized", scope: { contentIds: [] } })).rejects.toMatchObject({ code: "scope_empty" });
    await expect(r.apply(actor, { signal: "text.title_normalized", scope: { contentIds: [999999n] } })).rejects.toMatchObject({ code: "scope_empty" });
    await expect(r.apply(actor, { signal: "content.cover_ocr_text", scope: { contentIds: [1n] } })).rejects.toMatchObject({ code: "signal_unregistered" });
    await expect(r.apply(actor, { signal: "text.title_normalized", scope: { contentIds: ["0123"] } })).rejects.toMatchObject({ code: "scope_invalid" });
    await expect(r.apply(actor, { signal: "content.cover_template_score", scope: { contentIds: [1n] } })).rejects.toMatchObject({ code: "segment_ref_required" });
    expect(await rows(signalRecomputeRuns)).toBe(0);
  });
  it("无 rule.definition.manage：先于任何读库被拒绝（零查询）", async () => {
    const w = await createWorld(t);
    const counter = new QueryCounter();
    const { createRecompute } = await import("./index");
    const r = createRecompute({ db: createDb(t.pool, { logger: counter }), clock: w.clock, audit: () => {}, config: { taskMaxAttempts: 3, leaseMs: 60_000, retryBackoffMs: 1000 }, requestAsService: (async () => undefined) as never });
    const reader: SignalActor = { actor: "user:r", capabilities: new Set([CAP_SEGMENT_READ]), brandScope: "all" };
    await expect(r.preview(reader, { signal: "text.title_normalized", scope: { contentIds: [1n] } })).rejects.toMatchObject({ code: "forbidden" });
    await expect(r.apply(reader, { signal: "text.title_normalized", scope: { contentIds: [1n] } })).rejects.toMatchObject({ code: "forbidden" });
    await expect(r.cancel(reader, { runId: 1n })).rejects.toMatchObject({ code: "forbidden" });
    expect(counter.count).toBe(0);
  });
  it("preview 与随后 apply 的条数一致；preview 不写任何表；apply 写一行记录（操作者、范围、条数、起止版本）和审计事件", async () => {
    const w = await createWorld(t);
    const { ids } = await scanned(w, 3);
    const restore = upgradeText();
    try {
      const before = [await rows(signalRecomputeRuns), await rows(signalTasks), await rows(signalHistory)];
      const p = await w.signals.recompute.preview(actor, { signal: "text.title_normalized", scope: scopeOf(ids) });
      expect(p).toEqual({ signal: "text.title_normalized", count: 3, fromVersion: 1, toVersion: 2 });
      expect([await rows(signalRecomputeRuns), await rows(signalTasks), await rows(signalHistory)]).toEqual(before);
      const a = await w.signals.recompute.apply(actor, { signal: "text.title_normalized", scope: scopeOf(ids) });
      expect(a).toMatchObject({ count: 3, resumed: false });
      const r = await run(w, a.runId);
      expect(r).toMatchObject({ requestedByActor: "service:d", signalKey: "text.title_normalized", scopeCount: 3, fromVersion: 1, toVersion: 2, status: "running", processedCount: 0 });
      expect(r.scope).toMatchObject({ content_ids: ids.map(String), restrict_brand_ids: null });
      expect(w.events.filter((e) => e.event_type === "recompute_previewed" || e.event_type === "recompute_applied").map((e) => [e.event_type, e.actor, e.counts?.count])).toEqual([["recompute_previewed", "service:d", 3], ["recompute_applied", "service:d", 3]]);
    } finally {
      restore();
    }
  });
  it("范围内全无旧值时 from_version 为 NULL", async () => {
    const w = await createWorld(t);
    const account = await insertAccount(t.db, "douyin", T0);
    const c = await seedContent(t.db, { accountId: account, pcid: "never-scanned" });
    const a = await w.signals.recompute.apply(actor, { signal: "text.title_normalized", scope: { contentIds: [c.contentId] } });
    expect((await run(w, a.runId)).fromVersion).toBeNull();
  });
});

describe("执行：只升范围内的对象", () => {
  it("重算后范围内读作 valid（nv 更新、历史 capability_upgraded、素材未变批次相同也重算），范围外仍 stale；不改监控段", async () => {
    const w = await createWorld(t);
    const { ids } = await scanned(w, 3);
    const segments = await rows(monitoringSegments);
    const restore = upgradeText();
    try {
      const a = await w.signals.recompute.apply(actor, { signal: "text.title_normalized", scope: scopeOf([ids[0]!, ids[1]!]) });
      while ((await w.signals.recompute.runBatch()) > 0);
      expect(await run(w, a.runId)).toMatchObject({ status: "completed", processedCount: 2, activeKey: null });
      expect(await readTitle(w, ids[0]!)).toMatchObject({ state: "valid", normalizerVersion: 2, capability: { version: 2 } });
      expect(await readTitle(w, ids[1]!)).toMatchObject({ state: "valid" });
      expect(await readTitle(w, ids[2]!)).toMatchObject({ state: "stale", normalizerVersion: 1 });
      const h = await t.db.select().from(signalHistory).where(eq(signalHistory.subjectId, ids[0]!));
      expect(h).toHaveLength(3);
      expect(h.every((x) => x.supersededReason === "capability_upgraded" && x.normalizerVersion === 1)).toBe(true);
      expect(await rows(monitoringSegments)).toBe(segments);
    } finally {
      restore();
    }
  });
  it("多块 + 中途杀进程续跑：每个对象只被处理一次（历史表无重复），最终完成", async () => {
    const w = await createWorld(t, { chunkSize: 2 });
    const { ids } = await scanned(w, 5);
    const restore = upgradeText();
    try {
      const a = await w.signals.recompute.apply(actor, { signal: "text.title_normalized", scope: scopeOf(ids) });
      // 第一块：领取后进程死掉（什么都没提交）
      await claim({ db: t.db, clock: w.clock, audit: () => {} }, { workerId: "crashed", leaseMs: 60_000, limit: 1, kinds: ["recompute_chunk"] });
      expect(await w.signals.recompute.runBatch()).toBe(0); // 租约未过期
      w.clock.advance(61_000);
      // 第二块：对象已处理（ingest 已写）、但游标 / 任务状态没来得及提交就死了
      const facts = createFacts(t.db);
      const { ingestContent } = await import("../features/ingest");
      const [claimed] = await claim({ db: t.db, clock: w.clock, audit: () => {} }, { workerId: "crashed2", leaseMs: 60_000, limit: 1, kinds: ["recompute_chunk"] });
      for (const f of (await facts.contentFacts(ids.slice(0, 2))).values()) await ingestContent({ db: t.db, clock: w.clock }, f, "recompute");
      expect(claimed).toBeDefined();
      w.clock.advance(61_000);
      let batches = 0;
      while ((await w.signals.recompute.runBatch()) > 0) batches++;
      expect(batches).toBe(3); // 5 个对象 / 每块 2 个
      expect(await run(w, a.runId)).toMatchObject({ status: "completed", processedCount: 5, cursorId: ids[4]! });
      expect(await rows(signalHistory)).toBe(15); // 5 个内容 × 3 个信号，没有重复
      for (const id of ids) expect(await readTitle(w, id)).toMatchObject({ state: "valid" });
    } finally {
      restore();
    }
  });
  it("同范围 running 的 run 再次 apply 续跑原 run；completed 之后再 apply 新建 run，范围内新进入的 stale 对象被补上、旧对象不重复处理", async () => {
    const w = await createWorld(t, { chunkSize: 10 });
    const { account, ids } = await scanned(w, 2);
    const restore = upgradeText();
    try {
      const input = { signal: "text.title_normalized", scope: { accountIds: [account] } };
      const a = await w.signals.recompute.apply(actor, input);
      const again = await w.signals.recompute.apply(actor, input);
      expect([again.runId, again.resumed]).toEqual([a.runId, true]);
      expect(await rows(signalRecomputeRuns)).toBe(1);
      while ((await w.signals.recompute.runBatch()) > 0);
      expect((await run(w, a.runId)).status).toBe("completed");
      const historyAfterFirst = await rows(signalHistory);
      // 同一账号后来新增了一个内容，它的特征行是升级前的版本（模拟升级前扫描过、现在才进入范围）
      const late = await seedContent(t.db, { accountId: account, pcid: "late", title: "晚来的" });
      await insertFeature(t.db, { contentId: late.contentId, snapshotId: late.snapshotId, over: { signals: { "text.title_normalized": { state: "valid", cap: "text.normalize", ver: 1, nv: 1, at: T0.toISOString() }, "text.body_normalized": { state: "valid", cap: "text.normalize", ver: 1, nv: 1, at: T0.toISOString() }, "text.hashtags": { state: "valid", cap: "text.hashtags.douyin", ver: 1, nv: 1, at: T0.toISOString() } } } });
      expect(await readTitle(w, late.contentId)).toMatchObject({ state: "stale" });
      const b = await w.signals.recompute.apply(actor, input);
      expect(b.runId).not.toBe(a.runId);
      while ((await w.signals.recompute.runBatch()) > 0);
      expect(await readTitle(w, late.contentId)).toMatchObject({ state: "valid" });
      expect((await rows(signalHistory)) - historyAfterFirst).toBe(3); // 只有新进入的那个内容多了 3 行
      for (const id of ids) expect((await t.db.select().from(signalHistory).where(eq(signalHistory.subjectId, id))).length).toBe(3);
    } finally {
      restore();
    }
  });
  it("failed 的 run 再次 apply 续跑：在 cursor 处复活 dead 的 chunk，最终完成", async () => {
    const w = await createWorld(t, { chunkSize: 2 });
    const { ids } = await scanned(w, 4);
    const restore = upgradeText();
    try {
      const input = { signal: "text.title_normalized", scope: scopeOf(ids) };
      const a = await w.signals.recompute.apply(actor, input);
      await w.signals.recompute.runBatch(); // 第一块完成，建第二块
      // 第二块重试用尽：任务 dead，run 置 failed（runner 观察到 dead 时的状态）
      await t.db.update(signalTasks).set({ status: "dead", attemptCount: 3, lastErrorCode: "retries_exhausted" }).where(eq(signalTasks.status, "pending"));
      await t.db.update(signalRecomputeRuns).set({ status: "failed", finishedAt: w.clock.now() });
      const [deadChunk] = await t.db.select().from(signalTasks).where(eq(signalTasks.status, "dead"));
      // dead 的 chunk 不能直接 revive（由 apply 续跑）
      await expect(w.signals.tasks.revive(actor, deadChunk!.taskId)).rejects.toMatchObject({ code: "task_not_revivable" });
      const b = await w.signals.recompute.apply(actor, input);
      expect([b.runId, b.resumed]).toEqual([a.runId, true]);
      expect(await run(w, a.runId)).toMatchObject({ status: "running", finishedAt: null });
      expect((await t.db.select().from(signalTasks).where(eq(signalTasks.taskId, deadChunk!.taskId)))[0]).toMatchObject({ status: "pending", attemptCount: 0 });
      while ((await w.signals.recompute.runBatch()) > 0);
      expect(await run(w, a.runId)).toMatchObject({ status: "completed", processedCount: 4 });
    } finally {
      restore();
    }
  });
});

describe("取消", () => {
  it("取消 running 的 run：未执行的 chunk 置 dead(run_cancelled)，revive 被拒；同范围可新建 run；对 completed / cancelled 再取消被拒", async () => {
    const w = await createWorld(t, { chunkSize: 2 });
    const { ids } = await scanned(w, 4);
    const restore = upgradeText();
    try {
      const input = { signal: "text.title_normalized", scope: scopeOf(ids) };
      const a = await w.signals.recompute.apply(actor, input);
      await w.signals.recompute.cancel(actor, { runId: a.runId });
      expect(await run(w, a.runId)).toMatchObject({ status: "cancelled", activeKey: null });
      expect(w.events.at(-1)).toMatchObject({ event_type: "recompute_cancelled", run_id: String(a.runId) });
      const [chunk] = await t.db.select().from(signalTasks);
      expect(chunk).toMatchObject({ status: "dead", lastErrorCode: "run_cancelled" });
      expect(await w.signals.recompute.runBatch()).toBe(0); // 不再运行
      expect(await rows(signalHistory)).toBe(0);
      await expect(w.signals.tasks.revive(actor, chunk!.taskId)).rejects.toMatchObject({ code: "task_not_revivable" });
      await expect(w.signals.recompute.cancel(actor, { runId: a.runId })).rejects.toMatchObject({ code: "run_not_cancellable" });
      const b = await w.signals.recompute.apply(actor, input);
      expect(b.runId).not.toBe(a.runId);
      while ((await w.signals.recompute.runBatch()) > 0);
      expect((await run(w, b.runId)).status).toBe("completed");
      await expect(w.signals.recompute.cancel(actor, { runId: b.runId })).rejects.toMatchObject({ code: "run_not_cancellable" });
      await expect(w.signals.recompute.cancel(actor, { runId: 99999n })).rejects.toMatchObject({ code: "run_not_found" });
    } finally {
      restore();
    }
  });
  it("正在执行的 chunk 在提交前看到 cancelled：不建下一块，run 保持 cancelled，任务 succeeded", async () => {
    const w = await createWorld(t, { chunkSize: 2 });
    const { ids } = await scanned(w, 4);
    const restore = upgradeText();
    try {
      const a = await w.signals.recompute.apply(actor, { signal: "text.title_normalized", scope: scopeOf(ids) });
      const [c] = await claim({ db: t.db, clock: w.clock, audit: () => {} }, { workerId: "w", leaseMs: 60_000, limit: 1, kinds: ["recompute_chunk"] });
      await w.signals.recompute.cancel(actor, { runId: a.runId }); // 此时 chunk 在 running，不被强杀
      expect(await w.signals.recompute.runChunk(c!)).toBe("dead"); // 开头就看到 cancelled
      expect(await run(w, a.runId)).toMatchObject({ status: "cancelled", processedCount: 0 });
      expect(await rows(signalTasks)).toBe(1);
    } finally {
      restore();
    }
  });
  it("tasks revive：非 dead 被拒；已完成重算的 chunk 被拒", async () => {
    const w = await createWorld(t, { chunkSize: 10 });
    const { ids } = await scanned(w, 1);
    const restore = upgradeText();
    try {
      const a = await w.signals.recompute.apply(actor, { signal: "text.title_normalized", scope: scopeOf(ids) });
      const [pending] = await t.db.select().from(signalTasks);
      await expect(w.signals.tasks.revive(actor, pending!.taskId)).rejects.toMatchObject({ code: "task_not_dead" });
      while ((await w.signals.recompute.runBatch()) > 0);
      await t.db.update(signalTasks).set({ status: "dead", lastErrorCode: "retries_exhausted" }).where(eq(signalTasks.taskId, pending!.taskId));
      await expect(w.signals.tasks.revive(actor, pending!.taskId)).rejects.toMatchObject({ code: "task_not_revivable" });
      await expect(w.signals.tasks.revive(actor, 99999n)).rejects.toMatchObject({ code: "task_not_found" });
      expect((await run(w, a.runId)).status).toBe("completed");
    } finally {
      restore();
    }
  });
});

describe("品牌范围与评论类", () => {
  it("品牌范围外的对象不在展开结果里；brandCode 越出操作者范围被拒；brandId 经当前归属展开", async () => {
    const w = await createWorld(t);
    const org = await seedOrg(t.db, T0);
    const a1 = await insertAccount(t.db, "douyin", T0);
    const a2 = await insertAccount(t.db, "douyin", T0);
    await insertAssignment(t.db, { accountId: a1, platform: "douyin", staffId: org.staffA, now: T0 }); // HITACHI
    await insertAssignment(t.db, { accountId: a2, platform: "douyin", staffId: org.staffC, now: T0 }); // HISENSE
    const c1 = await seedContent(t.db, { accountId: a1, pcid: "h", title: "日立" });
    const c2 = await seedContent(t.db, { accountId: a2, pcid: "s", title: "海信" });
    await scanContents(cfgOf(w));
    const restore = upgradeText();
    try {
      const hitachiOnly: SignalActor = { ...actor, brandScope: new Set(["HITACHI"]) };
      // 显式给了两个内容，但操作者只看得到日立的
      const p = await w.signals.recompute.preview(hitachiOnly, { signal: "text.title_normalized", scope: scopeOf([c1.contentId, c2.contentId]) });
      expect(p.count).toBe(1);
      await expect(w.signals.recompute.preview(hitachiOnly, { signal: "text.title_normalized", scope: { brandCode: "HISENSE" } })).rejects.toMatchObject({ category: "authorization", code: "brand_out_of_scope" });
      await expect(w.signals.recompute.preview(actor, { signal: "text.title_normalized", scope: { brandCode: "NOPE" } })).rejects.toMatchObject({ code: "brand_not_found" });
      expect((await w.signals.recompute.preview(actor, { signal: "text.title_normalized", scope: { brandCode: "HISENSE" } })).count).toBe(1);
      // 账号换到海信门店的专员名下后，品牌范围跟着走（当前归属）：日立操作者不再看得到它的内容
      const hisenseStaff = await insertStaff(t.db, { storeId: org.otherStoreId, phone: "13900000077" });
      await t.db.update(staffAccountAssignments).set({ staffId: hisenseStaff }).where(eq(staffAccountAssignments.accountId, a1));
      await expect(w.signals.recompute.apply(hitachiOnly, { signal: "text.title_normalized", scope: scopeOf([c1.contentId, c2.contentId]) })).rejects.toMatchObject({ code: "scope_empty" });
      // 不受限的操作者仍然看得到两个
      expect((await w.signals.recompute.preview(actor, { signal: "text.title_normalized", scope: scopeOf([c1.contentId, c2.contentId]) })).count).toBe(2);
    } finally {
      restore();
    }
  });
  it("评论类信号按内容范围重算：范围内评论升到当前版本，范围外不变", async () => {
    const w = await createWorld(t, { chunkSize: 10 });
    const acct = await insertAccount(t.db, "douyin", T0);
    const [c1, c2] = [await seedContent(t.db, { accountId: acct, pcid: "c1" }), await seedContent(t.db, { accountId: acct, pcid: "c2" })];
    const k1 = await insertComment(t.db, { contentId: c1.contentId, pcid: "k1", text: "评论一" });
    const k2 = await insertComment(t.db, { contentId: c2.contentId, pcid: "k2", text: "评论二" });
    for (const f of (await createFacts(t.db).commentFacts([k1, k2])).values()) await ingestComment({ db: t.db, clock: w.clock }, f);
    const restore = upgradeText();
    try {
      const read = (id: bigint) => w.signals.reader.read(actor, { kind: "comment", id }, "comment.text_normalized");
      expect((await read(k1)).state).toBe("stale");
      const a = await w.signals.recompute.apply(actor, { signal: "comment.text_normalized", scope: scopeOf([c1.contentId]) });
      expect(a.count).toBe(1);
      while ((await w.signals.recompute.runBatch()) > 0);
      expect(await read(k1)).toMatchObject({ state: "valid", normalizerVersion: 2 });
      expect(await read(k2)).toMatchObject({ state: "stale", normalizerVersion: 1 });
    } finally {
      restore();
    }
  });
});

describe("派生信号的重算（带 segmentRef）", () => {
  it("image.template 升到 2：旧结果读作 stale 且不重算；重算为 stale 的（素材×标准图）建 v2 任务，旧行保留，读到 v2", async () => {
    const w = await createWorld(t);
    const s = await makeSubject(t, "archived");
    await w.signals.requestScores(actor, w.plan, [content(s.id)]);
    await drain(w);
    expect(await rows(signalResults)).toBe(1);
    try {
      versions["image.template"] = 2;
      const read = () => w.signals.reader.read(actor, content(s.id), "content.cover_template_score", { param: { segment: w.plan } });
      expect(await read()).toMatchObject({ state: "stale", usable: true, score: 8, capability: { version: 1 } });
      expect((await w.signals.requestScores(actor, w.plan, [content(s.id)])).tasks.created).toBe(0); // 补算不覆盖 stale
      const p = await w.signals.recompute.preview(actor, { signal: "content.cover_template_score", scope: { contentIds: [s.id], segmentRef: w.plan } });
      expect(p).toMatchObject({ count: 1, fromVersion: 1, toVersion: 2 });
      const a = await w.signals.recompute.apply(actor, { signal: "content.cover_template_score", scope: { contentIds: [s.id], segmentRef: w.plan } });
      while ((await w.signals.recompute.runBatch()) > 0);
      expect((await run(w, a.runId)).status).toBe("completed");
      w.matcher.capabilityVersion = 2; // Python 镜像随目录升到 v2
      await drain(w);
      expect(await rows(signalResults)).toBe(2);
      expect(await read()).toMatchObject({ state: "valid", capability: { version: 2 } });
      expect((await t.db.select().from(signalResults).orderBy(asc(signalResults.capabilityVersion))).map((r) => r.capabilityVersion)).toEqual([1, 2]);
    } finally {
      versions["image.template"] = 1;
    }
  });
});
