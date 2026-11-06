// 状态查询（acceptance O、N；FS-15）：对照固定数据断言，且全程不发任何供应商调用。
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { useTestDb } from "../../../tests/harness/db";
import { runPeriodic } from "../../../tests/harness/periodic";
import { setupSync } from "../../../tests/harness/sync-env";
import { odsProviderCalls, staffAccountAssignments as aa, syncBatches } from "../../db/schema";
import { createSyncStatus } from "./status";

const t = useTestDb();
const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as { code?: string }).code ?? `other:${String(e)}`;
  }
  return null;
};
const posts = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

async function world() {
  const env = await setupSync(t);
  // dy：5 条且作者与主页一致 → verified；xhs：1 条 → unverifiable；ks：5 条但作者都不是它 → mismatch（任务失败）
  const [dy, xhs, ks] = await runPeriodic(t, env, [
    { platform: "douyin", staffId: env.org.staffA, postIds: posts("7000000000000000", 5) },
    { platform: "xiaohongshu", staffId: env.org.staffB, postIds: ["6a869a5c0000000014028682"] },
    { platform: "kuaishou", staffId: env.org.staffC, postIds: posts("ksp", 5), author: "SOMEONE_ELSE" },
  ]);
  await env.scheduler.tick(env.clock.now()); // 汇总：批次终态 + 建账号级媒资任务（没有跑媒资 Runner，所以引用保持 pending）
  const st = createSyncStatus({ db: t.db, clock: env.clock, resolver: env.resolver });
  const [batch] = await t.db.select().from(syncBatches).where(eq(syncBatches.purpose, "full"));
  return { env, st, dy: dy!, xhs: xhs!, ks: ks!, batchId: batch!.batchId.toString() };
}

describe("batch / status（FS-15.1、15.5、15.7）", () => {
  it("动作 × 状态计数、失败原因分布、缺口、三态身份校验分开计数、媒资进度、调用数与点数（已计点 vs ambiguous 分开）", async () => {
    const { env, st, batchId } = await world();
    const calls0 = env.transport.calls.length;
    const r = await st.batch(batchId);
    expect(r).toMatchObject({ purpose: "full", status: "partial_succeeded" });
    expect(r.tasks.fetch_profile).toEqual({ succeeded: 3 });
    expect(r.tasks.fetch_content_list).toEqual({ succeeded: 2, failed: 1 });
    expect(r.failureReasons).toEqual([{ code: "list_author_mismatch", count: 1 }]);
    expect(r.identityCheck.list).toEqual({ verified: 1, unverifiable: 1, mismatch: 1, unknown: 0 }); // 无法判定不并入一致
    expect(r.identityCheck.profile).toEqual({ verified: 3, mismatch: 0 });
    // 3 次主页 + 3 次列表；成功的才计点：抖音 10+10、小红书 15+15、快手 10+10（失败任务的列表调用本身成功）
    expect(r.cost).toMatchObject({ calls: 6, polls: 0, points: 70, estimatedYuan: 1.4, ambiguous: { calls: 0, pointsUpperBound: 0 } });
    expect(r.media.total).toBeGreaterThan(0);
    expect(r.media).toMatchObject({ pending: r.media.total, archived: 0, failed: 0, noAudioTrack: 0 });
    expect(env.transport.calls.length).toBe(calls0); // 只读本地，没有供应商调用
    // ambiguous：另列，不并入已计点
    const [call] = await t.db.select().from(odsProviderCalls).where(eq(odsProviderCalls.requestedAction, "media_user_info")).limit(1);
    await t.db.update(odsProviderCalls).set({ outcome: "ambiguous" }).where(eq(odsProviderCalls.providerCallId, call!.providerCallId));
    const r2 = await st.batch(batchId);
    expect(r2.cost.ambiguous.calls).toBe(1);
    expect(r2.cost.ambiguous.pointsUpperBound).toBeGreaterThan(0);
    expect(r2.cost.points).toBe(70 - r2.cost.ambiguous.pointsUpperBound);
    const o = await st.status();
    expect(o.latestFull?.batchId).toBe(batchId);
    expect(o.recent[0]).toMatchObject({ batchId, purpose: "full" });
    expect(await code(st.batch("424242"))).toBe("not_found");
    expect(await code(st.batch("abc"))).toBe("invalid_input");
  });
});

