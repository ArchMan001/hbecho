// d-rule-engine 任务 11：CLI 级测试——JP-20 / acceptance T1–T6。design §9 的每条命令都有成功、输入错误、授权错误三类断言。
// 通过真实的 runJudgementCli + 真实 Module（FakeSignals / FakeDemand 代替 C / A）；不连任何网络。
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { judgementPlans, judgementPlanVersions, judgementRuns, runContents, runParticipants } from "../db/schema";
import { useTestDb } from "../../tests/harness/db";
import { addContent, addListTask, judgementEnv, judgementWorld, userCtx, type JudgementEnv, type JudgementWorld } from "../../tests/harness/judgement";
import type { AuthContext } from "../modules/access-control";
import { runJudgementCli } from "./judgement-cli";
const t = useTestDb();
const day = (d: number) => new Date(Date.UTC(2026, 10, d, 4));
const BASE = { window: { from: "2026-11-01", to: "2026-11-30" }, kinds: ["video"], layer1: { text: [{ fields: ["title"], mode: "any", keywords: ["海信"] }], quantity: { n: 2 } } };
const COVER = { ...BASE, layer2: { abilities: [{ abilityId: "cover1", kind: "whole_image", target: "cover", threshold: "6.5" }] } };

interface Out { code: number; json: any; raw: string; err: string }
function harness(e: JudgementEnv, files: Record<string, string | Uint8Array> = {}, over: { serve?: () => Promise<void> } = {}) {
  return async (args: string[], ctx: AuthContext = e.creator): Promise<Out> => {
    let raw = "";
    let err = "";
    const code = await runJudgementCli(args, {
      j: { plans: e.plans, versions: e.versions, runs: e.runs, outcomes: e.outcomes, claim: e.claim, authz: e.authz },
      ctx,
      readFile: (p) => {
        const f = files[p];
        if (f === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return typeof f === "string" ? new TextEncoder().encode(f) : f;
      },
      ...(over.serve ? { serve: over.serve } : {}),
      stdout: (s) => void (raw += s),
      stderr: (s) => void (err += s),
    });
    expect(raw.endsWith("\n") && raw.trim().split("\n").length === 1, `输出必须是一行 JSON：${raw}`).toBe(true);
    return { code, json: JSON.parse(raw), raw, err };
  };
}
async function setup(over: Parameters<typeof judgementEnv>[2] = {}, files: Record<string, string | Uint8Array> = {}) {
  const w = await judgementWorld(t);
  const e = judgementEnv(t, w, over);
  return { w, e, run: harness(e, files) };
}
async function createPlan(run: ReturnType<typeof harness>, w: JudgementWorld): Promise<string> {
  const r = await run(["plan", "create", "--activity-plan", String(w.planId), "--alias", "计划 A"]);
  expect(r.code).toBe(0);
  return r.json.planId;
}
async function content(w: JudgementWorld, e: JudgementEnv, id: string, like = 1) {
  const c = await addContent(t.db, { accountId: w.accZhao, platformContentId: id, kind: "video", like, publishedAt: day(5) });
  e.fake.setValue("text.title_normalized", c.contentId, { state: "valid", usable: true, value: "海信新品", normalizerVersion: 1 });
  return c.contentId;
}
const tableCounts = async () => ({
  plans: (await t.db.select().from(judgementPlans)).length,
  versions: (await t.db.select().from(judgementPlanVersions)).length,
  runs: (await t.db.select().from(judgementRuns)).length,
  participants: (await t.db.select().from(runParticipants)).length,
  contents: (await t.db.select().from(runContents)).length,
});
const snapshot = async () => JSON.stringify({ c: await tableCounts(), v: await t.db.select().from(judgementPlanVersions), r: (await t.db.select().from(judgementRuns)).map((r) => [r.runId, r.status]) }, (_k, x: unknown) => (typeof x === "bigint" ? String(x) : x));

describe("入口与退出码（T4 / T5）", () => {
  it("未知命令、缺子命令、未知 / 禁用的参数（--force、--skip-auth）、非法 ID：退出码 2，不写库", async () => {
    const { w, run } = await setup();
    await createPlan(run, w);
    const before = await snapshot();
    for (const args of [[], ["bogus"], ["plan"], ["plan", "bogus"], ["plan", "show", "1", "--force"], ["plan", "list", "--skip-auth"], ["plan", "show", "0"], ["plan", "show", "abc"], ["plan", "show", "01"], ["plan", "show"], ["circle", "1", "2"], ["run", "show", "-1"]]) {
      const r = await run(args);
      expect(r, args.join(" ")).toMatchObject({ code: 2, json: { ok: false, error: { code: "invalid_input" } } });
    }
    expect(await snapshot()).toBe(before);
  });
  it("退出码映射：授权 2 / 冲突 3 / 不存在 4 / 内部错误 1（与 plan-cli 一致）", async () => {
    const { w, e, run } = await setup();
    const planId = await createPlan(run, w);
    expect((await run(["plan", "archive", planId], e.other)).code).toBe(2); // 不是活动计划创建者
    expect((await run(["plan", "show", "999999"])).code).toBe(4);
    expect((await run(["plan", "archive", planId])).code).toBe(0);
    expect((await run(["circle", planId])).code).toBe(3); // plan_archived
    // 非 JudgementError：退出码 1、输出通用错误、不泄露细节，并交给 onInternalError 记日志
    let out = "";
    let logged: unknown;
    const code = await runJudgementCli(["plan", "show", planId], {
      j: { plans: { show: async () => { throw new Error("数据库连接串 secret=abc"); } } } as never,
      ctx: e.creator,
      readFile: () => new Uint8Array(),
      stdout: (s2) => void (out += s2),
      stderr: () => {},
      onInternalError: (x) => void (logged = x),
    });
    expect(code).toBe(1);
    expect(JSON.parse(out)).toEqual({ ok: false, error: { code: "internal_error", message: "内部错误，详见服务端日志" } });
    expect((logged as Error).message).toContain("secret");
  });
});

describe("plan 命令", () => {
  it("create / show / list / archive / unarchive / reconcile：成功；输入错误；授权错误（越范围 = 未找到）", async () => {
    const { w, e, run } = await setup();
    const planId = await createPlan(run, w);
    expect((await run(["plan", "show", planId])).json.plan).toMatchObject({ alias: "计划 A", status: "active" });
    expect((await run(["plan", "list", "--activity-plan", String(w.planId)])).json.plans).toHaveLength(1);
    expect((await run(["plan", "list", "--status", "archived"])).json.plans).toHaveLength(0);
    expect((await run(["plan", "archive", planId])).json).toMatchObject({ ok: true, archived: true });
    expect((await run(["plan", "list", "--status", "archived"])).json.plans).toHaveLength(1);
    expect((await run(["plan", "unarchive", planId])).json).toMatchObject({ ok: true, archived: false });
    expect((await run(["plan", "reconcile"])).json).toMatchObject({ ok: true, completed: [] });
    expect((await run(["plan", "reconcile", "--plan", planId])).code).toBe(0);
    // 输入错误
    expect((await run(["plan", "create", "--activity-plan", String(w.planId)])).code).toBe(2); // 缺 --alias
    expect((await run(["plan", "create", "--alias", "x"])).code).toBe(2); // 缺 --activity-plan
    expect((await run(["plan", "list", "--status", "bogus"])).code).toBe(2);
    expect((await run(["plan", "reconcile", "--plan", "x"])).code).toBe(2);
    // 授权：无 Capability = 2；范围外 = 未找到 4；非创建者写 = 2
    const staff = userCtx("store_staff", 9, e.creator.scope);
    expect((await run(["plan", "show", planId], staff)).code).toBe(2);
    expect((await run(["plan", "create", "--activity-plan", String(w.planId), "--alias", "B"], staff)).code).toBe(2);
    const stranger = { ...e.creator, scope: { ...e.creator.scope, brands: new Set([w.org.hisenseBrandId]) } };
    expect((await run(["plan", "show", planId], stranger)).code).toBe(4);
    expect((await run(["plan", "list"], stranger)).json.plans).toHaveLength(0);
    expect((await run(["plan", "unarchive", planId], e.other)).code).toBe(2);
    expect((await run(["plan", "create", "--activity-plan", "999999", "--alias", "C"])).code).toBe(4);
  });
});

describe("config / image 命令", () => {
  it("config set / show 与 image put / remove：成功；文件不存在、不是 JSON、能力不存在、kind 非法；授权错误", async () => {
    const png = new Uint8Array([1, 2, 3]);
    const { w, e, run } = await setup({}, { "/c.json": JSON.stringify(COVER), "/bad.json": "{", "/img.png": png });
    const planId = await createPlan(run, w);
    expect((await run(["config", "set", planId, "--file", "/c.json"])).json).toMatchObject({ ok: true, configSha256: expect.any(String) });
    const shown = await run(["config", "show", planId]);
    expect(shown.json).toMatchObject({ ok: true, version: 1, status: "draft", config: { layer2: { abilities: [{ abilityId: "cover1" }] } } });
    expect((await run(["config", "show", planId, "--version", "1"])).code).toBe(0);
    expect((await run(["config", "show", planId, "--version", "9"])).code).toBe(4);
    expect((await run(["config", "set", planId, "--file", "/missing.json"])).json.error.code).toBe("file_not_found");
    expect((await run(["config", "set", planId, "--file", "/bad.json"])).json.error.code).toBe("config_not_json");
    expect((await run(["config", "set", planId])).code).toBe(2);
    expect((await run(["config", "bogus", planId])).code).toBe(2);
    const put = await run(["image", "put", planId, "--ability", "cover1", "--kind", "template", "--file", "/img.png"]);
    expect(put.json).toMatchObject({ ok: true, sha256: expect.any(String) });
    expect(e.fake.callsOf("segments.putImage")).toHaveLength(1);
    expect((await run(["image", "put", planId, "--ability", "cover1", "--kind", "bogus", "--file", "/img.png"])).code).toBe(2);
    expect((await run(["image", "put", planId, "--ability", "cover1", "--kind", "template", "--file", "/nope.png"])).json.error.code).toBe("file_not_found");
    expect((await run(["image", "put", planId, "--kind", "template", "--file", "/img.png"])).code).toBe(2); // 缺 --ability
    expect((await run(["image", "put", planId, "--ability", "nope", "--kind", "template", "--file", "/img.png"])).json.ok).toBe(false);
    expect((await run(["image", "remove", planId, "--ability", "cover1"])).json).toMatchObject({ ok: true, abilityId: "cover1" });
    expect((await run(["image", "remove", planId])).code).toBe(2);
    expect((await run(["image", "bogus", planId])).code).toBe(2);
    // 授权：非创建者不能改
    expect((await run(["config", "set", planId, "--file", "/c.json"], e.other)).code).toBe(2);
    expect((await run(["image", "put", planId, "--ability", "cover1", "--kind", "template", "--file", "/img.png"], e.other)).code).toBe(2);
    expect((await run(["image", "remove", planId, "--ability", "cover1"], e.other)).code).toBe(2);
    expect((await run(["config", "show", planId], userCtx("store_staff", 9, e.creator.scope))).code).toBe(2);
  });
});

describe("circle / trial / trial-report / rollback / new-draft", () => {
  it("圈定、试跑、报告；rollback 不带 --apply 不改任何表（T3），--apply 才回退；授权与输入错误", async () => {
    const { w, e, run } = await setup({}, { "/c.json": JSON.stringify(COVER), "/img.png": new Uint8Array([1, 2, 3]) });
    const planId = await createPlan(run, w);
    await addListTask(t.db, { accountId: w.accZhao, status: "succeeded", at: day(6) });
    const ids = [await content(w, e, "a", 3), await content(w, e, "b", 2), await content(w, e, "c", 1)];
    await run(["config", "set", planId, "--file", "/c.json"]);
    await run(["image", "put", planId, "--ability", "cover1", "--kind", "template", "--file", "/img.png"]);
    const c = await run(["circle", planId]);
    expect(c.json).toMatchObject({ ok: true, circle: { c1: 2, participants: 1, skipped: 1 } });
    for (const id of ids) e.fake.setValue("content.cover_template_score", id, { state: "valid", usable: true, score: 8 });
    const tr = await run(["trial", planId, "--wait"]);
    expect(tr.json).toMatchObject({ ok: true, status: "completed" });
    const rep = await run(["trial-report", planId]);
    expect(rep.json).toMatchObject({ ok: true, c1: 2, abilities: [{ abilityId: "cover1", pass: 2 }] });
    // T3：预览不改任何表
    const before = await snapshot();
    const pv = await run(["rollback", planId]);
    expect(pv.json).toMatchObject({ ok: true, apply: false, applied: false, from: "compared", to: "circled" });
    expect(await snapshot()).toBe(before);
    expect((await run(["rollback", planId, "--apply"])).json).toMatchObject({ ok: true, apply: true, applied: true, to: "circled" });
    expect((await t.db.select().from(judgementPlanVersions))[0]!.wizardStep).toBe("circled");
    // 输入与授权
    expect((await run(["trial-report", planId])).code).toBe(4); // 回退后没有试跑结果
    expect((await run(["circle"])).code).toBe(2);
    expect((await run(["trial", planId, "--bogus"])).code).toBe(2);
    expect((await run(["rollback", planId, "--apply"], e.other)).code).toBe(2);
    expect((await run(["circle", planId], e.other)).code).toBe(2);
    expect((await run(["trial", planId], e.other)).code).toBe(2);
    expect((await run(["trial-report", planId], userCtx("store_staff", 9, e.creator.scope))).code).toBe(2);
    expect((await run(["new-draft", planId])).code).toBe(3); // 已有草稿
    expect((await run(["new-draft", planId, "--from", "x"])).code).toBe(2);
  });
});

describe("confirm / execute / run 命令", () => {
  it("confirm 预览不改状态；--apply 发布并建执行运行；同键重复返回同一运行；execute 与 new-draft；run show / list / cancel / resume", async () => {
    const { w, e, run } = await setup({}, { "/c.json": JSON.stringify(BASE) });
    const planId = await createPlan(run, w);
    await addListTask(t.db, { accountId: w.accZhao, status: "succeeded", at: day(6) });
    await content(w, e, "a", 3);
    await run(["config", "set", planId, "--file", "/c.json"]);
    await run(["circle", planId]);
    // confirm 无 --apply：只预览
    const before = await snapshot();
    const pv = await run(["confirm", planId, "--key", "k1"]);
    expect(pv.json).toMatchObject({ ok: true, apply: false, preview: { version: 1, ready: true, blockers: [] } });
    expect(await snapshot()).toBe(before);
    expect((await run(["confirm", planId, "--apply"])).code).toBe(2); // 缺 --key
    expect((await run(["confirm", planId, "--key", "k1", "--apply"], e.other)).code).toBe(2);
    expect((await run(["execute", planId, "--key", "kx"])).json.error.code).toBe("draft_exists"); // 有草稿要 confirm
    const ok = await run(["confirm", planId, "--key", "k1", "--apply"]);
    expect(ok.json).toMatchObject({ ok: true, apply: true, version: 1, created: true });
    const again = await run(["confirm", planId, "--key", "k1", "--apply"]);
    expect(again.code).toBe(3); // 草稿已发布：没有可确认的草稿
    expect(again.json.error.code).toBe("no_draft");
    const runId: string = ok.json.runId;
    // run show / list / cancel（预览 → apply）
    expect((await run(["run", "show", runId])).json.run).toMatchObject({ runId, kind: "execution", status: "planned", version: 1 });
    expect((await run(["run", "list", "--plan", planId])).json.runs.map((r: { runId: string }) => r.runId)).toContain(runId);
    expect((await run(["execute", planId, "--key", "k2"])).code).toBe(3); // run_active
    const pre = await snapshot();
    expect((await run(["run", "cancel", runId])).json).toMatchObject({ ok: true, apply: false, wouldCancel: true });
    expect(await snapshot()).toBe(pre);
    expect((await run(["run", "cancel", runId, "--apply"], e.other)).code).toBe(2);
    expect((await run(["run", "cancel", runId, "--apply"])).json).toMatchObject({ ok: true, apply: true, cancelled: true });
    expect((await run(["run", "show", runId])).json.run.status).toBe("cancelled");
    expect((await run(["run", "resume", runId])).json).toMatchObject({ ok: true, resumed: false }); // 只有 failed 能续跑
    // 对已发布版本重新执行；新建草稿
    const re = await run(["execute", planId, "--key", "k2"]);
    expect(re.json).toMatchObject({ ok: true, version: 1, created: true });
    expect((await run(["execute", planId, "--key", "k2"])).json).toMatchObject({ ok: true, created: false });
    expect((await run(["execute", planId], e.creator)).code).toBe(2); // 缺 --key
    expect((await run(["execute", planId, "--key", "k3"], e.other)).code).toBe(2);
    expect((await run(["new-draft", planId], e.other)).code).toBe(2);
    expect((await run(["new-draft", planId, "--from", "7"])).code).toBe(4);
    expect((await run(["new-draft", planId])).json).toMatchObject({ ok: true, version: 2 });
    expect((await run(["confirm", planId, "--key", "k9"])).json.preview).toMatchObject({ version: 2 });
    // run 的输入与授权错误
    expect((await run(["run", "show", "999999"])).code).toBe(4);
    expect((await run(["run", "list"])).code).toBe(2);
    expect((await run(["run", "bogus"])).code).toBe(2);
    expect((await run(["run", "resume", "999999"])).code).toBe(4);
    const stranger = { ...e.creator, scope: { ...e.creator.scope, brands: new Set([w.org.hisenseBrandId]) } };
    expect((await run(["run", "show", runId], stranger)).code).toBe(4);
    expect((await run(["run", "list", "--plan", planId], userCtx("store_staff", 9, e.creator.scope))).code).toBe(2);
  });
  it("run resume：failed 的运行续跑成功；非创建者被拒", async () => {
    const { w, e, run } = await setup({}, { "/c.json": JSON.stringify(BASE) });
    const planId = await createPlan(run, w);
    await run(["config", "set", planId, "--file", "/c.json"]);
    const { runId } = await e.claim.createRun(t.db, { planId: BigInt(planId), version: 1, kind: "circle", actor: "user:7", userId: 7n });
    await t.db.update(judgementRuns).set({ status: "failed", activeKey: null, lastErrorCode: "internal_error" }).where(eq(judgementRuns.runId, runId));
    expect((await run(["run", "resume", String(runId)], e.other)).code).toBe(2);
    expect((await run(["run", "show", String(runId)])).json.run).toMatchObject({ status: "failed", lastErrorCode: "internal_error" });
    expect((await run(["run", "resume", String(runId)])).json).toMatchObject({ ok: true, resumed: true });
    expect((await t.db.select().from(judgementRuns))[0]!.status).toBe("planned");
  });
});

describe("result / explain / maintain / serve 命令", () => {
  async function completed() {
    const s = await setup({}, { "/c.json": JSON.stringify(BASE) });
    const planId = await createPlan(s.run, s.w);
    await addListTask(t.db, { accountId: s.w.accZhao, status: "succeeded", at: day(6) });
    const ids = [await content(s.w, s.e, "a", 3), await content(s.w, s.e, "b", 2), await content(s.w, s.e, "c", 1)];
    await s.run(["config", "set", planId, "--file", "/c.json"]);
    const circle = await s.run(["circle", planId]);
    const ex = await s.run(["confirm", planId, "--key", "k1", "--apply"]);
    await s.e.runs.drive(BigInt(ex.json.runId), "w", s.e.sleep);
    return { ...s, planId, ids, execId: ex.json.runId as string, circleId: circle.json.circle.runId as string };
  }
  it("result summary / participants / contents / circle 与 explain：成功、过滤、截断；输入与授权错误", async () => {
    const { w, e, run, ids, execId, circleId } = await completed();
    const sum = await run(["result", "summary", execId]);
    expect(sum.json.execution).toMatchObject({ executionId: execId, participantCount: 1, c1: 2, contentTotal: 3 });
    const ps = await run(["result", "participants", execId]);
    expect(ps.json).toMatchObject({ ok: true, truncated: false });
    expect(ps.json.rows).toHaveLength(1);
    expect((await run(["result", "participants", execId, "--result", "not_met"])).json.rows).toHaveLength(0);
    const cs = await run(["result", "contents", execId]);
    expect(cs.json.rows).toHaveLength(3);
    expect((await run(["result", "contents", execId, "--final", "skipped"])).json.rows).toHaveLength(1);
    expect((await run(["result", "contents", execId, "--staff", String(w.staff.zhao)])).json.rows).toHaveLength(3);
    expect((await run(["result", "contents", execId, "--staff", "999999"])).json.rows).toHaveLength(0);
    expect(await run(["result", "contents", execId, "--limit", "1"])).toMatchObject({ json: { truncated: true } });
    expect((await run(["result", "circle", circleId])).json.rows).toHaveLength(3);
    const ex = await run(["explain", "--execution", execId, "--content", String(ids[0])]);
    expect(ex.json.explanation).toMatchObject({ kind: "content" });
    expect((await run(["explain", "--execution", execId, "--staff", String(w.staff.zhao)])).json.explanation).toMatchObject({ kind: "staff" });
    // 输入错误
    for (const args of [["result"], ["result", "bogus", execId], ["result", "participants", execId, "--result", "bogus"], ["result", "contents", execId, "--final", "bogus"], ["result", "contents", execId, "--limit", "0"], ["explain", "--execution", execId], ["explain", "--execution", execId, "--content", "1", "--staff", "1"], ["explain", "--content", "1"]]) {
      expect((await run(args)).code, args.join(" ")).toBe(2);
    }
    expect((await run(["result", "summary", "999999"])).code).toBe(4);
    expect((await run(["explain", "--execution", execId, "--content", "999999"])).code).toBe(4);
    // 授权：范围外 = 未找到；无 Capability = 2
    const stranger = { ...e.creator, scope: { ...e.creator.scope, brands: new Set([w.org.hisenseBrandId]) } };
    const staff = userCtx("store_staff", 9, e.creator.scope);
    for (const args of [["result", "summary", execId], ["result", "participants", execId], ["result", "contents", execId], ["result", "circle", circleId], ["explain", "--execution", execId, "--content", String(ids[0])]]) {
      expect((await run(args, stranger)).code, `stranger ${args.join(" ")}`).toBe(4);
      expect((await run(args, staff)).code, `staff ${args.join(" ")}`).toBe(2);
    }
  });
  it("maintain --once 与 serve：成功、输入错误、授权错误；serve 未装配 = 1", async () => {
    let served = 0;
    const s = await setup();
    const run = harness(s.e, {}, { serve: async () => void served++ });
    const m = await run(["maintain", "--once"]);
    expect(m.json).toMatchObject({ ok: true, report: { expiredRuns: 0, prunedExecutions: 0, prunedFailed: 0 } });
    expect((await run(["maintain"])).code).toBe(2);
    expect((await run(["maintain", "--once", "--force"])).code).toBe(2);
    expect((await run(["maintain", "--once"], userCtx("store_staff", 9, s.e.creator.scope))).code).toBe(2);
    expect((await run(["serve"])).json).toMatchObject({ ok: true, stopped: true });
    expect(served).toBe(1);
    expect((await run(["serve", "--once"])).code).toBe(2);
    expect((await run(["serve"], userCtx("store_staff", 9, s.e.creator.scope))).code).toBe(2);
    expect(served).toBe(1); // 无权限不会进入常驻
    expect((await harness(s.e)(["serve"])).code).toBe(1);
  });
});
