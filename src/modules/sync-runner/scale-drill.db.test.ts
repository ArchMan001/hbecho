// 规模演练（FS-18.4、acceptance R4）：N 个账号 / 三平台，fake transport 跑一轮完整的周期批次。
// 记录：规划耗时、执行耗时、峰值 RSS、各表行数、是否有重复任务、claimNext 的 EXPLAIN、批次预算「实际 / 上限」。
// 默认跳过（几十分钟级，不属于每次 verify）：HBECHO_SCALE_DRILL=1 HBECHO_SCALE_ACCOUNTS=6000 ./scripts/with-test-mysql.sh pnpm exec vitest --run --project db src/modules/sync-runner/scale-drill.db.test.ts
// 数字写入 design §12；超出预期（规划 > 10 分钟 / 内存异常）要停下来问，所以这里不设"通过阈值"，只设"没有重复、全部终态"的正确性断言。
import { writeFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { useTestDb } from "../../../tests/harness/db";
import { listBytes } from "../../../tests/harness/list-bytes";
import { loadFixtureBytes } from "../../../tests/harness/fixtures";
import { sha } from "../../../tests/harness/factories";
import { LIST_PATH, PROFILE_PATH, SLOT, setupSync } from "../../../tests/harness/sync-env";
import { platformIdOf } from "../../../tests/harness/seed";
import { contentSnapshots, externalAccountIdentifiers, externalAccounts, mediaStaff, odsProviderCalls, staffAccountAssignments, syncBatches, syncTasks } from "../../db/schema";
import { createMonitoringResolver } from "../monitoring";
import { createSyncScheduler } from "../sync-schedule";
import { createAccountRunners } from "./account-runners";
import { createBatchBudgetPolicy } from "./budget";
import { RUNTIME } from "../../../tests/harness/sync-env";

const N = Number(process.env.HBECHO_SCALE_ACCOUNTS ?? 6000);
const MAX_CALLS = 25_000; // 与 sync-config.test 的示例配置同量级
const MAX_POINTS = 210_000;
const t = useTestDb();

const PLATFORMS = [
  { code: "douyin", fixture: "raw3.douyin.media_user_info", uid: "HITACHI1" },
  { code: "xiaohongshu", fixture: "raw3.xiaohongshu.media_user_info", uid: "49328995493" },
  { code: "kuaishou", fixture: "raw12.K1", uid: "3xcqkweabmmz6pk" },
] as const;
const chunk = <T>(xs: T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, (i + 1) * n));

