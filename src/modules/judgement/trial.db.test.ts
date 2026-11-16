// d-rule-engine 任务 6：试跑（第 2 层）——JP-6：对 C1 比对、分布与固定 5 个样例、阈值重算、素材缺失、可执行性门控、账号能力、等待与超时。
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { externalAccounts, judgementPlanVersions, judgementRuns, runContents, runParticipants, staffAccountAssignments } from "../../db/schema";
import { useTestDb } from "../../../tests/harness/db";
import { insertBatch, insertProfileSnapshot } from "../../../tests/harness/factories";
import { addContent, judgementEnv, judgementWorld, T0, type JudgementEnv, type JudgementWorld } from "../../../tests/harness/judgement";
import { SignalError } from "../signals/errors";
import { JudgementError } from "./errors";

const t = useTestDb();
const day = (d: number) => new Date(Date.UTC(2026, 10, d, 4));
const ab = (o: Record<string, unknown> = {}) => ({ abilityId: "cover1", kind: "whole_image", target: "cover", threshold: "6.5", ...o });
const BASE = { window: { from: "2026-11-01", to: "2026-11-30" }, kinds: ["video"], layer1: { text: [{ fields: ["title"], mode: "any", keywords: ["海信"] }] } };
const COVER = { ...BASE, layer2: { abilities: [ab()] } };

async function setup(cfg: unknown = COVER, over: Parameters<typeof judgementEnv>[2] = {}) {
  const w = await judgementWorld(t);
  const e = judgementEnv(t, w, over);
  const { planId } = await e.plans.create(e.creator, { activityPlanId: w.planId, alias: "计划 A" });
  await e.versions.setConfig(e.creator, planId, cfg);
  return { w, e, planId };
}
const score = (e: JudgementEnv, id: bigint, v: number, signal = "content.cover_template_score", elementKey?: string) => e.fake.setValue(signal, id, { state: "valid", usable: true, score: v }, elementKey);
const noMedia = (e: JudgementEnv, id: bigint, reason: string, signal = "content.cover_template_score") => e.fake.setValue(signal, id, { state: "missing", usable: false, reason });
async function content(w: JudgementWorld, e: JudgementEnv, id: string, o: { like?: number; account?: bigint } = {}) {
  const c = await addContent(t.db, { accountId: o.account ?? w.accZhao, platformContentId: id, kind: "video", like: o.like ?? 1, publishedAt: day(5) });
  e.fake.setValue("text.title_normalized", c.contentId, { state: "valid", usable: true, value: "海信新品", normalizerVersion: 1 });
  return c.contentId;
}
const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (err) {
    return err instanceof JudgementError ? err.code : `非 JudgementError：${String(err)}`;
  }
  return "no_error";
};
async function circled(w: JudgementWorld, e: JudgementEnv, planId: bigint) {
  await e.versions.putTemplate(e.creator, planId, "cover1", new Uint8Array([1, 2, 3]));
  await e.runs.circle(e.creator, planId);
}
const rowOf = async (runId: bigint, contentId: bigint) => (await t.db.select().from(runContents).where(and(eq(runContents.runId, runId), eq(runContents.contentId, contentId))))[0]!;

