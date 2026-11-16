// d-rule-engine 任务 12：验收覆盖映射（/tmp/d-acceptance-map.md）发现的缺口，补成断言。
// 编号对应 acceptance.md：E13 / E18 / G6 / G11 / H1 / H2 / J1 / J4 / J8 / K3 / K4 / K7 / L6 / M7 / I13 / I16。
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { activityPlanRoster, externalAccounts, judgementPlanVersions, judgementRuns, runContents, runParticipants, staffAccountAssignments, syncCheckpoints } from "../../db/schema";
import { useTestDb } from "../../../tests/harness/db";
import { insertBatch, insertProfileSnapshot } from "../../../tests/harness/factories";
import { addCheckpoint, addComment, addContent, addListTask, judgementEnv, judgementWorld, moveCurrentSnapshot, T0, type JudgementEnv, type JudgementWorld } from "../../../tests/harness/judgement";
import { insertPlan, insertRosterEntry } from "../../../tests/harness/plan";
const t = useTestDb();
const day = (d: number) => new Date(Date.UTC(2026, 10, d, 4));
const TITLE = { text: [{ fields: ["title"], mode: "any", keywords: ["海信"] }] };
const WINDOW = { from: "2026-11-01", to: "2026-11-30" };
const BASE = { window: WINDOW, kinds: ["video"], layer1: { ...TITLE, quantity: { n: 2 } } };
const ab = (o: Record<string, unknown> = {}) => ({ abilityId: "cover1", kind: "whole_image", target: "cover", threshold: "6.5", ...o });
async function setup(cfg: Record<string, unknown> = BASE, over: Parameters<typeof judgementEnv>[2] = {}) {
  const w = await judgementWorld(t);
  const e = judgementEnv(t, w, over);
  const { planId } = await e.plans.create(e.creator, { activityPlanId: w.planId, alias: "计划 A" });
  await e.versions.setConfig(e.creator, planId, cfg);
  await addListTask(t.db, { accountId: w.accZhao, status: "succeeded", at: day(6) });
  return { w, e, planId };
}
interface C { like?: number; hit?: boolean; tags?: string[]; cover?: number | "pending"; verdict?: "meets" | "not_meets" }
async function content(w: JudgementWorld, e: JudgementEnv, id: string, o: C = {}) {
  const c = await addContent(t.db, { accountId: w.accZhao, platformContentId: id, kind: "video", like: o.like ?? 1, publishedAt: day(5) });
  e.fake.setValue("text.title_normalized", c.contentId, { state: "valid", usable: true, value: o.hit === false ? "无关" : "海信新品", normalizerVersion: 1 });
  if (o.tags) e.fake.setValue("text.hashtags", c.contentId, { state: "valid", usable: true, value: o.tags, normalizerVersion: 1 });
  if (o.cover === "pending") e.fake.setValue("content.cover_template_score", c.contentId, { state: "missing", usable: false, reason: "media_pending" });
  else if (o.cover !== undefined) e.fake.setValue("content.cover_template_score", c.contentId, { state: "valid", usable: true, score: o.cover });
  if (o.verdict) e.fake.setValue("content.asr_judgement", c.contentId, { state: "valid", usable: true, value: { verdict: o.verdict, reason: "口播相关" }, evidence: { model: "judge-1", prompt_version: 2 }, resultId: 1000n + c.contentId });
  return c.contentId;
}
const setStep = (planId: bigint) => t.db.update(judgementPlanVersions).set({ wizardStep: "compared" }).where(and(eq(judgementPlanVersions.planId, planId), eq(judgementPlanVersions.status, "draft")));
async function exec(e: JudgementEnv, planId: bigint, key = "k1") {
  await setStep(planId);
  const r = await e.runs.execute(e.creator, planId, { key });
  return { ...r, done: await e.runs.drive(r.runId, "w", e.sleep) };
}
const rows = (runId: bigint) => t.db.select().from(runContents).where(eq(runContents.runId, runId));
const selectedOf = async (runId: bigint) => (await rows(runId)).filter((r) => r.layer1Selected === true).map((r) => r.contentId).sort();
const partOf = async (runId: bigint, accountId?: bigint) => (await t.db.select().from(runParticipants).where(accountId ? and(eq(runParticipants.runId, runId), eq(runParticipants.accountId, accountId)) : eq(runParticipants.runId, runId)))[0]!;
/** 第一次读信号时（此时冻结与范围阶段已完成）插入一个动作：模拟「运行中途外部发生了变化」。 */
function onFirstRead(e: JudgementEnv, act: () => Promise<void>) {
  const orig = e.fake.readMany.bind(e.fake);
  let fired = false;
  e.fake.readMany = async (...a) => {
    if (!fired) {
      fired = true;
      await act();
    }
    return orig(...a);
  };
}
const asc = (xs: bigint[]) => [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

describe("数量 N、冻结与重新冻结（E13 / E18 / G6 / G11）", () => {
  it("E13：文本与话题两个条件同时配置 → 先 AND 再按点赞取前 N；高赞但缺话题的内容不占名额", async () => {
    const { w, e, planId } = await setup({ ...BASE, layer1: { ...TITLE, hashtags: [{ mode: "any", values: ["618"] }], quantity: { n: 2 } } });
    const hi = await content(w, e, "hi", { like: 30, tags: ["别的"] }); // 标题命中、话题不命中
    const mid = await content(w, e, "mid", { like: 20, tags: ["618"] });
    const low = await content(w, e, "low", { like: 10, tags: ["618"] });
    const { done } = await exec(e, planId);
    expect(await selectedOf(done.runId)).toEqual(asc([mid, low]));
    expect((await rows(done.runId)).find((r) => r.contentId === hi)).toMatchObject({ l1: "fail", final: "fail" });
  });
  it("E18：圈定之后又有新同步改变点赞，再执行 → 圈定条数是当时快照；执行重新冻结，前 N 变了", async () => {
    const { w, e, planId } = await setup();
    const a = await content(w, e, "a", { like: 3 });
    const b = await content(w, e, "b", { like: 2 });
    const c = await content(w, e, "c", { like: 1 });
    const circle = await e.runs.circle(e.creator, planId);
    expect(await selectedOf(circle.runId)).toEqual(asc([a, b]));
    await moveCurrentSnapshot(t.db, c, { like: 10 }); // 圈定之后又同步了一次
    const { done } = await exec(e, planId);
    expect(await selectedOf(done.runId)).toEqual(asc([a, c]));
    expect(await selectedOf(circle.runId)).toEqual(asc([a, b])); // 圈定结果不被改写
    expect((await rows(done.runId)).find((r) => r.contentId === b)).toMatchObject({ l1: "pass", layer1Selected: false, final: "skipped" });
  });
  it("G6：冻结之后 current 快照又移动并改了点赞 → 本次运行读到的仍是冻结的快照与点赞", async () => {
    const { w, e, planId } = await setup();
    const a = await content(w, e, "a", { like: 3 });
    const b = await content(w, e, "b", { like: 2 });
    const c = await content(w, e, "c", { like: 1 });
    const before = new Map((await t.db.select().from(runContents)).map((r) => [r.contentId, r.contentSnapshotId])); // 空：还没有运行
    expect(before.size).toBe(0);
    onFirstRead(e, async () => void (await moveCurrentSnapshot(t.db, c, { like: 99 })));
    const { done } = await exec(e, planId);
    const got = await rows(done.runId);
    expect(await selectedOf(done.runId)).toEqual(asc([a, b])); // 按冻结时的点赞排名
    const cRow = got.find((r) => r.contentId === c)!;
    expect(cRow).toMatchObject({ likeValue: 1n, likeState: "value" });
    // 冻结的快照 ≠ 现在的 current
    const [cur] = await t.db.query.contents.findMany({ where: (x, { eq: same }) => same(x.contentId, c) });
    expect(cRow.contentSnapshotId).not.toBe(cur!.currentSnapshotId);
  });
  it("G11：执行期间其他活动计划的名单变化不影响本次执行", async () => {
    const { w, e, planId } = await setup();
    await content(w, e, "a", { like: 3 });
    await content(w, e, "b", { like: 2 });
    const other = await insertPlan(t.db, w.org, { name: "另一个活动", createdBy: "user:7", joined: [w.bj] });
    const entry = await insertRosterEntry(t.db, { planId: other, accountId: w.accZhao, staffId: w.staff.zhao, storeId: w.stores.sW1, branchId: w.bj });
    onFirstRead(e, async () => {
      await t.db.update(activityPlanRoster).set({ entryState: "removed", removedReason: "manual_remove", removedAt: T0 }).where(eq(activityPlanRoster.rosterEntryId, entry));
    });
    const { done } = await exec(e, planId);
    expect(done.status).toBe("completed");
    expect(await partOf(done.runId)).toMatchObject({ contentResult: "success", planResult: "success", c1Count: 2 });
    expect(await t.db.select().from(runParticipants).where(eq(runParticipants.runId, done.runId))).toHaveLength(1);
  });
});

describe("第 2 层之后的主体只含通过者（H1 / H2 / J1 / L6 / J8）", () => {
  const FULL = { ...BASE, layer1: { ...TITLE, hashtags: [{ mode: "any", values: ["618"] }], quantity: { n: 5 } }, layer2: { abilities: [ab()] }, commentRequirement: { mode: "any", keywords: ["安装"], method: { type: "at_least_n", n: 1 } }, contentRequirement: { layer3: { standardText: "口播提到海信" } } };
  it("H1 / H2 / J1 / L6：封面分低、话题不符、封面素材未就绪的内容都不进评论与音频的主体；l3 = skipped；通过者的 final 不受评论影响", async () => {
    const { w, e, planId } = await setup(FULL);
    await e.versions.putTemplate(e.creator, planId, "cover1", new Uint8Array([1, 2, 3]));
    const ok = await content(w, e, "ok", { like: 5, tags: ["618"], cover: 9, verdict: "meets" });
    const lowCover = await content(w, e, "low", { like: 4, tags: ["618"], cover: 3, verdict: "meets" }); // H1：话题对、封面分低
    const noTag = await content(w, e, "notag", { like: 3, tags: ["别的"], cover: 9, verdict: "meets" }); // H1：封面分高、话题不对
    const pending = await content(w, e, "pend", { like: 2, tags: ["618"], cover: "pending", verdict: "meets" }); // H2：第 2 层未获取成功
    const { done } = await exec(e, planId);
    expect(done.status).toBe("completed");
    const submitted = e.demand.submitted.flatMap((s) => (s.input as { items: Array<{ contentId: string; wants: string[] }> }).items.map((i) => `${i.wants[0]}:${i.contentId}`));
    expect(submitted.filter((x) => x.startsWith("comments:"))).toEqual([`comments:${ok}`]); // 评论需求的主体只有通过第 1、2 层的那一条
    expect(submitted.filter((x) => !x.startsWith("comments:")).every((x) => x.endsWith(`:${ok}`))).toBe(true); // 音频需求同理（L6）
    const asr = e.fake.callsOf("requestScores").map((c) => c.args as { subjects: string[]; only: string[] }).filter((c) => c.only.includes("content.asr_judgement"));
    expect(asr.flatMap((c) => c.subjects)).toEqual([`content:${ok}`]); // 音频 / ASR 的主体也只有它
    const byId = new Map((await rows(done.runId)).map((r) => [r.contentId, r]));
    expect(byId.get(lowCover)).toMatchObject({ l1: "pass", l2: "fail", l3: "skipped", final: "fail" });
    expect(byId.get(noTag)).toMatchObject({ l1: "fail", l2: "skipped", l3: "skipped", final: "fail" });
    expect(byId.get(pending)).toMatchObject({ l1: "pass", l2: "unobtained", l3: "skipped", final: "unobtained" });
    expect(byId.get(ok)).toMatchObject({ l1: "pass", l2: "pass", l3: "pass", final: "pass" }); // J8：评论没有命中（没有评论）也不改内容结果
    expect(await partOf(done.runId)).toMatchObject({ c1Count: 3, c2Count: 1, c3Count: 1, commentResult: "unobtained" }); // C2 里 1 条评论不命中；但有内容停在第 2 层「未获取成功」→ 评论无从判定（design §7.7，T = 0 分支）
  });
  it("J8：通过者的评论都不命中 → 评论要求不达标，但内容 final 仍是 pass（评论不反过来过滤内容）", async () => {
    const { w, e, planId } = await setup({ ...BASE, layer1: { ...TITLE }, commentRequirement: FULL.commentRequirement });
    const a = await content(w, e, "a");
    const id = await addComment(t.db, { contentId: a, platformCommentId: "cm-1" });
    e.fake.setValue("comment.text_normalized", id, { state: "valid", usable: true, value: "普通评论", normalizerVersion: 1 });
    e.demand.setOutcome(a, "comments", { state: "ready", comments: { coverage: "complete", fetchedCount: 1, reportedTotal: "1" } });
    const { done } = await exec(e, planId);
    expect((await rows(done.runId))[0]).toMatchObject({ final: "pass" });
    expect(await partOf(done.runId)).toMatchObject({ contentResult: "success", commentResult: "not_met", planResult: "not_met" });
  });
});

describe("账号要求（K3 / K4 / K7）", () => {
  const profile = async (w: JudgementWorld) => {
    const batchId = await insertBatch(t.db, T0);
    const [asg] = await t.db.select().from(staffAccountAssignments).where(eq(staffAccountAssignments.accountId, w.accZhao));
    const id = await insertProfileSnapshot(t.db, { batchId, accountId: w.accZhao, assignmentId: asg!.assignmentId, now: T0 });
    await t.db.update(externalAccounts).set({ currentProfileSnapshotId: id }).where(eq(externalAccounts.accountId, w.accZhao));
  };
  const ACCOUNT = { window: WINDOW, kinds: ["video"] };
  it.each([["media_pending"], ["media_failed"], ["carried_forward"]])("K3：头像素材 %s → 账号要求未获取成功，原因逐字沿用 C 的", async (reason) => {
    const { w, e, planId } = await setup({ ...ACCOUNT, layer2: { abilities: [ab({ abilityId: "av1", target: "avatar" })] } });
    await profile(w);
    await e.versions.putTemplate(e.creator, planId, "av1", new Uint8Array([1]));
    e.fake.setValue("account.avatar_template_score", w.accZhao, { state: "missing", usable: false, reason });
    const { done } = await exec(e, planId);
    expect(await partOf(done.runId)).toMatchObject({ accountResult: "unobtained", planResult: "unobtained", primaryReason: reason });
  });
  it("K4：头像不通过 + 背景未获取成功 → 不通过（AND3，不通过优先）", async () => {
    const { w, e, planId } = await setup({ ...ACCOUNT, layer2: { abilities: [ab({ abilityId: "av1", target: "avatar" }), ab({ abilityId: "bg1", target: "background" })] } });
    await profile(w);
    await e.versions.putTemplate(e.creator, planId, "av1", new Uint8Array([1]));
    await e.versions.putTemplate(e.creator, planId, "bg1", new Uint8Array([2]));
    e.fake.setValue("account.avatar_template_score", w.accZhao, { state: "valid", usable: true, score: 3 });
    e.fake.setValue("account.background_template_score", w.accZhao, { state: "missing", usable: false, reason: "media_pending" });
    const { done } = await exec(e, planId);
    expect(await partOf(done.runId)).toMatchObject({ accountResult: "not_met", planResult: "not_met" });
  });
  it("K7：头像图片元素对比读取 account.avatar_element_score + elementKey；分数等于阈值判通过，低于阈值不通过", async () => {
    const { w, e, planId } = await setup({ ...ACCOUNT, layer2: { abilities: [ab({ abilityId: "av1", kind: "image_element", target: "avatar" })] } });
    await profile(w);
    const { elementKey } = await e.versions.putElement(e.creator, planId, "av1", new Uint8Array([7, 7]));
    e.fake.setValue("account.avatar_element_score", w.accZhao, { state: "valid", usable: true, score: 6.5 }, elementKey);
    e.fake.setValue("account.avatar_element_score", w.accZhao, { state: "valid", usable: true, score: 0.1 }, "另一个 key"); // 不是本能力的元素图，不能被读到
    const { done } = await exec(e, planId);
    expect(await partOf(done.runId)).toMatchObject({ accountResult: "success", planResult: "success" });
    expect(e.fake.callsOf("readMany").map((c) => c.args)).toContainEqual({ signalKey: "account.avatar_element_score", n: 1, elementKey });
  });
});

describe("同步完整谓词只读 default 检查点（I16）", () => {
  it("别的 scope 的 blocked 检查点被忽略；default 的 blocked 才使零内容专员「未获取成功」", async () => {
    const { w, e, planId } = await setup({ ...BASE, layer1: { ...TITLE } });
    await addCheckpoint(t.db, w.accZhao, "ready");
    await addCheckpoint(t.db, w.accZhao, "blocked", null, "other-scope"); // 与列表同步无关
    const { done } = await exec(e, planId);
    expect(await partOf(done.runId)).toMatchObject({ contentTotal: 0, contentResult: "not_met", syncComplete: true });
    await t.db.update(syncCheckpoints).set({ continuityStatus: "blocked" }).where(eq(syncCheckpoints.checkpointScope, "default"));
    const again = await exec(e, planId, "k2");
    expect(await partOf(again.done.runId)).toMatchObject({ contentTotal: 0, contentResult: "unobtained", syncComplete: false });
  });
});

describe("评论：等待与取消（J4 / M7）", () => {
  const CM = { ...BASE, layer1: { ...TITLE }, commentRequirement: { mode: "any", keywords: ["安装"], method: { type: "at_least_n", n: 1 } } };
  it("J4：评论文本信号一直没算出 → 评论要求未获取成功 dependency_timeout，内容结果不受影响", async () => {
    const { w, e, planId } = await setup(CM);
    const a = await content(w, e, "a");
    await addComment(t.db, { contentId: a, platformCommentId: "cm-1" }); // 没给评论文本信号编程 = not_computed
    const { done } = await exec(e, planId);
    expect(done.status).toBe("completed");
    expect(await partOf(done.runId)).toMatchObject({ commentResult: "unobtained", contentResult: "success" });
    expect((await partOf(done.runId)).reasonDetail).toBeDefined();
    const r = await t.db.select().from(judgementRuns).where(eq(judgementRuns.runId, done.runId));
    expect(JSON.stringify(r[0]!.phaseDetail ?? "")).not.toContain("secret");
    expect((await partOf(done.runId)).primaryReason).toBe("dependency_timeout");
  });
  it("M7：采集等待期间取消 → 不再提交新批次，已提交的批次不撤销；之后的轮询不再读它", async () => {
    const { w, e, planId } = await setup(CM);
    await content(w, e, "a");
    e.demand.pendingGets = 1000; // 一直在采集
    await setStep(planId);
    const r = await e.runs.execute(e.creator, planId, { key: "k" });
    await e.runs.serveOnce("w"); // 推进到提交评论需求并进入等待
    expect(e.demand.submitted).toHaveLength(1);
    const got = e.demand.getCalls;
    expect(await e.runs.cancel(e.creator, r.runId)).toBe(true);
    e.clock.advance(3_600_000);
    await e.runs.serveOnce("w");
    expect(e.demand.submitted).toHaveLength(1); // 没有新批次
    expect(e.demand.getCalls).toBe(got); // 取消后不再轮询
    expect((await t.db.select().from(judgementRuns).where(eq(judgementRuns.runId, r.runId)))[0]).toMatchObject({ status: "cancelled", leaseOwner: null });
  });
});

describe("可执行性按监控段的信号计算（L2）", () => {
  it("L2：ASR 当前不可执行时，不含第 3 层的计划照常发布与执行；含第 3 层的计划被拒并带阻塞项", async () => {
    const plain = await setup({ ...BASE, layer1: { ...TITLE } });
    plain.e.fake.blockers = [{ code: "model_unavailable", signal: "content.asr_judgement" }];
    await content(plain.w, plain.e, "a");
    const ok = await exec(plain.e, plain.planId);
    expect(ok.done.status).toBe("completed");
    expect(plain.e.fake.callsOf("executability").length).toBeGreaterThan(0);
  });
  it("L2（反例）：含第 3 层的计划在 ASR 不可执行时发布被拒，错误带阻塞项", async () => {
    const withAsr = await setup({ ...BASE, layer1: { ...TITLE }, contentRequirement: { layer3: { standardText: "口播提到海信" } } });
    withAsr.e.fake.blockers = [{ code: "model_unavailable", signal: "content.asr_judgement" }];
    await content(withAsr.w, withAsr.e, "a");
    await setStep(withAsr.planId);
    await expect(withAsr.e.runs.execute(withAsr.e.creator, withAsr.planId, { key: "k" })).rejects.toMatchObject({ code: "not_executable", detail: { blockers: [{ code: "model_unavailable" }] } });
    expect(withAsr.e.fake.callsOf("segments.publish")).toHaveLength(0);
  });
});