describe.skipIf(!process.env.HBECHO_SCALE_DRILL)(`规模演练：${N} 账号 / 三平台`, () => {
  it("规划、执行一轮周期批次；无重复任务；全部任务终态；记录数字", { timeout: 4 * 3600_000 }, async () => {
    const policy = createBatchBudgetPolicy(t.db, { maxCalls: MAX_CALLS, maxPoints: MAX_POINTS });
    const env = await setupSync(t, { concurrency: 4, policy });
    const now = env.clock.now();
    const per = Math.ceil(N / PLATFORMS.length);

    // ── 造数据：每平台 per 个专员、每专员一个账号（名额唯一约束：一专员一平台一账号） ──
    const staffRows = Array.from({ length: per }, (_, i) => ({ storeId: env.org.storeId, staffName: `演练专员${i}`, phone: `139${String(i).padStart(8, "0")}`, status: "active", createdAt: now, updatedAt: now }));
    for (const part of chunk(staffRows, 500)) await t.db.insert(mediaStaff).values(part);
    const staffIds = (await t.db.select({ id: mediaStaff.staffId }).from(mediaStaff).where(sql`${mediaStaff.staffName} LIKE '演练专员%'`).orderBy(mediaStaff.staffId)).map((r) => r.id);
    expect(staffIds).toHaveLength(per);
    const accounts: Array<{ accountId: bigint; platform: (typeof PLATFORMS)[number]; uid: string; locator: string }> = [];
    let next = 1_000_000n;
    for (const p of PLATFORMS) {
      const platformId = await platformIdOf(t.db, p.code);
      for (let i = 0; i < per && accounts.length < N; i++) {
        const accountId = next++;
        accounts.push({ accountId, platform: p, uid: `U${accountId}`, locator: env.locatorOf(accountId) });
      }
      const mine = accounts.filter((a) => a.platform === p);
      for (const part of chunk(mine, 500)) {
        await t.db.insert(externalAccounts).values(part.map((a) => ({ accountId: a.accountId, platformId, firstSeenAt: now, lastSeenAt: now, createdAt: now, updatedAt: now })));
        await t.db.insert(externalAccountIdentifiers).values(
          part.map((a) => ({ accountId: a.accountId, namespaceCode: p.code === "douyin" ? "douyin.user_id" : p.code === "xiaohongshu" ? "xiaohongshu.profile.user_id" : "kuaishou.user_id", identifierValue: a.uid, identifierSha256: sha(a.uid), bindingMethod: "same_payload", confidence: "observed", firstSeenAt: now, lastSeenAt: now, createdAt: now })),
        );
        await t.db.insert(staffAccountAssignments).values(
          part.map((a) => ({ watchType: "staff", staffId: staffIds[mine.indexOf(a)]!, accountId: a.accountId, platformId, monitoringEnabled: true, currentHomeLocator: a.locator, currentHomeLocatorSha256: sha(a.locator), resolvedHomeUrl: a.locator, resolvedHomeUrlSha256: sha(a.locator), intakeStatus: "normal", createdAt: now, updatedAt: now })),
        );
      }
    }
    // fake transport：主页按账号替换标识；列表每账号 3 条（作者 = 该账号）
    const byLocator = new Map(accounts.map((a) => [a.locator, a]));
    const fixtureText = new Map(PLATFORMS.map((p) => [p.code, new TextDecoder().decode(loadFixtureBytes(p.fixture))]));
    env.routeAt(PROFILE_PATH, ({ url }) => {
      const a = byLocator.get(url)!;
      return new TextEncoder().encode(fixtureText.get(a.platform.code)!.replace(a.platform.uid, a.uid));
    });
    env.routeAt(LIST_PATH, ({ url }) => {
      const a = byLocator.get(url)!;
      return listBytes(Array.from({ length: 3 }, (_, i) => ({ postId: `${a.accountId}-${i}`, userId: a.uid, createdMs: 1788169004000 - i * 1000 })), { hasMore: false, cursorJson: "0" });
    });

    // ── 内存采样 ──
    let peakRss = 0;
    const sampler = setInterval(() => (peakRss = Math.max(peakRss, process.memoryUsage().rss)), 200);

    // ── 规划（B11：分块 ≤ 500；记录块数） ──
    const real = createMonitoringResolver(t.db);
    const limits: number[] = [];
    const scheduler = createSyncScheduler({ db: t.db, clock: env.clock, resolver: { ...real, targets: async (q) => (limits.push(q.limit), real.targets(q)) }, runtime: RUNTIME });
    const planStart = Date.now();
    await scheduler.tick(SLOT);
    const planMs = Date.now() - planStart;
    const [batch] = await t.db.select().from(syncBatches);
    const taskCount = (await t.db.select({ n: sql<number>`COUNT(*)`.mapWith(Number) }).from(syncTasks))[0]!.n;

    // ── claimNext 的 EXPLAIN（规划完成、尚无任务被领取时） ──
    const [explain] = (await t.db.execute(sql`
      EXPLAIN SELECT t.task_id FROM sync_tasks t
      WHERE ((t.status IN ('pending','retry_wait') AND (t.next_attempt_at IS NULL OR t.next_attempt_at <= ${SLOT}))
          OR (t.status IN ('leased','running') AND t.lease_expires_at <= ${SLOT}))
        AND t.expires_at > ${SLOT}
        AND t.requested_action IN ('fetch_profile','fetch_content_list')
        AND EXISTS (SELECT 1 FROM sync_batches b WHERE b.batch_id = t.batch_id AND b.purpose IN ('full','supplement','demand') AND b.status = 'running')
      ORDER BY t.priority DESC, t.attempt_count ASC, t.task_id ASC LIMIT 4 FOR UPDATE SKIP LOCKED`)) as unknown as [Array<Record<string, unknown>>];

    // ── 执行 ──
    const runStart = Date.now();
    const stats = await env.worker(createAccountRunners(env.deps)).run({ untilIdle: true });
    const runMs = Date.now() - runStart;
    await scheduler.tick(env.clock.now()); // 汇总
    clearInterval(sampler);

    // ── 统计 ──
    const dupKeys = (await t.db.execute(sql`SELECT COUNT(*) AS n FROM (SELECT idempotency_key FROM sync_tasks GROUP BY idempotency_key HAVING COUNT(*) > 1) d`)) as unknown as [Array<{ n: string }>];
    const dupTriples = (await t.db.execute(sql`SELECT COUNT(*) AS n FROM (SELECT batch_id, account_id, requested_action FROM sync_tasks GROUP BY batch_id, account_id, requested_action HAVING COUNT(*) > 1) d`)) as unknown as [Array<{ n: string }>];
    const byStatus = await t.db.select({ status: syncTasks.status, n: sql<number>`COUNT(*)`.mapWith(Number) }).from(syncTasks).where(sql`${syncTasks.requestedAction} IN ('fetch_profile','fetch_content_list')`).groupBy(syncTasks.status);
    const mediaTasks = (await t.db.select({ n: sql<number>`COUNT(*)`.mapWith(Number) }).from(syncTasks).where(eq(syncTasks.requestedAction, "download_media")))[0]!.n; // 汇总时按账号建，本演练不跑媒资 Runner
    const errors = await t.db.select({ action: syncTasks.requestedAction, status: syncTasks.status, code: syncTasks.lastErrorCode, detail: sql<string>`LEFT(CAST(${syncTasks.lastErrorDetail} AS CHAR), 200)`, n: sql<number>`COUNT(*)`.mapWith(Number) }).from(syncTasks).where(sql`${syncTasks.lastErrorCode} IS NOT NULL`).groupBy(syncTasks.requestedAction, syncTasks.status, syncTasks.lastErrorCode, sql`LEFT(CAST(${syncTasks.lastErrorDetail} AS CHAR), 200)`);
    const snapshots = (await t.db.select({ n: sql<number>`COUNT(*)`.mapWith(Number) }).from(contentSnapshots))[0]!.n;
    const calls = (await t.db.select({ n: sql<number>`COUNT(*)`.mapWith(Number) }).from(odsProviderCalls))[0]!.n;
    const [finalBatch] = await t.db.select().from(syncBatches).where(eq(syncBatches.batchId, batch!.batchId));
    // 最近一次死锁的现场（诊断用：哪两条语句、哪个索引）
    const [innodb] = (await t.db.execute(sql`SHOW ENGINE INNODB STATUS`)) as unknown as [Array<{ Status: string }>];
    const dl = /LATEST DETECTED DEADLOCK[\s\S]*?(?=\n-{10,}\n(?:TRANSACTIONS|FILE I\/O))/.exec(innodb[0]?.Status ?? "")?.[0] ?? null;
    if (dl) writeFileSync(`/tmp/scale-drill-${N}.deadlock.txt`, dl);
    const report = {
      accounts: accounts.length,
      planMs,
      planChunks: limits.length,
      maxChunkLimit: Math.max(...limits),
      tasksPlanned: taskCount,
      runMs,
      tasksPerSecond: Math.round((taskCount / (runMs / 1000)) * 10) / 10,
      peakRssMb: Math.round(peakRss / 1024 / 1024),
      rows: { syncTasks: taskCount, contentSnapshots: snapshots, providerCalls: calls },
      errors,
      mediaTasksCreated: mediaTasks,
      structuredTasksByStatus: Object.fromEntries(byStatus.map((r) => [r.status, r.n])),
      duplicateIdempotencyKeys: Number(dupKeys[0][0]!.n),
      duplicateBatchAccountAction: Number(dupTriples[0][0]!.n),
      batchStatus: finalBatch!.status,
      workerStats: stats,
      budget: { callsUsed: calls, maxCalls: MAX_CALLS, callsRatio: Math.round((calls / MAX_CALLS) * 1000) / 1000, maxPoints: MAX_POINTS },
      claimNextExplain: explain.map((r) => ({ table: r.table, type: r.type, key: r.key, rows: r.rows, Extra: r.Extra })),
    };
    writeFileSync(`/tmp/scale-drill-${N}.json`, JSON.stringify(report, null, 2));
    console.log("[scale-drill]", JSON.stringify(report));

    // 正确性断言（不设性能阈值：数字要写进 design §12，超出预期人来判断）
    expect(taskCount).toBe(accounts.length * 2); // 每个自有账号：主页 + 列表
    expect(report.duplicateIdempotencyKeys).toBe(0);
    expect(report.duplicateBatchAccountAction).toBe(0);
    expect(report.maxChunkLimit).toBeLessThanOrEqual(500); // B11：每块 ≤ 500
    expect(report.planChunks).toBeGreaterThanOrEqual(Math.ceil(accounts.length / 500));
    expect(byStatus.every((r) => ["succeeded", "succeeded_with_gap", "failed", "dead", "cancelled"].includes(r.status))).toBe(true);
  });
});
