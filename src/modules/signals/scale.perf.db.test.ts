// 任务 13 规模演练（design §12.1）：扫描吞吐、readMany 耗时与查询次数、评分任务的领取与执行吞吐。
// 默认（verify.sh）跑缩小规模，保证路径可用、查询次数为常数；完整规模由 HBECHO_SIGNALS_DRILL=full 打开：
//   HBECHO_SIGNALS_DRILL=full ./scripts/with-test-mysql.sh pnpm exec vitest --run --project db src/modules/signals/scale.perf.db.test.ts
// 数字写到 stdout（[signals-scale] 开头的 JSON 行），回填 design §12.1；用的是本机一次性 MySQL，不代表测试 ECS。
import { count, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDb } from "../../db/client";
import { contentFeatures, signalResults, signalTasks } from "../../db/schema";
import { useTestDb } from "../../../tests/harness/db";
import { insertAccount, insertBatch } from "../../../tests/harness/factories";
import { platformIdOf } from "../../../tests/harness/seed";
import { QueryCounter, SIGNALS_T0 as T0, seedContent } from "../../../tests/harness/signals";
import { actor, content, createWorld, drain, makeSubject } from "../../../tests/harness/signals-world";
import { CAP_SEGMENT_READ, type SignalActor } from "./authz";
import { DEFAULT_ENABLED_CAPABILITIES } from "./catalog";
import { scanContents } from "./features/scan";
import { createReader } from "./reader";
import { claim } from "./tasks/queue";

const t = useTestDb();
const FULL = process.env.HBECHO_SIGNALS_DRILL === "full";
const SIZE = FULL ? { contents: 200_000, readMany: 5_000, claims: 10_000, runs: 1_000 } : { contents: 3_000, readMany: 2_000, claims: 1_000, runs: 100 };
const report = (o: Record<string, unknown>) => process.stdout.write(`\n[signals-scale] ${JSON.stringify({ full: FULL, ...o })}\n`);
const WHOLE_TEST_MS = 3_600_000;

/** 用一个模板内容 + 一个模板快照，经 INSERT … SELECT 批量造 n 个带 current 快照的内容（不逐行走工厂）。 */
async function bulkContents(n: number): Promise<void> {
  const acct = await insertAccount(t.db, "douyin", T0);
  const tmpl = await seedContent(t.db, { accountId: acct, pcid: "tmpl", title: "模板" });
  const platformId = await platformIdOf(t.db, "douyin");
  const [cols] = await t.pool.query("SELECT column_name AS c FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'content_snapshots' AND column_name NOT IN ('content_snapshot_id','content_id','title','body','tag_text','current_flag')");
  const copied = (cols as Array<{ c: string }>).map((r) => `\`${r.c}\``);
  await t.pool.query("SET SESSION cte_max_recursion_depth = ?", [n + 10]);
  await t.pool.query(
    `INSERT INTO contents (platform_id, account_id, platform_content_id, platform_content_id_sha256, first_seen_at, last_seen_at, created_at, updated_at)
     WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ?)
     SELECT ?, ?, CONCAT('drill-', n), UNHEX(SHA2(CONCAT('drill-', n), 256)), ?, ?, ?, ? FROM seq`,
    [n, platformId, acct, T0, T0, T0, T0],
  );
  await t.pool.query(
    `INSERT INTO content_snapshots (content_id, title, body, tag_text, ${copied.join(",")})
     SELECT c.content_id, CONCAT('标题 ', c.content_id, ' #话题', c.content_id % 50), '', '#a #b', ${copied.map((c) => `s.${c}`).join(",")}
     FROM contents c JOIN content_snapshots s ON s.content_snapshot_id = ? WHERE c.platform_content_id LIKE 'drill-%'`,
    [tmpl.snapshotId],
  );
  await t.pool.query(
    `UPDATE contents c JOIN content_snapshots s ON s.content_id = c.content_id AND c.platform_content_id LIKE 'drill-%'
     SET c.current_snapshot_id = s.content_snapshot_id, c.current_snapshot_selected_at = ?`,
    [T0],
  );
}