describe("试跑（JP-6）", () => {
  it("只对第 1 层留下的内容 C1 请求比对：分批调用，主体只含 C1，且 only 只含第 2 层能力的信号（不连带第 3 层 ASR）", async () => {
    const { w, e, planId } = await setup({ ...COVER, contentRequirement: { layer3: { standardText: "口播提到海信" } } });
    const ids: bigint[] = [];
    for (let i = 0; i < 7; i++) ids.push(await content(w, e, `c${i}`));
    const bad = await addContent(t.db, { accountId: w.accZhao, platformContentId: "no-hit", kind: "video", publishedAt: day(5) });
    e.fake.setValue("text.title_normalized", bad.contentId, { state: "valid", usable: true, value: "无关", normalizerVersion: 1 });
    await circled(w, e, planId);
    for (const id of ids) score(e, id, 8);
    const { runId } = await e.runs.trial(e.creator, planId, { wait: true, sleep: e.sleep });
    const calls = e.fake.callsOf("requestScores").map((c) => c.args as { subjects: string[]; only: string[] });
    expect(calls).toHaveLength(3); // 7 条 / 批大小 3
    expect(calls.flatMap((c) => c.subjects).sort()).toEqual(ids.map((i) => `content:${i}`).sort());
    expect(calls.every((c) => c.only.length === 1 && c.only[0] === "content.cover_template_score")).toBe(true);
    expect(await rowOf(runId, bad.contentId)).toMatchObject({ l1: "fail", l2: "skipped" }); // 第 1 层没过的不比对
    expect(e.fake.callsOf("executability").some((c) => (c.args as { only?: string[] }).only?.join() === "content.cover_template_score")).toBe(true);
    expect((await t.db.select().from(judgementPlanVersions))[0]!.wizardStep).toBe("compared");
  });
  it("分布与样例：0.00 / 9.99 / 10.00 正确入档；每档至多 5 个样例（升序）；换阈值只重算通过数，不新增 C 任务", async () => {
    const { w, e, planId } = await setup();
    const vals = [0, 0.5, 6.5, 6.5, 6.5, 6.5, 6.5, 6.5, 6.49, 9.99, 10];
    const ids: bigint[] = [];
    for (const [i, v] of vals.entries()) {
      const id = await content(w, e, `c${i}`);
      ids.push(id);
      score(e, id, v);
    }
    await circled(w, e, planId);
    await e.runs.trial(e.creator, planId, { wait: true, sleep: e.sleep });
    const r = await e.runs.trialReport(e.creator, planId);
    const a = r.abilities[0]!;
    expect(a.counts).toEqual([2, 0, 0, 0, 0, 0, 7, 0, 0, 1, 1]);
    expect(a.samples[6]).toEqual([...ids.slice(2, 8), ids[8]!].sort((x, y) => (x < y ? -1 : 1)).slice(0, 5)); // 7 条取升序前 5 个
    expect(a.samples[6]).toHaveLength(5);
    expect(a.samples[10]).toEqual([ids[10]]);
    expect(a.subject).toBe("content");
    expect(a.pass).toBe(8); // 阈值 6.50：6 条 6.5 + 9.99 + 10.00，等于阈值通过，6.49 不通过
    expect(JSON.stringify(a, (_k, v) => (typeof v === "bigint" ? String(v) : v))).not.toMatch(/匹配|match/); // 只有连续分数与档位，没有「匹配 / 不匹配」
    const before = e.fake.callsOf("requestScores").length;
    await e.versions.setConfig(e.creator, planId, { ...COVER, layer2: { abilities: [ab({ threshold: "9.99" })] } });
    expect((await e.runs.trialReport(e.creator, planId)).abilities[0]!.pass).toBe(2);
    expect(e.fake.callsOf("requestScores")).toHaveLength(before);
    expect((await t.db.select().from(judgementPlanVersions))[0]!.wizardStep).toBe("compared"); // 阈值不使试跑失效
  });
  it("素材 pending / failed / carried_forward：计入未获取成功，带 C 的原因码；该内容 final=unobtained，不进入第 3 层；没有任何采集需求", async () => {
    const { w, e, planId } = await setup();
    const a = await content(w, e, "a");
    const b = await content(w, e, "b");
    const c = await content(w, e, "c");
    const d = await content(w, e, "d");
    score(e, d, 9);
    noMedia(e, a, "media_pending");
    noMedia(e, b, "media_failed");
    e.fake.setValue("content.cover_template_score", c, { state: "missing", usable: false, reason: "media_carried_forward" });
    await circled(w, e, planId);
    const { runId } = await e.runs.trial(e.creator, planId, { wait: true, sleep: e.sleep });
    expect(await rowOf(runId, a)).toMatchObject({ l2: "unobtained", l3: "skipped", final: "unobtained", reasonCode: "media_pending", stopLayer: "2" });
    expect((await rowOf(runId, b)).reasonCode).toBe("media_failed");
    expect((await rowOf(runId, c)).reasonCode).toBe("media_carried_forward");
    const r = await e.runs.trialReport(e.creator, planId);
    expect(r.abilities[0]!.unobtained).toEqual({ total: 3, byReason: { media_pending: 1, media_failed: 1, media_carried_forward: 1 } });
    expect(e.demand.submitted).toHaveLength(0); // 没有任何采集需求
    expect(e.demand.getCalls).toBe(0);
    expect(r.abilities[0]!.counts[9]).toBe(1);
    expect(e.fake.callsOf("readMany").every((x) => (x.args as { signalKey: string }).signalKey.startsWith("text.") || (x.args as { signalKey: string }).signalKey.startsWith("content.cover"))).toBe(true);
  });
  it("素材终态失败不进入下一层：未达阈值的内容 final=fail，l3 skipped", async () => {
    const { w, e, planId } = await setup();
    const low = await content(w, e, "low");
    score(e, low, 2);
    await circled(w, e, planId);
    const { runId } = await e.runs.trial(e.creator, planId, { wait: true, sleep: e.sleep });
    expect(await rowOf(runId, low)).toMatchObject({ l2: "fail", l3: "skipped", final: "fail", stopLayer: "2" });
  });
  it("第 1 层数量要求：只比对被选中的前 N 条；未选中的内容不被请求", async () => {
    const { w, e, planId } = await setup({ ...COVER, layer1: { ...COVER.layer1, quantity: { n: 2 } } });
    const ids = [await content(w, e, "a", { like: 10 }), await content(w, e, "b", { like: 30 }), await content(w, e, "c", { like: 20 })];
    for (const id of ids) score(e, id, 8);
    await circled(w, e, planId);
    await e.runs.trial(e.creator, planId, { wait: true, sleep: e.sleep });
    const asked = e.fake.callsOf("requestScores").flatMap((c) => (c.args as { subjects: string[] }).subjects);
    expect(asked.sort()).toEqual([`content:${ids[1]}`, `content:${ids[2]}`].sort());
  });
  it("能力不可执行（如图片能力未启用）：试跑被拒并列出阻塞项，不建运行、不返回全 0", async () => {
    const { w, e, planId } = await setup();
    await content(w, e, "a");
    await circled(w, e, planId);
    e.fake.blockers = [{ code: "capability_disabled", signal: "content.cover_template_score" }];
    let err: JudgementError | undefined;
    try {
      await e.runs.trial(e.creator, planId, { wait: true, sleep: e.sleep });
    } catch (x) {
      err = x as JudgementError;
    }
    expect(err!.code).toBe("not_executable");
    expect((err!.detail as { blockers: unknown[] }).blockers).toHaveLength(1);
    expect(await t.db.select().from(judgementRuns).where(eq(judgementRuns.runKind, "compare"))).toHaveLength(0);
    expect(e.fake.callsOf("requestScores")).toHaveLength(0);
  });
  it("建运行之后能力才丢失：运行 failed(not_executable)，已定的行保留", async () => {
    const { w, e, planId } = await setup();
    await content(w, e, "a");
    await circled(w, e, planId);
    e.fake.failNext = { fn: "requestScores", error: new SignalError("conflict", "not_executable", "监控段当前不可执行", [{ code: "capability_disabled" }]) };
    expect(await code(e.runs.trial(e.creator, planId, { wait: true, sleep: e.sleep }))).toBe("not_executable");
    const [run] = await t.db.select().from(judgementRuns).where(eq(judgementRuns.runKind, "compare"));
    expect(run).toMatchObject({ status: "failed", lastErrorCode: "not_executable", activeKey: null });
    expect((await t.db.select().from(runContents).where(eq(runContents.runId, run!.runId))).length).toBe(1);
  });
  it("前置：没圈定被拒", async () => {
    const a = await setup();
    expect(await code(a.e.runs.trial(a.e.creator, a.planId))).toBe("wizard_step_required");
  });
  it("前置：第 2 页没有比对能力被拒", async () => {
    const b = await setup({ ...BASE });
    await content(b.w, b.e, "a");
    await b.e.runs.circle(b.e.creator, b.planId);
    expect(await code(b.e.runs.trial(b.e.creator, b.planId))).toBe("no_abilities");
  });
  it("前置：元素图能力缺 key 被拒", async () => {
    const c = await setup({ ...BASE, layer2: { abilities: [ab({ kind: "image_element" })] } });
    await content(c.w, c.e, "a");
    await c.e.runs.circle(c.e.creator, c.planId);
    expect(await code(c.e.runs.trial(c.e.creator, c.planId))).toBe("image_missing");
  });
  it("试跑期间有在途的圈定 / 试跑时被拒；非创建者被拒；试跑是 manage 能力", async () => {
    const { w, e, planId } = await setup();
    await content(w, e, "a");
    await circled(w, e, planId);
    expect(await code(e.runs.trial(e.other, planId))).toBe("denied_predicate_failed");
    const first = await e.runs.trial(e.creator, planId); // 只建运行，不跑
    expect(first.status).toBe("planned");
    expect(await code(e.runs.trial(e.creator, planId))).toBe("run_active");
    expect(e.audits.some((x) => x.event === "trial_run" && x.risk === "low")).toBe(true);
  });
  it("等待素材：分数一开始没算出，等待期间就绪则正常完成；一直不就绪则超时记 dependency_timeout", async () => {
    const { w, e, planId } = await setup();
    const a = await content(w, e, "a");
    const b = await content(w, e, "b");
    await circled(w, e, planId);
    let n = 0;
    e.onSleep.fn = () => {
      if (++n === 2) score(e, a, 8);
    };
    const { runId } = await e.runs.trial(e.creator, planId, { wait: true, sleep: e.sleep });
    expect((await rowOf(runId, a)).l2).toBe("pass");
    expect(await rowOf(runId, b)).toMatchObject({ l2: "unobtained", reasonCode: "dependency_timeout" });
  });
  it("试跑自己重做一遍第 1 层（只读）：圈定后文本信号变化，试跑按此刻的数据算", async () => {
    const { w, e, planId } = await setup();
    const a = await content(w, e, "a");
    score(e, a, 8);
    await circled(w, e, planId);
    e.fake.setValue("text.title_normalized", a, { state: "valid", usable: true, value: "无关了", normalizerVersion: 1 }); // 圈定之后变了
    const { runId } = await e.runs.trial(e.creator, planId, { wait: true, sleep: e.sleep });
    expect((await rowOf(runId, a)).l1).toBe("fail");
    expect((await e.runs.trialReport(e.creator, planId)).c1).toBe(0);
  });
});

