// 导出规模实测（e-metrics-lite T5 / design §7.2）：660 名单账号 × 20 条内容 ≈ 13,200 行视频 + 660 账号，同步流式导出。
// 记录耗时与峰值 RSS；断言只设宽松上限，防数量级退化，不是性能合同。数字回填 design §7.1 / §12 与 ADR-0011。
import { performance } from "node:perf_hooks";
import { Writable } from "node:stream";
import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { contents, contentSnapshots, judgementPlanVersions } from "../../db/schema";
import { useTestDb } from "../../../tests/harness/db";
import { insertAccount, insertAssignment, insertBatch, sha } from "../../../tests/harness/factories";
import { addListTask, judgementEnv, judgementWorld, T0 } from "../../../tests/harness/judgement";
import { insertRosterEntry, insertStaff } from "../../../tests/harness/plan";
import { platformIdOf } from "../../../tests/harness/seed";
import { createRegistry } from "../access-control";
import { assembleReport } from "./assemble";
const t = useTestDb();
const ACCOUNTS = Number(process.env.EXPORT_PERF_ACCOUNTS ?? 660); // 默认 660；设 2500 可测 5 万行上限
const PER = 20;
const chunks = <T,>(xs: T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, (i + 1) * n));
const mb = (n: number) => Math.round(n / 1048576);
describe("660 账号 × 20 条内容的导出", () => {
  it(
    "耗时与峰值内存记录在案",
    async () => {
      const w = await judgementWorld(t);
      const e = judgementEnv(t, w, { config: { blockSize: 200, signalBatch: 1000, demandBatch: 1000, tickBudgetMs: 5000, waitSignalSeconds: 600, waitDemandSeconds: 7200 } });
      const day = (d: number) => new Date(Date.UTC(2026, 10, d, 4));
      const accountIds: bigint[] = [];
      for (let i = 0; i < ACCOUNTS; i++) {
        const staffId = await insertStaff(t.db, { storeId: w.stores.sW1, phone: String(13_700_000_000 + i) });
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
      const { planId } = await e.plans.create(e.creator, { activityPlanId: w.planId, alias: "导出规模" });
      await e.versions.setConfig(e.creator, planId, { window: { from: "2026-11-01", to: "2026-11-30" }, kinds: ["video"], layer1: { text: [{ fields: ["title"], mode: "any", keywords: ["海信"] }], quantity: { n: 3 } }, layer2: { abilities: [{ abilityId: "cover1", kind: "whole_image", target: "cover", threshold: "6.5" }] } });
      await e.versions.putTemplate(e.creator, planId, "cover1", new Uint8Array([1, 2, 3]));
      await t.db.update(judgementPlanVersions).set({ wizardStep: "compared" }).where(and(eq(judgementPlanVersions.planId, planId), eq(judgementPlanVersions.status, "draft")));
      const r = await e.runs.execute(e.creator, planId, { key: "perf" });
      const done = await e.runs.drive(r.runId, "w", e.sleep);
      expect(done.status).toBe("completed");
      // ---- 导出：丢弃字节，只数长度；采样 RSS ----
      const report = assembleReport({ db: t.db, env: {}, outcomes: e.outcomes, registry: createRegistry(), media: { signedGetUrl: async () => "https://signed.test/x" }, clock: e.clock });
      let bytes = 0;
      const sink = new Writable({ write(c, _enc, cb) { bytes += (c as Buffer).length; cb(); } });
      const finished = new Promise<void>((res, rej) => { sink.on("finish", res); sink.on("error", rej); });
      global.gc?.();
      const rssBefore = process.memoryUsage().rss;
      let peak = rssBefore;
      const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 50);
      const t0 = performance.now();
      const out = (await report.exportWorkbook(e.creator, planId.toString(), { filter: {} }, sink)) as { videoRows: number; accountRows: number };
      await finished;
      const ms = Math.round(performance.now() - t0);
      clearInterval(sampler);
      process.stdout.write(`\n[export-scale] ${JSON.stringify({ videoRows: out.videoRows, accountRows: out.accountRows, ms, fileMb: +(bytes / 1048576).toFixed(1), rssBeforeMb: mb(rssBefore), peakRssMb: mb(peak), growthMb: mb(peak - rssBefore) })}\n`);
      expect(out.videoRows).toBe(ACCOUNTS * PER);
      expect(out.accountRows).toBeGreaterThanOrEqual(ACCOUNTS);
      expect(ms).toBeLessThan(120_000); // 宽松上限；design §7.2 的改异步阈值是 20 秒 / 增长 300 MB
    },
    1_800_000,
  );
});