describe("规模演练", () => {
  it(
    "内容扫描吞吐 + readMany 耗时与查询次数",
    async () => {
      const w = await createWorld(t);
      const seedStart = Date.now();
      await bulkContents(SIZE.contents);
      const seedMs = Date.now() - seedStart;

      const cfg = { scanBatch: 1000, lookbackMs: 60_000 };
      const start = Date.now();
      let scanned = 0;
      let ticks = 0;
      for (;;) {
        const r = await scanContents({ db: t.db, clock: w.clock, config: cfg });
        if (r.scanned === 0) break;
        scanned += r.scanned;
        ticks++;
      }
      const scanMs = Date.now() - start;
      const features = (await t.db.select({ n: count() }).from(contentFeatures))[0]!.n;
      expect(scanned).toBe(SIZE.contents + 1); // 模板内容也在扫描范围
      expect(features).toBe(SIZE.contents + 1);
      const idleStart = Date.now();
      expect((await scanContents({ db: t.db, clock: w.clock, config: cfg })).scanned).toBe(0);
      report({ drill: "scan", contents: scanned, ticks, seed_ms: seedMs, scan_ms: scanMs, per_sec: Math.round((scanned / scanMs) * 1000), idle_tick_ms: Date.now() - idleStart });

      // readMany：5,000 个主体，查询次数为常数
      const ids = ((await t.db.execute(sql`SELECT content_id AS id FROM contents ORDER BY content_id LIMIT ${SIZE.readMany}`))[0] as unknown as Array<{ id: bigint | string }>).map((r) => BigInt(r.id));
      const reader = (c: QueryCounter) => createReader({ db: createDb(t.pool, { logger: c }), enabled: new Set(DEFAULT_ENABLED_CAPABILITIES) });
      const readActor: SignalActor = { actor: "service:drill", capabilities: new Set([CAP_SEGMENT_READ]), brandScope: "all" };
      const small = new QueryCounter();
      await reader(small).readMany(readActor, ids.slice(0, 10).map((id) => content(id)), "text.title_normalized");
      const big = new QueryCounter();
      const readStart = Date.now();
      const got = await reader(big).readMany(readActor, ids.map((id) => content(id)), "text.title_normalized");
      const readMs = Date.now() - readStart;
      expect(got.size).toBe(ids.length);
      expect([...got.values()].every((v) => v.state === "valid")).toBe(true);
      expect(big.count).toBe(small.count); // 查询次数与主体数无关
      report({ drill: "readMany", subjects: ids.length, ms: readMs, queries: big.count, queries_for_10: small.count });
    },
    WHOLE_TEST_MS,
  );

  it(
    "任务领取吞吐（纯 claim）与评分任务端到端执行吞吐（FakeMatcher）",
    async () => {
      const w = await createWorld(t);
      // 批量造 pending 任务：只测领取；params 不会被执行
      await t.pool.query("SET SESSION cte_max_recursion_depth = ?", [SIZE.claims + 10]);
      await t.pool.query(
        `INSERT INTO signal_tasks (kind, idempotency_key, params, status, priority, attempt_count, max_attempts, defer_count, created_at, updated_at, expires_at)
         WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ?)
         SELECT 'score_template', UNHEX(SHA2(CONCAT('claim-', n), 256)), JSON_OBJECT('n', n), 'pending', 0, 0, 3, 0, ?, ?, ? FROM seq`,
        [SIZE.claims, w.clock.now(), w.clock.now(), new Date(w.clock.now().getTime() + 365 * 86_400_000)],
      );
      expect((await t.db.select({ n: count() }).from(signalTasks))[0]!.n).toBe(SIZE.claims);
      const q = { db: t.db, clock: w.clock, audit: () => undefined };
      const claimStart = Date.now();
      let claimed = 0;
      for (;;) {
        const batch = await claim(q, { workerId: "drill", leaseMs: 600_000, limit: 50, kinds: ["score_template"] });
        if (batch.length === 0) break;
        claimed += batch.length;
      }
      const claimMs = Date.now() - claimStart;
      expect(claimed).toBe(SIZE.claims);
      report({ drill: "claim", tasks: claimed, limit_per_claim: 50, ms: claimMs, per_sec: Math.round((claimed / claimMs) * 1000) });

      // 端到端：建 runs 个已归档主体 → requestScores → scoreRunner（并发 scoreConcurrency）→ 结果行
      await t.db.delete(signalTasks);
      const subjects = [];
      for (let i = 0; i < SIZE.runs; i++) subjects.push(await makeSubject(t, "archived"));
      const refs = subjects.map((s) => content(s.id));
      const reqStart = Date.now();
      const req = await w.signals.requestScores(actor, w.plan, refs);
      const reqMs = Date.now() - reqStart;
      expect(req.tasks.created).toBe(SIZE.runs);
      const runStart = Date.now();
      await drain(w, SIZE.runs); // 每轮领 scoreConcurrency 个
      const runMs = Date.now() - runStart;
      expect((await t.db.select({ n: count() }).from(signalResults))[0]!.n).toBe(SIZE.runs);
      report({ drill: "score_end_to_end", tasks: SIZE.runs, concurrency: w.signals.config.scoreConcurrency, request_ms: reqMs, run_ms: runMs, per_sec: Math.round((SIZE.runs / runMs) * 1000) });
    },
    WHOLE_TEST_MS,
  );
});
