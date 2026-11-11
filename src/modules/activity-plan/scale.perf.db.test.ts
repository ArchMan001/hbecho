// 规模演练（design §12.1）：2,000 行名单的预检 / 确认 / 解析（fixture transport，离线），以及 1,200 账号的引用重算。
// 数字记录进 design §12.1；断言只设宽松上限，防止数量级退化（不是性能合同）。
import { performance } from "node:perf_hooks";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { MemoryAuditSink } from "../../../tests/harness/audit";
import { bytesOf } from "../../../tests/harness/decode-helpers";
import { useTestDb } from "../../../tests/harness/db";
import { FakeClock } from "../../../tests/harness/fake-clock";
import { FakeObjectStore } from "../../../tests/harness/fake-oss";
import { FixtureTransport } from "../../../tests/harness/fixture-transport";
import { loadFixtureBytes } from "../../../tests/harness/fixtures";
import { planActor, T0 } from "../../../tests/harness/plan";
import { rosterWorld } from "../../../tests/harness/roster";
import { seedSyncSettings } from "../../../tests/harness/seed";
import { activityPlanRoster, importRowResults, staffAccountAssignments as aa, syncTasks } from "../../db/schema";
import { runTracerRoot } from "../orchestrator";
import { EVENTS, reconcileAccounts } from "../plan-references";
import { RawCaptureGateway } from "../raw-capture";
import { createTracerCommands } from "../tracer-command";
import { ROSTER_HEADER } from "./constants";
import { confirm } from "./roster/confirm";
import { createRosterFinalizer } from "./roster/finalize";
import { precheck } from "./roster/precheck";
import { createRosterResolver } from "./roster/resolver";

const t = useTestDb();
const ms = (t0: number) => Math.round(performance.now() - t0);
const mb = () => Math.round(process.memoryUsage().rss / 1048576);

describe("2,000 行名单：预检 / 确认 / 解析", () => {
  it(
    "耗时与内存记录在案",
    async () => {
      const w = await rosterWorld(t);
      const clock = new FakeClock(T0);
      await seedSyncSettings(t.db, T0);
      const store = new FakeObjectStore(clock);
      const transport = new FixtureTransport();
      const gateway = new RawCaptureGateway({ db: t.db, store, transport, clock, location: { providerCode: "aliyun-oss", region: "cn-beijing", bucket: "hbecho-test" } });
      const base = new TextDecoder().decode(loadFixtureBytes("raw3.douyin.media_user_info"));
      transport.register({ path: "/openapi/v1/media_user_info", query: { async: "false" } }, (req) => {
        const url = (JSON.parse(new TextDecoder().decode(req.body!)) as { url: string }).url;
        return { httpStatus: 200, body: bytesOf(base.replaceAll("HITACHI1", `U${url.split("/").pop()}`)) };
      });
      // 1,000 个已存在的专员（不需要新建）+ 1,000 个将新建
      const vals = Array.from({ length: 1000 }, (_, i) => `(${w.stores.sW1}, '老${i}', '135${String(10000 + i).padStart(8, "0")}', 'active', NOW(6), NOW(6))`);
      await t.db.execute(`INSERT INTO media_staff (store_id, staff_name, phone, status, created_at, updated_at) VALUES ${vals.join(",")}` as never);
      const lines: string[] = [];
      for (let i = 0; i < 1000; i++) lines.push(`S-W1,新${i},136${String(10000 + i).padStart(8, "0")},https://www.douyin.com/user/N${i}`);
      for (let i = 0; i < 1000; i++) lines.push(`S-W1,老${i},135${String(10000 + i).padStart(8, "0")},https://www.douyin.com/user/E${i}`);
      const bytes = new TextEncoder().encode([ROSTER_HEADER.join(","), ...lines].join("\r\n") + "\r\n");
      const audit = new MemoryAuditSink();
      const tracer = createTracerCommands({ db: t.db, clock, audit });
      const deps = { db: t.db, clock, audit: w.audit.sink, tracer };
      const hq = planActor("hq");
      const out: Record<string, number> = { rss_before_mb: mb() };

      let t0 = performance.now();
      const pre = await precheck(deps, { planId: w.planId, fileName: "2000.csv", bytes }, hq);
      out.precheck_ms = ms(t0);
      t0 = performance.now();
      const conf = await confirm(deps, pre.batchId, hq);
      out.confirm_ms = ms(t0);
      expect(conf.confirm.pending_account).toBe(2000);
      const finalize = createRosterFinalizer({ db: t.db, clock, supplement: async () => ({ kind: "created" }) });
      const resolver = createRosterResolver({ db: t.db, clock, audit: w.audit.sink, finalize, concurrency: 2, runRoot: (id) => runTracerRoot({ db: t.db, clock, gateway, workerId: "w1" }, id) });
      t0 = performance.now();
      let ticks = 0;
      for (let settled = 0; settled < 2000 && ticks < 100; ticks++) {
        const r = await resolver.runOnce({ limit: 100 });
        settled += r.settled;
        clock.advance(120_000); // 让异常退出的根任务租约过期（FakeClock 不会自己走）
        expect(r.failed).toEqual([]); // 并发解析不应出现未处理的事务错误（死锁已在 intake 里重试）
      }
      out.resolve_ms = ms(t0);
      out.resolve_ticks = ticks;
      out.rss_after_mb = mb();
      const rows = await t.db.select().from(importRowResults).where(eq(importRowResults.importBatchId, BigInt(pre.batchId)));
      expect(rows.filter((r) => r.outcome === "imported")).toHaveLength(2000);
      expect((await t.db.select().from(syncTasks)).filter((x) => x.requestedAction === "fetch_content_list")).toHaveLength(0); // 新账号只采主页
      expect((await t.db.select().from(activityPlanRoster).where(eq(activityPlanRoster.planId, w.planId))).length).toBe(2 + 2000);
      expect(out.precheck_ms! + out.confirm_ms!).toBeLessThan(60_000);
      expect(out.resolve_ms!).toBeLessThan(240_000);
      process.stdout.write(`\n[scale] ${JSON.stringify(out)}\n`);
    },
    600_000,
  );
});

