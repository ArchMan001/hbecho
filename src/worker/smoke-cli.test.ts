// smoke CLI：门槛先于一切副作用；未批准时 execute 永远不会被调用。
import { describe, expect, it } from "vitest";
import { jcsSha256Hex } from "../modules/canonical-json";
import { SMOKE_SWITCH_ENV, SMOKE_SWITCH_VALUE } from "../modules/smoke";
import { runSmokeCli, type SmokeCliDeps } from "./smoke-cli";

const NOW = new Date("2026-11-04T12:00:00.000Z");
const plan = {
  schema_version: "data-foundation-smoke-plan.v1",
  environment: "production",
  allowlist: [{ platform: "douyin", action: "media_user_info", mode: "synchronous", locator: "https://v.douyin.com/MPOAlEqWpec/" }],
  budget: { max_calls: 1, max_polls: 0, max_points: 10 },
  deadline_ms: 60_000,
};
const approval = {
  schema_version: "data-foundation-smoke-approval.v1",
  approved_by: "liuxuekui",
  approved_at: "2026-11-04T11:00:00.000Z",
  expires_at: "2026-11-04T20:00:00.000Z",
  plan_sha256: jcsSha256Hex(plan),
  reason: "测试",
};

function harness(over: Partial<SmokeCliDeps> = {}, files: Record<string, unknown> = { "plan.json": plan, "approval.json": approval }) {
  const out: string[] = [];
  const err: string[] = [];
  const executed: unknown[] = [];
  const reads: string[] = [];
  const deps: SmokeCliDeps = {
    readJson: async (p) => {
      reads.push(p);
      if (!(p in files)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return files[p];
    },
    env: { [SMOKE_SWITCH_ENV]: SMOKE_SWITCH_VALUE },
    now: () => NOW,
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    execute: async (auth) => {
      executed.push(auth);
      throw new Error("不应被调用");
    },
    ...over,
  };
  return { deps, out, err, executed, reads, json: () => JSON.parse(out.join("")) as Record<string, unknown> };
}

describe("smoke preview", () => {
  it("只校验计划并打印预算预览：不要审批、不要开关、不调用 execute", async () => {
    const h = harness({ env: {} });
    expect(await runSmokeCli(["preview", "--plan", "plan.json"], h.deps)).toBe(0);
    expect(h.json()).toMatchObject({ ok: true, preview: { nominalPoints: 10, nominalYuan: 0.2 } });
    expect(h.executed).toHaveLength(0);
    expect(h.reads).toEqual(["plan.json"]);
    expect(h.out.join("")).not.toContain("MPOAlEqWpec");
  });
  it("不合法的计划（异步列表）→ 退出码 2", async () => {
    const bad = { ...plan, allowlist: [{ ...plan.allowlist[0], action: "user_video_list", mode: "asynchronous" }] };
    const h = harness({}, { "plan.json": bad });
    expect(await runSmokeCli(["preview", "--plan", "plan.json"], h.deps)).toBe(2);
    expect(h.json()).toMatchObject({ ok: false, error: { code: "allowlist_tuple_unavailable" } });
  });
});

describe("smoke run：没有批准就没有执行", () => {
  it("开关未设置：退出码 2，连审批文件都不读，execute 0 次", async () => {
    const h = harness({ env: {} });
    expect(await runSmokeCli(["run", "--plan", "plan.json", "--approval", "approval.json"], h.deps)).toBe(2);
    expect(h.json()).toMatchObject({ error: { code: "switch_off" } });
    expect(h.reads).toEqual([]);
    expect(h.executed).toHaveLength(0);
  });
  it("开关值不对 / 没给审批 / 审批过期 / 审批对应别的计划：全部退出码 2，execute 0 次", async () => {
    const cases: Array<[Partial<SmokeCliDeps>, string[], Record<string, unknown>, string]> = [
      [{ env: { [SMOKE_SWITCH_ENV]: "1" } }, ["run", "--plan", "plan.json", "--approval", "approval.json"], { "plan.json": plan, "approval.json": approval }, "switch_off"],
      [{}, ["run", "--plan", "plan.json"], { "plan.json": plan }, "approval_missing"],
      [{}, ["run", "--plan", "plan.json", "--approval", "approval.json"], { "plan.json": plan, "approval.json": { ...approval, expires_at: "2026-11-04T11:30:00.000Z" } }, "approval_expired"],
      [{}, ["run", "--plan", "plan.json", "--approval", "approval.json"], { "plan.json": { ...plan, deadline_ms: 61_000 }, "approval.json": approval }, "approval_plan_mismatch"],
    ];
    for (const [over, argv, files, code] of cases) {
      const h = harness(over, files);
      expect(await runSmokeCli(argv, h.deps)).toBe(2);
      expect(h.json()).toMatchObject({ ok: false, error: { code } });
      expect(h.executed).toHaveLength(0);
    }
  });
  it("全部门槛通过但没有接线真实执行器：退出码 5，打印预览，仍然没有任何调用", async () => {
    const h = harness();
    delete h.deps.execute;
    expect(await runSmokeCli(["run", "--plan", "plan.json", "--approval", "approval.json"], h.deps)).toBe(5);
    expect(h.json()).toMatchObject({ ok: false, authorized: true, error: { code: "executor_not_wired" }, preview: { nominalPoints: 10 } });
  });
  it("全部门槛通过且有执行器：只调用一次，把摘要原样输出", async () => {
    const summary = { totals: { calls: 1 } };
    const calls: unknown[] = [];
    const h = harness({
      execute: async (a) => {
        calls.push(a.approvedBy);
        return summary as never;
      },
    });
    expect(await runSmokeCli(["run", "--plan", "plan.json", "--approval", "approval.json"], h.deps)).toBe(0);
    expect(calls).toEqual(["liuxuekui"]);
    expect(h.json()).toEqual({ ok: true, summary });
  });
  it("未知子命令 / 缺 --plan / 未知参数 → 用法 + 退出码 2；意外错误不泄露堆栈", async () => {
    for (const argv of [[], ["bogus"], ["run"], ["run", "--plan", "p.json", "--nope"]]) {
      const h = harness();
      expect(await runSmokeCli(argv, h.deps)).toBe(2);
      expect(h.executed).toHaveLength(0);
    }
    const h = harness({ readJson: async () => { throw new Error("读取失败 /secret/path"); } });
    expect(await runSmokeCli(["preview", "--plan", "x"], h.deps)).toBe(1);
    expect(h.out.join("")).not.toContain("/secret/path");
  });
});
