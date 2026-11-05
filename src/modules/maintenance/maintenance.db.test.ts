// 每日维护（acceptance Q；FS-17）：fake clock 跑两次，第二次无新增删除；不动快照与媒资；孤儿清扫覆盖 smoke/ods/；失败退避后重试。
import { describe, expect, it } from "vitest";
import { useTestDb } from "../../../tests/harness/db";
import { FakeObjectStore } from "../../../tests/harness/fake-oss";
import { runPeriodic } from "../../../tests/harness/periodic";
import { setupSync } from "../../../tests/harness/sync-env";
import { accountProfileSnapshots, contentSnapshots, odsPayloads, odsProviderCalls, ossObjects } from "../../db/schema";
import { createMaintenance } from "./maintenance";

const t = useTestDb();
const YEAR_MS = 365 * 24 * 3600_000;
async function world(config = {}) {
  const env = await setupSync(t);
  await runPeriodic(t, env, [{ platform: "douyin", staffId: env.org.staffA, postIds: ["7000000000000000001", "7000000000000000002"] }]);
  const maint = createMaintenance({ db: t.db, store: env.store, clock: env.clock, config });
  return { env, maint };
}
const counts = async () => ({
  payloads: (await t.db.select().from(odsPayloads)).length,
  calls: (await t.db.select().from(odsProviderCalls)).length,
  profiles: (await t.db.select().from(accountProfileSnapshots)).length,
  contentSnaps: (await t.db.select().from(contentSnapshots)).length,
});

describe("runNow", () => {
  it("一年后清理 ODS（payload → call）；快照原样保留；第二次运行没有新增删除", async () => {
    const { env, maint } = await world();
    const before = await counts();
    expect(before.payloads).toBeGreaterThan(0);
    expect(env.store.keys("ods/").length).toBeGreaterThan(0);
    expect((await maint.runNow()).report.cleanup).toMatchObject({ payloadsDeleted: 0, callsDeleted: 0 }); // 还没到期
    env.clock.advance(YEAR_MS + 24 * 3600_000);
    const first = await maint.runNow();
    expect(first.ok).toBe(true);
    expect(first.report.cleanup!.payloadsDeleted).toBe(before.payloads);
    expect(first.report.cleanup!.callsDeleted).toBe(before.calls);
    const after = await counts();
    expect(after).toMatchObject({ payloads: 0, calls: 0, profiles: before.profiles, contentSnaps: before.contentSnaps }); // 结构化事实不动
    expect(env.store.keys("ods/")).toEqual([]);
    const second = await maint.runNow();
    expect(second.report.cleanup).toMatchObject({ payloadsDeleted: 0, callsDeleted: 0, tasksDeleted: 0, objectsDeleted: 0 });
    expect(await counts()).toEqual(after);
  });
  it("有界：maxPerRun 很小时一次只清一部分，多跑几次清完", async () => {
    const { env, maint } = await world({ maxPerRun: 1 });
    const total = (await counts()).payloads;
    env.clock.advance(YEAR_MS + 24 * 3600_000);
    const first = (await maint.runNow()).report.cleanup!;
    expect(first.payloadsDeleted).toBeGreaterThan(0);
    expect(first.payloadsDeleted).toBeLessThan(total);
    let runs = 1;
    while ((await counts()).payloads > 0 && runs < 50) (await maint.runNow(), runs++);
    expect((await counts()).payloads).toBe(0);
    expect(runs).toBeGreaterThan(1);
  });
  it("孤儿清扫覆盖 ods/ 与 smoke/ods/（超过宽限期、没有元数据行）；宽限期内的不动；媒资桶不参与", async () => {
    const { env, maint } = await world();
    const known = (await t.db.select().from(ossObjects)).length;
    await env.store.put("ods/orphan-old", new Uint8Array([1]));
    await env.store.put("smoke/ods/20261101/orphan-old", new Uint8Array([2]));
    env.clock.advance(2 * 3600_000); // 过了 1 小时宽限期
    await env.store.put("smoke/ods/20261108/orphan-new", new Uint8Array([3]));
    const media = new FakeObjectStore(env.clock);
    await media.put("media/ab/cdef", new Uint8Array([9]));
    const r = (await maint.runNow()).report;
    expect(r.orphans["ods/"]).toMatchObject({ deleted: 1 });
    expect(r.orphans["smoke/ods/"]).toMatchObject({ deleted: 1 });
    expect(env.store.keys("smoke/ods/")).toEqual(["smoke/ods/20261108/orphan-new"]);
    expect(env.store.keys("ods/").includes("ods/orphan-old")).toBe(false);
    expect(media.keys()).toEqual(["media/ab/cdef"]);
    expect((await t.db.select().from(ossObjects)).length).toBe(known); // 有元数据行的对象不是孤儿
  });
});

describe("runDaily", () => {
  it("北京时间 04:00 之前不跑；到点后每个自然日只成功跑一次；次日再跑", async () => {
    const { env, maint } = await world();
    expect(env.clock.now().toISOString()).toBe("2026-11-08T18:00:00.000Z"); // 北京 02:00
    expect(await maint.runDaily()).toEqual({ ran: false, reason: "not_due" });
    env.clock.advance(2 * 3600_000); // 北京 04:00
    expect(await maint.runDaily()).toMatchObject({ ran: true, ok: true });
    expect(await maint.runDaily()).toEqual({ ran: false, reason: "already_done" });
    env.clock.advance(3600_000);
    expect(await maint.runDaily()).toEqual({ ran: false, reason: "already_done" });
    env.clock.advance(24 * 3600_000); // 次日
    expect(await maint.runDaily()).toMatchObject({ ran: true, ok: true });
  });
  it("某一步失败：不抛出，其它步骤照常，保留现场并退避；退避后重试成功", async () => {
    const { env, maint } = await world();
    env.clock.advance(2 * 3600_000);
    const list = env.store.list.bind(env.store);
    env.store.list = async () => {
      throw new Error("oss down");
    };
    const r = await maint.runDaily();
    expect(r).toMatchObject({ ran: true, ok: false });
    if (r.ran) {
      expect(r.report.failedSteps).toEqual(["sweep_orphans:ods/", "sweep_orphans:smoke/ods/"]);
      expect(r.report.cleanup).not.toBeNull(); // 其它步骤照常
      expect(JSON.stringify(r.report)).not.toContain("oss down"); // 报告不带异常内容
    }
    expect(await maint.runDaily()).toEqual({ ran: false, reason: "backoff" });
    env.store.list = list;
    env.clock.advance(11 * 60_000);
    expect(await maint.runDaily()).toMatchObject({ ran: true, ok: true });
  });
});
