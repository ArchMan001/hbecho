// 任务 11：保留期与清理（SG-10 / acceptance J3–J8、M7）。真实 MySQL；FakeClock 推进时间。
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "../../db/client";
import { contentFeatures, signalHistory, signalResults, signalTasks } from "../../db/schema";
import { useTestDb } from "../../../tests/harness/db";
import { insertAccount } from "../../../tests/harness/factories";
import { FakeMatcher, SIGNALS_T0 as T0, addSnapshot, seedContent, setCurrent } from "../../../tests/harness/signals";
import { actor, content, createWorld, drain, makeSubject, resultCount, taskCount, type World } from "../../../tests/harness/signals-world";
import { scanContents } from "./features/scan";
import { MatcherError } from "./scoring/ports";
import { retainUntil } from "./retention";
import type { SignalActor } from "./authz";

const t = useTestDb();
const at = (y: number, m: number, d: number, h = 3, mi = 0, s = 0) => new Date(Date.UTC(y, m - 1, d, h, mi, s));
const cover = (w: World, id: bigint) => w.signals.reader.read(actor, content(id), "content.cover_template_score", { param: { segment: w.plan } });
const results = () => t.db.select().from(signalResults);

/** 世界时钟起点 2026-11-12T03:00Z。fail=true 期间产出的结果是确定性失败（3 个月），否则成功（1 年）。 */
async function twoResults() {
  let fail = false;
  const matcher = new FakeMatcher(8).on(() => fail, new MatcherError("convert_failed", "候选图坏了", "candidate"));
  const w = await createWorld(t, { matcher });
  const ok = await makeSubject(t, "archived");
  await w.signals.requestScores(actor, w.plan, [content(ok.id)]);
  await drain(w);
  fail = true;
  const bad = await makeSubject(t, "archived");
  await w.signals.requestScores(actor, w.plan, [content(bad.id)]);
  await drain(w);
  return { w, ok, bad };
}

describe("清理器：过期的结果行被删，读取读作 missing 且不建任务", () => {
  it("推进 4 个月：失败行被清理、成功行仍在；推进 13 个月：成功行也被清理；读取 missing(not_computed)，任务表无新行", async () => {
    const { w, ok, bad } = await twoResults();
    expect((await results()).map((r) => [r.state, r.expiresAt]).sort()).toEqual([["failed", at(2027, 2, 12)], ["valid", at(2027, 11, 12)]]);
    expect(await cover(w, bad.id)).toMatchObject({ state: "failed", reason: "image_unreadable" });

    w.clock.set(at(2027, 2, 12, 3, 0, 1)); // 4 个月
    expect(await w.signals.retention.purgeExpired()).toMatchObject({ results: 1, history: 0, tasks: 0, completed: true });
    expect((await results()).map((r) => r.state)).toEqual(["valid"]);
    expect(await taskCount(t)).toBe(2); // 任务保留一年
    // 失败行被清后：任务 succeeded 但结果行不在 → 读作 not_computed，不触发识别
    expect(await cover(w, bad.id)).toMatchObject({ state: "missing", reason: "not_computed" });
    expect(await cover(w, ok.id)).toMatchObject({ state: "valid" });
    expect(await taskCount(t)).toBe(2);

    w.clock.set(at(2027, 11, 12, 3, 0, 1)); // 13 个月
    expect(await w.signals.retention.purgeExpired()).toMatchObject({ results: 1, tasks: 2, completed: true });
    expect(await resultCount(t)).toBe(0);
    expect(await taskCount(t)).toBe(0);
    expect(await cover(w, ok.id)).toMatchObject({ state: "missing", reason: "not_computed" });
    expect(await taskCount(t)).toBe(0); // 读取与清理都不建任务
    expect(w.matcher.requests.length).toBe(2); // 也没有再调用能力服务
  });

  it("只删终态任务：仍在运行的过期任务保留；重复运行幂等", async () => {
    const w = await createWorld(t);
    const a = await makeSubject(t, "archived");
    const b = await makeSubject(t, "archived");
    await w.signals.requestScores(actor, w.plan, [content(a.id), content(b.id)]);
    await drain(w); // 两个任务都 succeeded
    const [first] = await t.db.select().from(signalTasks);
    await t.db.update(signalTasks).set({ status: "running", leaseOwner: "w", leaseExpiresAt: at(2030, 1, 1) }).where(eq(signalTasks.taskId, first!.taskId));
    w.clock.set(at(2027, 11, 12, 3, 0, 1));
    expect(await w.signals.retention.purgeExpired()).toMatchObject({ results: 2, tasks: 1, completed: true });
    expect((await t.db.select().from(signalTasks)).map((r) => [r.taskId, r.status])).toEqual([[first!.taskId, "running"]]);
    expect(await w.signals.retention.purgeExpired()).toMatchObject({ results: 0, history: 0, tasks: 0 }); // 幂等
  });

  it("特征行不被清理；历史行按取代时刻 + 1 年清理；分块删除中途退出后可重跑", async () => {
    const w = await createWorld(t);
    const acct = await insertAccount(t.db, "douyin", T0);
    const c = await seedContent(t.db, { accountId: acct, pcid: "h", title: "旧标题" });
    const cfg = { db: t.db, clock: w.clock, config: { scanBatch: 100, lookbackMs: 60_000 } };
    await scanContents(cfg);
    const s2 = await addSnapshot(t.db, { contentId: c.contentId, logicalAt: new Date(T0.getTime() + 60_000), title: "新标题" });
    await setCurrent(t.db, c.contentId, s2, new Date(T0.getTime() + 60_000));
    await scanContents(cfg);
    const hist = await t.db.select().from(signalHistory);
    expect(hist).toHaveLength(3);
    expect(hist.every((h) => h.expiresAt.getTime() === at(2027, 11, 12).getTime())).toBe(true);

    w.clock.set(at(2027, 11, 12, 3, 0, 1));
    let chunks = 0;
    const partial = await w.signals.retention.purgeExpired({ chunkSize: 2, shouldStop: () => ++chunks >= 1 }); // 第一块删完就停
    expect(partial).toMatchObject({ history: 2, completed: false });
    expect(await t.db.select().from(signalHistory)).toHaveLength(1);
    const rerun = await w.signals.retention.purgeExpired({ chunkSize: 2 });
    expect(rerun).toMatchObject({ history: 1, completed: true });
    expect(await t.db.select().from(signalHistory)).toHaveLength(0);
    expect(await w.signals.retention.purgeExpired()).toMatchObject({ results: 0, history: 0, tasks: 0, completed: true });
    expect(await t.db.select().from(contentFeatures)).toHaveLength(1); // 特征行随内容存在
  });
});

