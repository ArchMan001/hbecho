// 规模演练（design §12.1）：2,000 名单账号 × 平均 20 条内容 = 40,000 行的一次执行（FakeSignals，离线）。
// 记录各阶段耗时、峰值内存、run_contents / run_participants 行大小与表大小；数字回填 design §12.1。
// 断言只设宽松上限，防止数量级退化，不是性能合同。起始配置取 .env.example 里的建议值（块 200、信号批 1000、tick 预算 5 秒）。
import { performance } from "node:perf_hooks";
import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { contents, contentSnapshots, judgementPlanVersions, judgementRuns, runContents, runParticipants } from "../../db/schema";
import { useTestDb } from "../../../tests/harness/db";
import { insertBatch } from "../../../tests/harness/factories";
import { addListTask, judgementEnv, judgementWorld, T0 } from "../../../tests/harness/judgement";
import { insertRosterEntry, insertStaff } from "../../../tests/harness/plan";
import { insertAccount, insertAssignment } from "../../../tests/harness/factories";
import { platformIdOf } from "../../../tests/harness/seed";
import { sha } from "../../../tests/harness/factories";
const t = useTestDb();
const ACCOUNTS = 2000;
const PER = 20;
const chunks = <T,>(xs: T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, (i + 1) * n));
const mb = (n: number) => Math.round(n / 1048576);
describe("2,000 名单账号 × 20 条内容的一次执行", () => {
  it(
    "各阶段耗时、峰值内存与表大小记录在案",
    async () => {
      const w = await judgementWorld(t);
      const e = judgementEnv(t, w, { config: { blockSize: 200, signalBatch: 1000, demandBatch: 1000, tickBudgetMs: 5000, waitSignalSeconds: 600, waitDemandSeconds: 7200 } });
      const day = (d: number) => new Date(Date.UTC(2026, 10, d, 4));
      // ---- 造数：2,000 名专员 / 账号 / 归属 / 名单项 / 同步任务；40,000 条内容与快照 ----
      const t0 = performance.now();
      const accountIds: bigint[] = [];
      for (let i = 0; i < ACCOUNTS; i++) {
        const staffId = await insertStaff(t.db, { storeId: w.stores.sW1, phone: String(13_600_000_000 + i) });
        const accountId = await insertAccount(t.db, "douyin", T0);
        await insertAssignment(t.db, { accountId, platform: "douyin", staffId, now: T0, locator: `https://www.douyin.com/user/u${i}` });
        await insertRosterEntry(t.db, { planId: w.planId, accountId, staffId, storeId: w.stores.sW1, branchId: w.bj });
        await addListTask(t.db, { accountId, status: "succeeded", at: day(6) });
        accountIds.push(accountId);
      }
      const platformId = await platformIdOf(t.db, "douyin");
      const batchId = await insertBatch(t.db, T0);
      const rows = accountIds.flatMap((accountId, a) => Array.from({ length: PER }, (_, k) => ({ accountId, pcid: `c${a}-${k}`, like: (a * 7 + k * 13) % 500 })));
      for (const part of chunks(rows, 1000)) {
        await t.db.insert(contents).values(part.map((r) => ({ platformId, accountId: r.accountId, platformContentId: r.pcid, platformContentIdSha256: sha(r.pcid), contentKind: "video", status: "active", firstSeenAt: T0, lastSeenAt: T0, createdAt: T0, updatedAt: T0 })));
      }
      const all = await t.db.select({ id: contents.contentId, pcid: contents.platformContentId }).from(contents);
      const likeOf = new Map(rows.map((r) => [r.pcid, r.like]));
      for (const part of chunks(all, 1000)) {
        await t.db.insert(contentSnapshots).values(part.map((c) => ({ batchId, contentId: c.id, snapshotStatus: "finalized", publishedAt: day(5), durationState: "value", durationValue: "30", durationUnit: "seconds", playState: "unsupported", likeState: "value", likeValue: BigInt(likeOf.get(c.pcid)!), commentState: "missing", collectState: "missing", shareState: "missing", forwardState: "missing", snapshotAt: T0, mergePolicyVersion: "merge.v1", finalizedAt: T0, createdAt: T0, updatedAt: T0 })));
      }
      await t.db.execute(sql`UPDATE contents c JOIN content_snapshots s ON s.content_id = c.content_id SET c.current_snapshot_id = s.content_snapshot_id, c.current_snapshot_selected_at = ${T0}`);
      for (const c of all) {
        e.fake.setValue("text.title_normalized", c.id, { state: "valid", usable: true, value: c.id % 2n === 0n ? "海信新品" : "无关", normalizerVersion: 1 });
        e.fake.setValue("content.cover_template_score", c.id, { state: "valid", usable: true, score: Number(c.id % 11n) });
      }
      const { planId } = await e.plans.create(e.creator, { activityPlanId: w.planId, alias: "规模演练" });
      await e.versions.setConfig(e.creator, planId, { window: { from: "2026-11-01", to: "2026-11-30" }, kinds: ["video"], layer1: { text: [{ fields: ["title"], mode: "any", keywords: ["海信"] }], quantity: { n: 3 } }, layer2: { abilities: [{ abilityId: "cover1", kind: "whole_image", target: "cover", threshold: "6.5" }] } });
      await e.versions.putTemplate(e.creator, planId, "cover1", new Uint8Array([1, 2, 3]));
      await t.db.update(judgementPlanVersions).set({ wizardStep: "compared" }).where(and(eq(judgementPlanVersions.planId, planId), eq(judgementPlanVersions.status, "draft")));
      const setupMs = Math.round(performance.now() - t0);
      // ---- 执行：采样阶段切换与内存 ----
      const phases: Array<{ phase: string; at: number }> = [];
      let peakRss = 0;
      let peakHeap = 0;
      const start = performance.now();
      const sampler = setInterval(() => {
        const m = process.memoryUsage();
        peakRss = Math.max(peakRss, m.rss);
        peakHeap = Math.max(peakHeap, m.heapUsed);
        void t.db.select({ phase: judgementRuns.phase }).from(judgementRuns).limit(1).then(([r]) => {
          if (r?.phase && phases.at(-1)?.phase !== r.phase) phases.push({ phase: r.phase, at: Math.round(performance.now() - start) });
        });
      }, 50);
      const r = await e.runs.execute(e.creator, planId, { key: "scale" });
      const done = await e.runs.drive(r.runId, "w", e.sleep);
      const execMs = Math.round(performance.now() - start);
      clearInterval(sampler);
      expect(done.status).toBe("completed");
      expect(done.contentTotal).toBe(ACCOUNTS * PER);
      expect(done.participantCount).toBeGreaterThanOrEqual(ACCOUNTS); // 测试世界自带 1 名名单专员，没有内容
      // ---- 表大小 ----
      await t.db.execute(sql`ANALYZE TABLE run_contents, run_participants, judgement_runs`);
      const [sizes] = await t.db.execute(sql`SELECT table_name AS name, table_rows AS n, avg_row_length AS avgRow, data_length AS data, index_length AS idx FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN ('run_contents','run_participants','judgement_runs')`);
      const [rc] = await t.db.select({ n: sql<number>`COUNT(*)` }).from(runContents);
      const [rp] = await t.db.select({ n: sql<number>`COUNT(*)` }).from(runParticipants);
      const [json] = await t.db.execute(sql`SELECT ROUND(AVG(LENGTH(evidence))) AS avgEvidence, MAX(LENGTH(evidence)) AS maxEvidence FROM run_contents`);
      const transitions = phases.map((p, i) => `${p.phase}@${p.at}ms${i > 0 ? `(+${p.at - phases[i - 1]!.at})` : ""}`);
      process.stdout.write(`\n[scale-d] ${JSON.stringify({ accounts: ACCOUNTS, contents: ACCOUNTS * PER, setupMs, execMs, phases: transitions, peakRssMb: mb(peakRss), peakHeapMb: mb(peakHeap), runContents: Number(rc!.n), runParticipants: Number(rp!.n), evidence: (json as unknown as Array<Record<string, unknown>>)[0], sizes: (sizes as unknown as Array<Record<string, unknown>>).map((s) => ({ ...s, dataMb: mb(Number(s.data)), idxMb: mb(Number(s.idx)) })), readMany: e.fake.callsOf("readMany").length, requestScores: e.fake.callsOf("requestScores").length })}\n`);
      expect(Number(rc!.n)).toBe(ACCOUNTS * PER);
      expect(execMs).toBeLessThan(600_000); // 宽松上限：10 分钟
    },
    1_800_000,
  );
});
