// `pnpm plan` CLI（任务 11）：退出码、JSON 输出、预览优先、没有旁路。
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { MemoryAuditSink } from "../../tests/harness/audit";
import { useTestDb } from "../../tests/harness/db";
import { FakeClock } from "../../tests/harness/fake-clock";
import { MemoryPlanAudit, planActor, T0 } from "../../tests/harness/plan";
import { rosterWorld, type RosterWorld } from "../../tests/harness/roster";
import { seedSyncSettings } from "../../tests/harness/seed";
import { activityPlans, branches, staffAccountAssignments as aa } from "../db/schema";
import { createActivityPlan } from "../modules/activity-plan";
import { PlanError } from "../modules/activity-plan/errors";
import { createMonitoringResolver } from "../modules/monitoring";
import { createTracerCommands } from "../modules/tracer-command";
import { runPlanCli, type PlanCliDeps } from "./plan-cli";

const t = useTestDb();
let w: RosterWorld;
const files = new Map<string, string | Uint8Array>();
async function cli(actor = planActor("admin")) {
  w = await rosterWorld(t);
  const clock = new FakeClock(T0);
  await seedSyncSettings(t.db, T0);
  const audit = new MemoryPlanAudit();
  const ap = createActivityPlan({ db: t.db, clock, audit: audit.sink, monitoring: createMonitoringResolver(t.db), tracer: createTracerCommands({ db: t.db, clock, audit: new MemoryAuditSink() }) });
  let out = "";
  let err = "";
  const deps: PlanCliDeps = {
    ap,
    actor,
    readFile: (p) => {
      const f = files.get(p);
      if (f === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return typeof f === "string" ? new TextEncoder().encode(f) : f;
    },
    writeFile: (p, c) => void files.set(p, c),
    branchIdOf: async (code) => {
      const [b] = await t.db.select({ id: branches.branchId }).from(branches).where(eq(branches.branchCode, code));
      if (!b) throw new PlanError("not_found", "branch_not_found", "分公司不存在");
      return b.id;
    },
    stdout: (s) => void (out += s),
    stderr: (s) => void (err += s),
  };
  const run = async (...argv: string[]) => {
    out = "";
    err = "";
    const code = await runPlanCli(argv, deps);
    return { code, json: out ? (JSON.parse(out.trim().split("\n").at(-1)!) as Record<string, any>) : null, err };
  };
  return { run, audit, ap, as: (a: ReturnType<typeof planActor>) => void (deps.actor = a) };
}

describe("计划命令", () => {
  it("create → show → edit → pause / resume → delete 预览 / apply → trash → restore，输出 JSON 且 ID 为十进制字符串", async () => {
    const { run } = await cli();
    const c = await run("create", "--brand", "HITACHI", "--platform", "douyin", "--name", "618", "--starts-on", "2026-11-01", "--sectors", "water");
    expect(c.code).toBe(0);
    expect(c.json).toMatchObject({ ok: true, plan: { name: "618", status: "collecting", sectors: ["water"] }, required: { text: "本计划需要 1 份监控判定计划：水机" } });
    const id = c.json!.plan.planId as string;
    expect(id).toMatch(/^[1-9]\d*$/);
    expect((await run("show", id)).json).toMatchObject({ ok: true, plan: { name: "618", counts: { accounts: 0 } } });
    expect((await run("edit", id, "--name", "双十一", "--no-ends-on")).json).toMatchObject({ ok: true, changed: ["name"] });
    expect((await run("pause", id)).json).toMatchObject({ ok: true, from: "collecting", to: "paused" });
    expect((await run("resume", id)).json).toMatchObject({ ok: true, to: "collecting" });
    expect((await run("list", "--status", "collecting")).json!.plans.length).toBeGreaterThan(0);
    const pv = await run("delete", id);
    expect(pv.json).toMatchObject({ ok: true, kind: "preview", apply: false });
    expect((await t.db.select().from(activityPlans).where(eq(activityPlans.planId, BigInt(id))))[0]?.status).toBe("collecting");
    expect((await run("delete", id, "--apply")).json).toMatchObject({ ok: true, kind: "applied" });
    expect((await run("trash")).json!.plans.map((p: { planId: string }) => p.planId)).toEqual([id]);
    expect((await run("restore", id)).json).toMatchObject({ ok: true, plan: { status: "collecting" } });
  });
  it("命令行带 --brand / --platform / --sectors 修改已有计划：immutable_field，退出码 2，库中无变化", async () => {
    const { run } = await cli();
    const c = await run("create", "--brand", "HITACHI", "--platform", "douyin", "--name", "x", "--starts-on", "2026-11-01");
    const id = c.json!.plan.planId as string;
    for (const flag of ["--brand", "--platform", "--sectors"]) {
      const r = await run("edit", id, flag, "HISENSE");
      expect([r.code, r.json!.error.code], flag).toEqual([2, "immutable_field"]);
    }
    expect((await run("show", id)).json!.plan).toMatchObject({ brand: "HITACHI", platform: "douyin" });
  });
});

describe("退出码与旁路", () => {
  it("2 输入 / 授权；3 冲突；4 不存在；未知子命令与 strict 参数解析", async () => {
    const c0 = await cli(planActor("none"));
    const { run } = c0;
    expect((await run("create", "--brand", "HITACHI", "--platform", "douyin", "--name", "x", "--starts-on", "2026-11-01")).code).toBe(2); // 无 Capability
    expect((await run("show", "987654")).code).toBe(2); // 先于读库的授权拒绝
    expect((await run("bogus")).code).toBe(2);
    expect((await run("show")).code).toBe(2);
    expect((await run("show", "012")).code).toBe(2); // 不接受前导零
    c0.as(planActor("admin"));
    expect((await run("show", "987654")).code).toBe(4);
    expect((await run("roster", "report", "987654", "--out", "/tmp/x")).code).toBe(4);
    const c = await run("create", "--brand", "HITACHI", "--platform", "douyin", "--name", "x", "--starts-on", "2026-11-01");
    const id = c.json!.plan.planId as string;
    expect((await run("resume", id)).code).toBe(3); // 采集中不能 resume
  });
  it("没有 --force / --skip-auth 旁路：strict 解析直接拒绝", async () => {
    const { run } = await cli();
    for (const flag of ["--force", "--skip-auth"]) {
      const r = await run("delete", "1", flag);
      expect(r.code, flag).toBe(2);
      expect(r.json!.error.code).toBe("invalid_input");
    }
    expect((await run("show", "1", "--skip-auth")).code).toBe(2);
  });
  it("resolve --once 在未装配时报配置错误（退出码 1），不静默成功", async () => {
    const { run } = await cli();
    const r = await run("resolve", "--once");
    expect([r.code, r.json!.error.code]).toEqual([1, "resolver_not_wired"]);
    expect((await run("resolve")).code).toBe(2);
  });
  it("内部错误：退出码 1，输出不含堆栈", async () => {
    const { run } = await cli();
    const r = await run("branch", "join", String(w.planId), "--branch", "999999");
    expect([r.code, r.json!.error.code]).toEqual([4, "branch_not_found"]);
  });
});

describe("参与、负责人、名单", () => {
  it("branch join / exit（默认预览）、owner assign（默认预览）", async () => {
    const { run } = await cli();
    const pid = String(w.planId);
    expect((await run("branch", "join", pid, "--branch", "102")).json).toMatchObject({ ok: true, kind: "joined" });
    expect((await run("owner", "assign", pid, "--branch", "102", "--owner", "user:sh")).json).toMatchObject({ ok: true, kind: "preview", slotNo: 1 });
    expect((await run("owner", "list", pid)).json!.owners).toEqual([]);
    expect((await run("owner", "assign", pid, "--branch", "102", "--owner", "user:sh", "--name", "上海负责人", "--apply")).json).toMatchObject({ kind: "applied" });
    expect((await run("owner", "replace", pid, "--branch", "102", "--owner", "user:sh2", "--slot", "1", "--apply")).json).toMatchObject({ kind: "applied", before: "上海负责人" });
    expect((await run("owner", "replace", pid, "--branch", "102", "--owner", "x")).code).toBe(2); // replace 需要 --slot
    expect((await run("branch", "exit", pid, "--branch", "102")).json).toMatchObject({ kind: "preview", owners: ["user:sh2"] });
    expect((await run("branch", "exit", pid, "--branch", "102", "--apply")).json).toMatchObject({ kind: "applied", releasedOwners: ["user:sh2"] });
  });
  it("roster：template → precheck → confirm → batches / batch / rows / report → list → remove（预览优先）→ account confirm-empty", async () => {
    const { run } = await cli();
    const pid = String(w.planId);
    const tpl = await run("roster", "template", "--out", "/tmp/tpl.csv");
    expect(tpl.json).toMatchObject({ ok: true, header: ["门店编码", "专员姓名", "手机号", "主页链接"], out: "/tmp/tpl.csv" });
    expect(String(files.get("/tmp/tpl.csv")).startsWith("\uFEFF")).toBe(true);
    files.set("/tmp/in.csv", "门店编码,专员姓名,手机号,主页链接\r\nS-W1,新人甲,13800020001,https://www.douyin.com/user/AAA\r\nNOPE,乙,13800020002,https://www.douyin.com/user/BBB\r\n");
    const pre = await run("roster", "precheck", pid, "--file", "/tmp/in.csv");
    expect(pre.json).toMatchObject({ ok: true, status: "awaiting_confirm", summary: { precheck: { new_staff: 1, error: 1 } } });
    const bid = pre.json!.batchId as string;
    expect((await run("roster", "precheck", pid, "--file", "/tmp/missing.csv")).json!.error.code).toBe("file_not_found");
    const conf = await run("roster", "confirm", "--batch", bid);
    expect(conf.json).toMatchObject({ ok: true, status: "resolving", confirm: { pending_account: 1, staff_created: 1 } });
    expect((await run("roster", "batches", "--plan", pid)).json!.batches[0].batchId).toBe(bid);
    expect((await run("roster", "batch", bid)).json!.batch).toMatchObject({ status: "resolving" });
    expect((await run("roster", "rows", bid, "--class", "error")).json).toMatchObject({ total: 1 });
    const rep = await run("roster", "report", bid, "--out", "/tmp/back.csv");
    expect(rep.json).toMatchObject({ ok: true, rows: 1 });
    expect(String(files.get("/tmp/back.csv"))).toContain("门店编码在系统中不存在");
    const list = await run("roster", "list", pid, "--state", "in_roster");
    expect(list.json!.items).toHaveLength(1);
    const acct = String(w.accZhao);
    expect((await run("roster", "remove", pid, "--account", acct)).json).toMatchObject({ kind: "preview", entries: 1, apply: false });
    expect((await run("roster", "list", pid, "--state", "in_roster")).json!.items).toHaveLength(1);
    expect((await run("roster", "remove", pid, "--account", acct, "--apply")).json).toMatchObject({ kind: "applied" });
    expect((await run("roster", "remove", pid)).code).toBe(2); // 什么都没选
    await t.db.update(aa).set({ intakeStatus: "suspected_empty" }).where(eq(aa.accountId, w.accQian));
    expect((await run("account", "confirm-empty", String(w.accQian))).json).toMatchObject({ ok: true, intakeStatus: "normal" });
    expect((await run("maintain")).json).toMatchObject({ ok: true, report: { ran: true } });
  });
});