describe("retainUntil", () => {
  it("延后后到原时间点仍在；传较早时间不缩短；过了新时间点才被清理", async () => {
    const { w, bad } = await twoResults();
    const row = (await results()).find((r) => r.state === "failed")!;
    expect(row.expiresAt).toEqual(at(2027, 2, 12));
    expect(await w.signals.retention.retainUntil(actor, [row.resultId], at(2027, 5, 1))).toEqual({ matched: 1 });
    expect((await results()).find((r) => r.state === "failed")!.expiresAt).toEqual(at(2027, 5, 1));
    expect(await w.signals.retention.retainUntil(actor, [row.resultId], at(2027, 3, 1))).toEqual({ matched: 1 }); // 较早：命中但不缩短
    expect((await results()).find((r) => r.state === "failed")!.expiresAt).toEqual(at(2027, 5, 1));

    w.clock.set(at(2027, 3, 1)); // 原时间点之后
    await w.signals.retention.purgeExpired();
    expect(await cover(w, bad.id)).toMatchObject({ state: "failed" });
    w.clock.set(at(2027, 5, 1, 3, 0, 1));
    await w.signals.retention.purgeExpired();
    expect(await cover(w, bad.id)).toMatchObject({ state: "missing", reason: "not_computed" });
  });

  it("契约（fake D 的调用序列）：读取 → 对读到的 resultId 去重 → retainUntil(读取时刻 + 3 个月)；不碰历史行与别的结果行；已被清理的 ID 不报错", async () => {
    const { w, ok, bad } = await twoResults();
    w.clock.set(at(2027, 1, 12)); // D 在 T0 + 2 个月读取
    const readAt = w.clock.now();
    const reads = [await cover(w, ok.id), await cover(w, bad.id), await cover(w, ok.id)];
    const ids = reads.map((r) => r.resultId);
    expect(ids.every((id) => typeof id === "bigint")).toBe(true);
    const distinct = [...new Set(ids as bigint[])];
    expect(distinct).toHaveLength(2);
    const until = at(2027, 4, 12);
    expect(until.getTime()).toBe(new Date(readAt.getTime()).setUTCMonth(readAt.getUTCMonth() + 3));
    // D 去重后调用一次；调用本身也容忍重复与已清理的 ID
    expect(await w.signals.retention.retainUntil(actor, [...ids as bigint[], 999_999n], until)).toEqual({ matched: 2 }); // 两行命中、999999 不存在；只有失败行（原 2 月 12 日）被延长，成功行原本更晚
    const rows = await results();
    expect(rows.find((r) => r.state === "failed")!.expiresAt).toEqual(until);
    expect(rows.find((r) => r.state === "valid")!.expiresAt).toEqual(at(2027, 11, 12));
    expect(await t.db.select().from(signalHistory)).toHaveLength(0);
  });

  it("缺 rule.run.execute 在读库之前被拒绝；until 非法被拒", async () => {
    const noCap: SignalActor = { actor: "x", capabilities: new Set(), brandScope: "all" };
    const untouchable = new Proxy({}, { get: () => { throw new Error("不应读库"); } }) as Db;
    await expect(retainUntil({ db: untouchable }, noCap, [1n], new Date())).rejects.toMatchObject({ code: "forbidden" });
    await expect(retainUntil({ db: untouchable }, actor, [1n], new Date("x"))).rejects.toMatchObject({ code: "invalid_until" });
  });
});