describe("account（FS-15.2）", () => {
  it("最近批次的主页 / 列表结果、检查点（锚点模式、游标类型、连续性）、被排除原因、相关质量问题", async () => {
    const { env, st, dy, ks } = await world();
    const a = await st.account(dy.accountId.toString());
    expect(a).toMatchObject({ platform: "douyin", watchType: "staff", accountStatus: "active", monitoring: { enabled: true, effective: true, excludedBecause: null } });
    expect(a.recentTasks.map((x) => [x.action, x.status, x.identityCheck])).toEqual([["fetch_content_list", "succeeded", "verified"], ["fetch_profile", "succeeded", "verified"]]);
    expect(a.checkpoint).toMatchObject({ continuityStatus: expect.any(String), anchorMode: expect.any(String) });
    expect(a.checkpoint?.cursorType === null || ["string", "integer", "null"].includes(a.checkpoint!.cursorType!)).toBe(true);
    const k = await st.account(ks.accountId.toString());
    expect(k.recentTasks.find((x) => x.action === "fetch_content_list")).toMatchObject({ status: "failed", errorCode: "list_author_mismatch", identityCheck: "mismatch" });
    expect(k.openIssues.map((i) => i.code)).toContain("list_author_mismatch");
    // 被排除原因
    await t.db.update(aa).set({ monitoringEnabled: false, monitoringClosedReason: "manual" }).where(eq(aa.accountId, dy.accountId));
    expect((await st.account(dy.accountId.toString())).monitoring).toMatchObject({ enabled: false, closedReason: "manual", effective: false, excludedBecause: "account_off" });
    expect(await code(st.account("424242"))).toBe("not_found");
  });
});

describe("freshness / sample（FS-15.3、15.8）", () => {
  it("freshness：从未成功列表的账号过期；推进时间后全部过期；不发调用", async () => {
    const { env, st, ks } = await world();
    const calls0 = env.transport.calls.length;
    const f = await st.freshness({ olderThanHours: 24 });
    expect(f).toMatchObject({ monitoredAccounts: 3, staleAccounts: 1 });
    expect(f.stale[0]).toMatchObject({ accountId: ks.accountId.toString(), watchType: "staff", lastListAt: null });
    env.clock.advance(10 * 24 * 3600_000);
    expect((await st.freshness({ olderThanHours: 24 })).staleAccounts).toBe(3);
    expect((await st.freshness({ olderThanHours: 24, limit: 1 })).stale).toHaveLength(1);
    expect(await code(st.freshness({ olderThanHours: 0 }))).toBe("invalid_input");
    expect(env.transport.calls.length).toBe(calls0);
  });
  it("sample：只从本批次成功的账号抽；N 超过成功账号数时返回全部；输出白名单字段，不含对象 key / 临时 URL", async () => {
    const { env, st, ks, batchId } = await world();
    const calls0 = env.transport.calls.length;
    const s = await st.sample({ n: 50 });
    expect(s).toMatchObject({ batchId, requested: 50, returned: 2 });
    expect(s.accounts.map((a) => a.accountId)).not.toContain(ks.accountId.toString()); // 失败的不抽
    for (const a of s.accounts) {
      expect(Object.keys(a).sort()).toEqual(["accountId", "entry", "identifiers", "list", "platform", "profile"]);
      expect(a.identifiers.length).toBeGreaterThan(0);
      expect(a.profile).not.toBeNull();
    }
    const one = await st.sample({ n: 1 });
    expect(one.returned).toBe(1);
    expect(JSON.stringify(s)).not.toMatch(/signature|x-oss|objectKey|\.part/i);
    expect(await code(st.sample({ n: 0 }))).toBe("invalid_input");
    expect(await code(st.sample({ n: 1, batchId: "424242" }))).toBe("not_found");
    expect(env.transport.calls.length).toBe(calls0);
  });
});

describe("O4：全部查询输出脱敏", () => {
  it("status / batch / account / freshness / sample 的输出不含凭证、完整对象 key、签名或临时 URL 参数", async () => {
    const { st, dy, batchId } = await world();
    const all = JSON.stringify([await st.status(), await st.batch(batchId), await st.account(dy.accountId.toString()), await st.freshness({ olderThanHours: 24 }), await st.sample({ n: 10 })]);
    // 主页入口（homepage）可以出现；对象存储 key、签名、凭证、过期参数不可以
    expect(all).not.toMatch(/x-signature|signature=|expires=|accesskey|secret|password|authorization|bearer|\bods\/|\bmedia\/|objectKey|\.part\b/i);
  });
});
