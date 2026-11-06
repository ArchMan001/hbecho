// 任务 2：CLI `pnpm tracer submit|status|cancel`（design §14）。只调用 Module，不直接写库；输出 JSON；退出码
// 0 成功 / 2 校验、授权、不支持 / 3 幂等冲突 / 4 不存在或已过期 / 1 其他错误。
import { describe, expect, it } from "vitest";
import { serviceActor } from "../../tests/harness/actors";
import { MemoryAuditSink } from "../../tests/harness/audit";
import { useTestDb } from "../../tests/harness/db";
import { FakeClock } from "../../tests/harness/fake-clock";
import { seedOrg, seedSyncSettings, type OrgSeed } from "../../tests/harness/seed";
import { createTracerCommands, createTracerStatusQuery, type ActorContext } from "../modules/tracer-command";
import { runCli } from "./cli";

const START = new Date("2026-11-04T08:00:00.000Z");
const YEAR_MS = 365 * 24 * 3600 * 1000;
const t = useTestDb();

async function setup(actor: ActorContext = serviceActor()) {
  const clock = new FakeClock(START);
  const org = await seedOrg(t.db, clock.now());
  await seedSyncSettings(t.db, clock.now());
  const audit = new MemoryAuditSink();
  const commands = createTracerCommands({ db: t.db, clock, audit });
  const status = createTracerStatusQuery({ db: t.db, clock });
  const run = async (argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(argv, { commands, status, actor, stdout: (s) => out.push(s), stderr: (s) => err.push(s) });
    return { code, out: out.join(""), err: err.join(""), json: out.length ? (JSON.parse(out.join("")) as Record<string, unknown>) : null };
  };
  const submitArgs = (org: OrgSeed, over: string[] = []) => [
    "submit", "--platform", "douyin", "--staff", org.staffA.toString(),
    "--locator", "9- 长按复制 https://v.douyin.com/MPOAlEqWpec/ 1@3.com :1pm", "--key", "cli-key-1", ...over,
  ];
  return { clock, org, run, submitArgs };
}

describe("submit", () => {
  it("接受 → 退出码 0，输出十进制字符串 root_task_id；重复提交返回同一 root 且 deduplicated=true", async () => {
    const { run, submitArgs, org } = await setup();
    const a = await run(submitArgs(org));
    expect(a.code).toBe(0);
    expect(a.json).toMatchObject({ deduplicated: false, reused_active_task: false });
    expect(a.json!.root_task_id).toMatch(/^[1-9]\d*$/);
    const b = await run(submitArgs(org));
    expect(b.code).toBe(0);
    expect(b.json).toMatchObject({ root_task_id: a.json!.root_task_id, deduplicated: true });
  });

  it("--limit 传给命令；不合法的 limit 是校验错误（2）", async () => {
    const { run, submitArgs, org } = await setup();
    expect((await run(submitArgs(org, ["--limit", "7"]))).code).toBe(0);
    const bad = await run(submitArgs(org, ["--limit", "abc", "--key", "k2"].slice(0, 2)));
    expect(bad.code).toBe(2);
    expect(bad.json).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });

  it("幂等冲突 → 3；缺 Capability / 越权 / 不支持 → 2", async () => {
    const { run, submitArgs, org } = await setup();
    await run(submitArgs(org));
    const conflict = await run(["submit", "--platform", "douyin", "--staff", org.staffA.toString(), "--locator", "https://other.example/", "--key", "cli-key-1"]);
    expect(conflict.code).toBe(3);
    expect(conflict.json).toMatchObject({ ok: false, error: { code: "idempotency_conflict" } });

    const unsupported = await run(["submit", "--platform", "wechat_channels", "--staff", org.staffA.toString(), "--locator", "x", "--key", "k9"]);
    expect(unsupported.code).toBe(2);
    expect(unsupported.json).toMatchObject({ error: { code: "unsupported_capability" } });
  });

  it("缺 Capability → 2", async () => {
    const { run, submitArgs, org } = await setup(serviceActor({ capabilities: new Set() }));
    const r = await run(submitArgs(org));
    expect(r.code).toBe(2);
    expect(r.json).toMatchObject({ error: { code: "forbidden" } });
  });

  it("缺必填参数 / 未知参数 / 未知子命令 → 2，并给出用法，不执行任何命令", async () => {
    const { run, org } = await setup();
    for (const argv of [
      ["submit", "--platform", "douyin"],
      ["submit", "--platform", "douyin", "--staff", org.staffA.toString(), "--locator", "x", "--key", "k", "--bogus", "1"],
      ["frobnicate"],
      [],
    ]) {
      const r = await run(argv);
      expect(r.code, argv.join(" ")).toBe(2);
      expect(r.json).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    }
  });

  it("输出里不含原始 locator", async () => {
    const { run, submitArgs, org } = await setup();
    const r = await run(submitArgs(org));
    expect(r.out + r.err).not.toContain("douyin.com");
  });
});

describe("status / cancel", () => {
  it("status：found → 0 并输出状态；未知 → 4；过期 → 4", async () => {
    const { run, submitArgs, org, clock } = await setup();
    const { json } = await run(submitArgs(org));
    const id = json!.root_task_id as string;

    const ok = await run(["status", id]);
    expect(ok.code).toBe(0);
    expect(ok.json).toMatchObject({ kind: "found", rootTaskId: id, state: "accepted" });

    const missing = await run(["status", "999999"]);
    expect(missing.code).toBe(4);
    expect(missing.json).toEqual({ kind: "not_found" });

    clock.advance(YEAR_MS);
    const expired = await run(["status", id]);
    expect(expired.code).toBe(4);
    expect(expired.json).toEqual({ kind: "expired" });
  });

  it("status 的 id 不是数字 → 2；cancel：成功 → 0 并显示 cancelled；未知 → 4", async () => {
    const { run, submitArgs, org } = await setup();
    const { json } = await run(submitArgs(org));
    expect((await run(["status", "abc"])).code).toBe(2);
    const c = await run(["cancel", json!.root_task_id as string]);
    expect(c.code).toBe(0);
    expect(c.json).toMatchObject({ kind: "found", state: "cancelled" });
    const miss = await run(["cancel", "424242"]);
    expect(miss.code).toBe(4);
    expect(miss.json).toMatchObject({ ok: false, error: { code: "not_found" } });
  });
});

describe("意外错误", () => {
  it("不是 TracerError 的异常 → 退出码 1，stdout 仍是 JSON，stderr 不泄露堆栈", async () => {
    const { org } = await setup();
    const out: string[] = [];
    const err: string[] = [];
    const boom = { submit: async () => { throw new Error("db exploded at /secret/path"); }, cancel: async () => { throw new Error("x"); } };
    const code = await runCli(
      ["submit", "--platform", "douyin", "--staff", org.staffA.toString(), "--locator", "x", "--key", "k"],
      { commands: boom as never, status: { get: async () => ({ kind: "not_found" }) } as never, actor: serviceActor(), stdout: (s) => out.push(s), stderr: (s) => err.push(s) },
    );
    expect(code).toBe(1);
    expect(JSON.parse(out.join(""))).toMatchObject({ ok: false, error: { code: "internal_error" } });
    expect(err.join("")).toContain("internal_error");
    expect(err.join("")).not.toContain("at /");
  });
});