describe("账号能力（头像 / 主页背景）", () => {
  const AVATAR = { ...BASE, layer2: { abilities: [ab({ abilityId: "av1", target: "avatar" })] } };
  async function withProfile(w: JudgementWorld) {
    const batchId = await insertBatch(t.db, T0);
    const [asg] = await t.db.select().from(staffAccountAssignments).where(eq(staffAccountAssignments.accountId, w.accZhao));
    const profileId = await insertProfileSnapshot(t.db, { batchId, accountId: w.accZhao, assignmentId: asg!.assignmentId, now: T0 });
    await t.db.update(externalAccounts).set({ currentProfileSnapshotId: profileId }).where(eq(externalAccounts.accountId, w.accZhao));
  }
  it("对名单账号请求并读分；头像分数进分布，样例是账号 ID；账号能力不依赖内容层", async () => {
    const { w, e, planId } = await setup(AVATAR);
    await withProfile(w);
    await e.versions.putTemplate(e.creator, planId, "av1", new Uint8Array([1]));
    await e.runs.circle(e.creator, planId);
    e.fake.setValue("account.avatar_template_score", w.accZhao, { state: "valid", usable: true, score: 8.8 });
    await e.runs.trial(e.creator, planId, { wait: true, sleep: e.sleep });
    const asked = e.fake.callsOf("requestScores").map((c) => c.args as { subjects: string[]; only: string[] });
    expect(asked.flatMap((c) => c.subjects)).toEqual([`account:${w.accZhao}`]);
    expect(asked[0]!.only).toEqual(["account.avatar_template_score"]);
    const a = (await e.runs.trialReport(e.creator, planId)).abilities[0]!;
    expect(a).toMatchObject({ subject: "account", pass: 1 });
    expect(a.samples[8]).toEqual([w.accZhao]);
  });
  it("没有当前主页快照 → 未获取成功 no_profile_snapshot，不请求；名额已释放 → account_unavailable", async () => {
    const { w, e, planId } = await setup(AVATAR);
    await e.versions.putTemplate(e.creator, planId, "av1", new Uint8Array([1]));
    await e.runs.circle(e.creator, planId);
    await e.runs.trial(e.creator, planId, { wait: true, sleep: e.sleep });
    expect(e.fake.callsOf("requestScores")).toHaveLength(0);
    const [cmp] = await t.db.select().from(judgementRuns).where(eq(judgementRuns.runKind, "compare"));
    const [p] = await t.db.select().from(runParticipants).where(and(eq(runParticipants.runId, cmp!.runId), eq(runParticipants.accountId, w.accZhao)));
    expect(p!.accountDetail).toMatchObject({ result: "unobtained", reason: "no_profile_snapshot" });
    expect((await e.runs.trialReport(e.creator, planId)).abilities[0]!.unobtained.byReason).toEqual({ no_profile_snapshot: 1 });
  });
  it("名额已释放的账号仍是参与专员，记 account_unavailable，不请求", async () => {
    const { w, e, planId } = await setup(AVATAR);
    await withProfile(w);
    await t.db.update(staffAccountAssignments).set({ slotReleasedAt: day(1), monitoringEnabled: false, monitoringClosedReason: "manual" }).where(eq(staffAccountAssignments.accountId, w.accZhao));
    await e.versions.putTemplate(e.creator, planId, "av1", new Uint8Array([1]));
    await e.runs.circle(e.creator, planId);
    await e.runs.trial(e.creator, planId, { wait: true, sleep: e.sleep });
    expect(e.fake.callsOf("requestScores")).toHaveLength(0);
    const [cmp] = await t.db.select().from(judgementRuns).where(eq(judgementRuns.runKind, "compare"));
    const [p] = await t.db.select().from(runParticipants).where(and(eq(runParticipants.runId, cmp!.runId), eq(runParticipants.accountId, w.accZhao)));
    expect(p!.accountDetail).toMatchObject({ result: "unobtained", reason: "account_unavailable" });
  });
});