describe("1,200 账号的引用重算", () => {
  it(
    "一次移出 / 删除事件重算 1,200 个账号",
    async () => {
      const w = await rosterWorld(t);
      const acc = Array.from({ length: 1200 }, (_, i) => `(${i + 100000}, ${1}, 'active', NOW(6), NOW(6), NOW(6), NOW(6))`);
      await t.db.execute(`INSERT INTO external_accounts (account_id, platform_id, status, first_seen_at, last_seen_at, created_at, updated_at) VALUES ${acc.map((a) => a.replace(", 'active', NOW(6), NOW(6), NOW(6), NOW(6)", ", 'active', NOW(6), NOW(6), NOW(6), NOW(6)")).join(",")}` as never);
      // 每个账号配一个专员（D-69 一专员一平台一账号），再各入名单
      const staffVals = Array.from({ length: 1200 }, (_, i) => `(${w.stores.sW1}, 'p${i}', '134${String(10000 + i).padStart(8, "0")}', 'active', NOW(6), NOW(6))`);
      await t.db.execute(`INSERT INTO media_staff (store_id, staff_name, phone, status, created_at, updated_at) VALUES ${staffVals.join(",")}` as never);
      const [staffRows] = await t.pool.query("SELECT staff_id FROM media_staff WHERE phone LIKE '134%' ORDER BY staff_id");
      const sids = (staffRows as Array<{ staff_id: string }>).map((r) => r.staff_id);
      const crypto = await import("node:crypto");
      const sha = (s: string) => `X'${crypto.createHash("sha256").update(s).digest("hex")}'`;
      const assignVals = sids.map((sid, i) => `('staff', ${sid}, ${i + 100000}, 1, 'u${i}', ${sha(`u${i}`)}, 'u${i}', ${sha(`u${i}`)}, 'normal', NOW(6), NOW(6))`);
      await t.db.execute(`INSERT INTO staff_account_assignments (watch_type, staff_id, account_id, platform_id, current_home_locator, current_home_locator_sha256, resolved_home_url, resolved_home_url_sha256, intake_status, created_at, updated_at) VALUES ${assignVals.join(",")}` as never);
      const rosterVals = sids.map((sid, i) => `(${w.planId}, 1, ${i + 100000}, ${w.bj}, ${w.stores.sW1}, ${sid}, 'removed', NOW(6), 'x', NOW(6), 'x', 'manual_remove', NOW(6))`);
      await t.db.execute(`INSERT INTO activity_plan_roster (plan_id, platform_id, account_id, branch_id, store_id, staff_id, entry_state, added_at, added_by_actor, removed_at, removed_by_actor, removed_reason, updated_at) VALUES ${rosterVals.join(",")}` as never);
      const ids = Array.from({ length: 1200 }, (_, i) => BigInt(i + 100000));
      const t0 = performance.now();
      const report = await t.db.transaction((tx) => reconcileAccounts(tx, ids, { ...EVENTS.removed, now: T0 }));
      const elapsed = ms(t0);
      expect(report.closed).toHaveLength(1200);
      expect((await t.db.select().from(aa).where(eq(aa.monitoringEnabled, false))).length).toBe(1200);
      expect(elapsed).toBeLessThan(30_000);
      process.stdout.write(`\n[scale] ${JSON.stringify({ reconcile_1200_ms: elapsed, events: report.events.length })}\n`);
    },
    120_000,
  );
});
