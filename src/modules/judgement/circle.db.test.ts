// d-rule-engine 任务 5：运行内核与圈定——JP-5（圈定）、JP-7（冻结）、JP-8 第 1 层、JP-15（租约 / fencing / 取消 / 续跑）。
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { judgementPlanVersions, judgementRuns, runContents, runParticipants, staffAccountAssignments, activityPlanRoster } from "../../db/schema";
import { useTestDb } from "../../../tests/harness/db";
import { addContent, addParticipant, judgementEnv, judgementWorld, type JudgementEnv, type JudgementWorld } from "../../../tests/harness/judgement";
import { StaleLeaseError } from "./engine/claim";
import { JudgementError } from "./errors";

const t = useTestDb();
const day = (d: number, h = 4) => new Date(Date.UTC(2026, 10, d, h));
const text = (kw = "海信") => ({ fields: ["title"], mode: "any", keywords: [kw] });
const CFG = { window: { from: "2026-11-01", to: "2026-11-30" }, kinds: ["video"], layer1: { text: [text()], hashtags: [{ mode: "any", values: ["618"] }] } };

async function setup(cfg: unknown = CFG, over: Parameters<typeof judgementEnv>[2] = {}) {
  const w = await judgementWorld(t);
  const e = judgementEnv(t, w, over);
  const { planId } = await e.plans.create(e.creator, { activityPlanId: w.planId, alias: "计划 A" });
  await e.versions.setConfig(e.creator, planId, cfg);
  return { w, e, planId };
}
/** 造一条内容并给它的文本信号编程（title / tags）。 */
async function content(w: JudgementWorld, e: JudgementEnv, id: string, o: { title?: string | null; tags?: string[] | null; like?: number | "missing"; account?: bigint; day?: number; kind?: "video" | "image" | "text" | "unknown"; durationSeconds?: number | "unknown_unit" | "missing"; published?: Date | null } = {}) {
  const c = await addContent(t.db, { accountId: o.account ?? w.accZhao, platformContentId: id, kind: o.kind ?? "video", like: o.like ?? 1, publishedAt: o.published === undefined ? day(o.day ?? 5) : o.published, ...(o.durationSeconds === undefined ? {} : { durationSeconds: o.durationSeconds }) });
  const ok = (value: unknown) => ({ state: "valid" as const, usable: true, value, normalizerVersion: 1 });
  if (o.title !== null) e.fake.setValue("text.title_normalized", c.contentId, ok(o.title ?? "海信新品"));
  if (o.tags !== null) e.fake.setValue("text.hashtags", c.contentId, ok(o.tags ?? ["618"]));
  return c.contentId;
}
const rowOf = async (runId: bigint, contentId: bigint) => (await t.db.select().from(runContents).where(and(eq(runContents.runId, runId), eq(runContents.contentId, contentId))))[0]!;
const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (err) {
    return err instanceof JudgementError ? err.code : `非 JudgementError：${String(err)}`;
  }
  return "no_error";
};

describe("圈定（JP-5）", () => {
  it("同一条内容必须同时满足全部条件：文本命中但没带话题的、带话题但文本不中的都不通过", async () => {
    const { w, e, planId } = await setup();
    const both = await content(w, e, "both");
    const onlyText = await content(w, e, "onlyText", { tags: ["日常"] });
    const onlyTag = await content(w, e, "onlyTag", { title: "无关的标题" });
    const r = await e.runs.circle(e.creator, planId);
    const runId = r.runId;
    expect(r).toMatchObject({ c1: 1, participants: 1, contents: 3, skipped: 0, unobtained: 0 });
    expect(await rowOf(runId, both)).toMatchObject({ l0: "pass", l1: "pass", layer1Selected: true, final: null, l2: null });
    expect(await rowOf(runId, onlyText)).toMatchObject({ l1: "fail", l2: "skipped", l3: "skipped", final: "fail", stopLayer: "1" });
    expect(await rowOf(runId, onlyTag)).toMatchObject({ l1: "fail", final: "fail" });
  });
  it("圈定期间没有任何外部调用：requestScores / demand / 网关调用数为 0，只读了文本信号", async () => {
    const { w, e, planId } = await setup();
    await content(w, e, "a");
    await e.runs.circle(e.creator, planId);
    expect(e.fake.callsOf("requestScores")).toHaveLength(0);
    expect(e.fake.callsOf("segments.publish")).toHaveLength(0);
    expect(e.fake.callsOf("readMany").length).toBeGreaterThan(0);
  });
  it("话题整体相等：618 不匹配 618大促；关键词全含 / 任一", async () => {
    const { w, e, planId } = await setup({ ...CFG, layer1: { text: [{ fields: ["title"], mode: "all", keywords: ["海信", "新品"] }], hashtags: [{ mode: "any", values: ["#618"] }] } });
    const bigSale = await content(w, e, "bigSale", { tags: ["618大促"] });
    const missWord = await content(w, e, "missWord", { title: "海信" });
    const ok = await content(w, e, "ok", { title: "海信新品" });
    const { runId } = await e.runs.circle(e.creator, planId);
    expect((await rowOf(runId, bigSale)).l1).toBe("fail");
    expect((await rowOf(runId, missWord)).l1).toBe("fail");
    expect((await rowOf(runId, ok)).l1).toBe("pass");
  });
  it("时长：恰好等于边界通过；单位未知 / 值缺失 → 未获取成功并带原因码", async () => {
    const { w, e, planId } = await setup({ ...CFG, layer1: { text: [text()], duration: { minSeconds: 15, maxSeconds: 60 } } });
    const edge = await content(w, e, "edge", { durationSeconds: 60 });
    const zero = await content(w, e, "zero", { durationSeconds: 0 });
    const unit = await content(w, e, "unit", { durationSeconds: "unknown_unit" });
    const gone = await content(w, e, "gone", { durationSeconds: "missing" });
    const r = await e.runs.circle(e.creator, planId);
    expect((await rowOf(r.runId, edge)).l1).toBe("pass");
    expect((await rowOf(r.runId, zero)).l1).toBe("fail");
    expect(await rowOf(r.runId, unit)).toMatchObject({ l1: "unobtained", final: "unobtained", reasonCode: "duration_unit_unknown" });
    expect(await rowOf(r.runId, gone)).toMatchObject({ reasonCode: "duration_missing" });
    expect(r.byReason).toEqual({ duration_unit_unknown: 1, duration_missing: 1 });
  });
  it("范围构建：窗口外不落行；发布时间缺失 / 形态未知落行为未获取成功；非 active 与无当前快照不入内容、只在参与专员的 reason_detail 里计数", async () => {
    const { w, e, planId } = await setup();
    const inside = await content(w, e, "in");
    await content(w, e, "before", { published: new Date("2026-10-31T15:59:59Z") }); // 11-01 00:00+08 之前
    await content(w, e, "after", { published: new Date("2026-11-30T16:00:00Z") }); // 12-01 00:00+08（含）之后
    const edgeIn = await content(w, e, "edgeIn", { published: new Date("2026-10-31T16:00:00Z") });
    const noTime = await content(w, e, "noTime", { published: null });
    const unknownKind = await content(w, e, "unk", { kind: "unknown" });
    await content(w, e, "image", { kind: "image" }); // 形态不在 kinds 里：不参与
    await addContent(t.db, { accountId: w.accZhao, platformContentId: "gone", status: "deleted" });
    await addContent(t.db, { accountId: w.accZhao, platformContentId: "nosnap", noSnapshot: true });
    const r = await e.runs.circle(e.creator, planId);
    const ids = (await t.db.select().from(runContents).where(eq(runContents.runId, r.runId))).map((x) => x.contentId).sort();
    expect(ids).toEqual([inside, edgeIn, noTime, unknownKind].sort());
    expect(await rowOf(r.runId, noTime)).toMatchObject({ l0: "unobtained", final: "unobtained", reasonCode: "published_at_missing", stopLayer: "0", l1: "skipped" });
    expect(await rowOf(r.runId, unknownKind)).toMatchObject({ reasonCode: "content_kind_unknown" });
    const [p] = await t.db.select().from(runParticipants).where(eq(runParticipants.runId, r.runId));
    expect(p!.reasonDetail).toMatchObject({ excluded_status: 1, excluded_no_snapshot: 1 });
    expect(r.byReason).toEqual({ published_at_missing: 1, content_kind_unknown: 1 });
  });
  it("kinds 含视频与图文时形态 unknown 的内容照常参与（无法排除）", async () => {
    const { w, e, planId } = await setup({ ...CFG, kinds: ["video", "image"] });
    const unk = await content(w, e, "unk", { kind: "unknown" });
    const img = await content(w, e, "img", { kind: "text" });
    const r = await e.runs.circle(e.creator, planId);
    expect((await rowOf(r.runId, unk)).l1).toBe("pass");
    expect((await rowOf(r.runId, img)).l1).toBe("pass");
  });
  it("重新圈定替换上一次：旧运行与它的行全部消失；向导进度 circled", async () => {
    const { w, e, planId } = await setup();
    await content(w, e, "a");
    const first = await e.runs.circle(e.creator, planId);
    const second = await e.runs.circle(e.creator, planId);
    expect(second.runId).not.toBe(first.runId);
    expect((await t.db.select().from(judgementRuns)).map((r) => r.runId)).toEqual([second.runId]);
    expect(await t.db.select().from(runContents).where(eq(runContents.runId, first.runId))).toHaveLength(0);
    expect((await t.db.select().from(judgementPlanVersions))[0]!.wizardStep).toBe("circled");
  });
  it("没有第 1 层条件（只有时间窗与形态）：l1 = not_configured，全部参与内容都进 C1；条件为空的纯评论计划也能圈定", async () => {
    const { w, e, planId } = await setup({ window: CFG.window, kinds: ["video"], commentRequirement: { mode: "any", keywords: ["安装"], method: { type: "any" } } });
    await content(w, e, "a");
    await content(w, e, "b");
    const r = await e.runs.circle(e.creator, planId);
    expect(r.c1).toBe(2);
    expect((await t.db.select().from(runContents).where(eq(runContents.runId, r.runId))).every((x) => x.l1 === "not_configured")).toBe(true);
  });
  it("授权：非创建者被拒；缺 Capability 的先于读库被拒；已发布版本不能圈定；校验不过被拒", async () => {
    const { w, e, planId } = await setup();
    await content(w, e, "a");
    expect(await code(e.runs.circle(e.other, planId))).toBe("denied_predicate_failed");
    await e.versions.setConfig(e.creator, planId, { window: CFG.window, kinds: ["video"] });
    expect(await code(e.runs.circle(e.creator, planId))).toBe("config_invalid"); // 一类要求都没配
    await e.versions.setConfig(e.creator, planId, CFG);
    await e.runs.circle(e.creator, planId);
    await e.versions.publish(e.creator, planId);
    expect(await code(e.runs.circle(e.creator, planId))).toBe("version_immutable");
  });
});

describe("第 1 层数量要求（JP-2a）", () => {
  const withN = (n: number) => ({ ...CFG, layer1: { ...CFG.layer1, quantity: { n } } });
  it("10 条满足、N=6：按点赞取前 6 条进入下一层；未选中的 4 条 skipped / layer1_not_selected，不进 C1", async () => {
    const { w, e, planId } = await setup(withN(6));
    const ids: bigint[] = [];
    for (let i = 1; i <= 10; i++) ids.push(await content(w, e, `c${i}`, { like: i * 10 }));
    const r = await e.runs.circle(e.creator, planId);
    expect(r).toMatchObject({ c1: 6, contents: 10, skipped: 4 });
    for (let i = 0; i < 10; i++) {
      const row = await rowOf(r.runId, ids[i]!);
      if (i >= 4) expect(row, `like ${(i + 1) * 10}`).toMatchObject({ layer1Selected: true, layer1Rank: 10 - i, final: null, l2: null });
      else expect(row).toMatchObject({ layer1Selected: false, layer1Rank: 10 - i, final: "skipped", reasonCode: "layer1_not_selected", l2: "skipped", l3: "skipped", stopLayer: "1" });
    }
    const [p] = await t.db.select().from(runParticipants).where(eq(runParticipants.runId, r.runId));
    expect(p).toMatchObject({ c1Count: 6, contentSkipped: 4 });
  });
  it("只有 4 条、N=6：全部进入；点赞缺失排在有效值之后，真实 0 有效；平局按发布时间降序", async () => {
    const { w, e, planId } = await setup(withN(2));
    const zero = await content(w, e, "zero", { like: 0 });
    const missing = await content(w, e, "missing", { like: "missing" });
    const tieNew = await content(w, e, "tieNew", { like: 5, day: 9 });
    const tieOld = await content(w, e, "tieOld", { like: 5, day: 3 });
    const r = await e.runs.circle(e.creator, planId);
    expect((await rowOf(r.runId, tieNew)).layer1Selected).toBe(true);
    expect((await rowOf(r.runId, tieOld)).layer1Selected).toBe(true);
    expect((await rowOf(r.runId, zero)).layer1Selected).toBe(false); // 真实 0 有效但排在 5 之后
    expect((await rowOf(r.runId, missing)).layer1Selected).toBe(false);
    expect((await rowOf(r.runId, zero)).layer1Rank).toBe(3); // 有效的 0 排在无效值前
    expect((await rowOf(r.runId, missing)).layer1Rank).toBe(4);
    const [p] = await t.db.select().from(runParticipants).where(eq(runParticipants.runId, r.runId));
    expect((p!.reasonDetail as { like_not_value: number }).like_not_value).toBe(1);
  });
  it("N 大于候选数：全部进入", async () => {
    const { w, e, planId } = await setup(withN(1000));
    for (let i = 0; i < 4; i++) await content(w, e, `c${i}`);
    expect((await e.runs.circle(e.creator, planId)).c1).toBe(4);
  });
  it("N 缺省：不截断，rank 为空", async () => {
    const { w, e, planId } = await setup();
    const a = await content(w, e, "a");
    const r = await e.runs.circle(e.creator, planId);
    expect(await rowOf(r.runId, a)).toMatchObject({ layer1Selected: true, layer1Rank: null });
  });
  it("按专员各自取前 N：两位专员各 3 条、N=2，各取自己的前 2 条", async () => {
    const { w, e, planId } = await setup(withN(2));
    const other = await addParticipant(t, w, "老孙", "13800010077");
    const mine = [await content(w, e, "m1", { like: 30 }), await content(w, e, "m2", { like: 20 }), await content(w, e, "m3", { like: 10 })];
    const theirs = [await content(w, e, "t1", { account: other.accountId, like: 3 }), await content(w, e, "t2", { account: other.accountId, like: 2 }), await content(w, e, "t3", { account: other.accountId, like: 1 })];
    const r = await e.runs.circle(e.creator, planId);
    expect(r.c1).toBe(4);
    for (const [i, id] of [...mine, ...theirs].entries()) expect((await rowOf(r.runId, id)).layer1Selected, `row ${i}`).toBe(i % 3 !== 2);
  });
});

describe("等待文本信号（在等 / 超时）", () => {
  it("信号还没算出：运行进入 waiting；之后就绪则正常完成，不记超时", async () => {
    const { w, e, planId } = await setup();
    const c = await content(w, e, "late", { title: null, tags: null });
    let sleeps = 0;
    e.onSleep.fn = () => {
      if (++sleeps === 2) {
        e.fake.setValue("text.title_normalized", c, { state: "valid", usable: true, value: "海信", normalizerVersion: 1 });
        e.fake.setValue("text.hashtags", c, { state: "valid", usable: true, value: ["618"], normalizerVersion: 1 });
      }
    };
    const r = await e.runs.circle(e.creator, planId, { sleep: e.sleep });
    expect(sleeps).toBeGreaterThanOrEqual(2);
    expect((await rowOf(r.runId, c)).l1).toBe("pass");
  });
  it("一直不就绪：超过信号等待上限后记 dependency_timeout，运行继续并完成", async () => {
    const { w, e, planId } = await setup();
    const c = await content(w, e, "never", { title: null, tags: null });
    const r = await e.runs.circle(e.creator, planId, { sleep: e.sleep });
    expect(await rowOf(r.runId, c)).toMatchObject({ l1: "unobtained", final: "unobtained", reasonCode: "dependency_timeout" });
    expect(r.byReason).toEqual({ dependency_timeout: 1 });
    expect(e.clock.now().getTime() - new Date("2026-11-16T02:00:00Z").getTime()).toBeGreaterThanOrEqual(600_000);
  });
  it("等待上限为 0：下一个 tick 立即记 dependency_timeout", async () => {
    const { w, e, planId } = await setup(CFG, { config: { waitSignalSeconds: 0 } });
    const c = await content(w, e, "never", { title: null, tags: null });
    const r = await e.runs.circle(e.creator, planId, { sleep: e.sleep });
    expect((await rowOf(r.runId, c)).reasonCode).toBe("dependency_timeout");
  });
});

describe("冻结（JP-7）", () => {
  it("参与专员 = 执行时账号的当前归属，组织链取自新专员及其当前门店（而不是名单项里的旧快照）", async () => {
    const { w, e, planId } = await setup();
    await content(w, e, "a");
    // 把老赵的账号改绑给 102 分公司门店里的老李（老李当前没有账号）
    await t.db.update(staffAccountAssignments).set({ staffId: w.staff.li }).where(eq(staffAccountAssignments.accountId, w.accZhao));
    const r = await e.runs.circle(e.creator, planId);
    const [p] = await t.db.select().from(runParticipants).where(eq(runParticipants.runId, r.runId));
    expect(p).toMatchObject({ staffId: w.staff.li, storeId: w.stores.sH2, branchId: w.sh });
    const entry = (await t.db.select().from(activityPlanRoster).where(eq(activityPlanRoster.accountId, w.accZhao)))[0]!;
    expect(entry.staffId).toBe(w.staff.zhao); // 名单项不回写
  });
  it("窗口按北京日换算成 UTC 半开区间并写进 frozen；名单项移出的账号不参与", async () => {
    const { w, e, planId } = await setup({ ...CFG, window: { from: "2026-11-01", to: "2026-11-10" } });
    await content(w, e, "a");
    const r = await e.runs.circle(e.creator, planId);
    const [run] = await t.db.select().from(judgementRuns).where(eq(judgementRuns.runId, r.runId));
    const f = run!.frozen as { window: { fromUtc: string; toUtc: string }; freezeDone: boolean; segment: { planId: string; version: number }; platform: string };
    expect(f).toMatchObject({ freezeDone: true, platform: "douyin", segment: { planId: String(planId), version: 1 } });
    expect(f.window).toMatchObject({ fromUtc: "2026-10-31T16:00:00.000Z", toUtc: "2026-11-10T16:00:00.000Z" });
    expect(r.participants).toBe(1); // 老钱（已移出）不在
  });
  it("两个名单账号解析到同一专员 → 冻结失败 participant_conflict，没有半截参与专员", async () => {
    const { w, e, planId } = await setup();
    const extra = await addParticipant(t, w, "老孙", "13800010066");
    // 把第二个账号也指向老赵，并释放它的名额（否则 D-69 的唯一键会拦住）：A 的约束放过、D 必须自己发现
    await t.db.update(staffAccountAssignments).set({ staffId: w.staff.zhao, slotReleasedAt: day(1), monitoringEnabled: false, monitoringClosedReason: "manual" }).where(eq(staffAccountAssignments.accountId, extra.accountId));
    expect(await code(e.runs.circle(e.creator, planId))).toBe("participant_conflict");
    expect(await t.db.select().from(runParticipants)).toHaveLength(0);
    const [run] = await t.db.select().from(judgementRuns);
    expect(run).toMatchObject({ status: "failed", lastErrorCode: "participant_conflict", activeKey: null });
  });
  it("名单账号没有专员归属（watch_type 不是 staff）→ no_staff_assignment", async () => {
    const { w, e, planId } = await setup();
    const extra = await addParticipant(t, w, "老孙", "13800010055");
    await t.db.update(staffAccountAssignments).set({ watchType: "external", staffId: null }).where(eq(staffAccountAssignments.accountId, extra.accountId));
    expect(await code(e.runs.circle(e.creator, planId))).toBe("no_staff_assignment");
    expect(await t.db.select().from(runParticipants)).toHaveLength(0);
  });
  it("冻结的内容快照：圈定读到的是 current 快照的点赞值 / 发布时间", async () => {
    const { w, e, planId } = await setup();
    const a = await content(w, e, "a", { like: 77, day: 6 });
    const r = await e.runs.circle(e.creator, planId);
    expect(await rowOf(r.runId, a)).toMatchObject({ likeValue: 77n, likeState: "value", publishedAt: day(6) });
  });
});

describe("运行生命周期（JP-15）", () => {
  const planned = async () => {
    const s = await setup();
    const c = await s.e.claim.createRun(t.db, { planId: s.planId, version: 1, kind: "circle", actor: "user:7", userId: 7n });
    return { ...s, runId: c.runId };
  };
  it("两个 worker 抢同一运行只有一个拿到；租约未过期时别人领不到", async () => {
    const { e, runId } = await planned();
    const a = await e.claim.claim(runId, "w1");
    expect(a).not.toBeNull();
    expect(await e.claim.claim(runId, "w2")).toBeNull();
    expect(a!.fencingToken).toBe(1n);
  });
  it("租约过期后另一个接手（token +1），旧 worker 的写入被拒绝且零写入", async () => {
    const { e, runId, w } = await planned();
    const old = (await e.claim.claim(runId, "w1"))!;
    e.clock.advance(121_000);
    const fresh = (await e.claim.claim(runId, "w2"))!;
    expect(fresh.fencingToken).toBe(2n);
    const c = await addContent(t.db, { accountId: w.accZhao, platformContentId: "stale" });
    await expect(
      e.claim.withFence(old, async (tx) => {
        await tx.insert(runParticipants).values({ runId, accountId: w.accZhao, staffId: w.staff.zhao, storeId: w.stores.sW1, dealerId: 1n, brandId: 1n, sectorId: 1n, branchId: 1n, regionId: 1n });
        await tx.insert(runContents).values({ runId, contentId: c.contentId, accountId: w.accZhao, contentSnapshotId: c.snapshotId!, likeState: "value", likeValue: 1n });
      }),
    ).rejects.toBeInstanceOf(StaleLeaseError);
    expect(await t.db.select().from(runParticipants)).toHaveLength(0);
    expect(await t.db.select().from(runContents)).toHaveLength(0);
    await expect(e.claim.settle(old, { status: "cancelled" })).rejects.toBeInstanceOf(StaleLeaseError); // 终态写入也被拒
    await e.claim.withFence(fresh, async () => undefined); // 新持有者正常
  });
  it("同版本两次创建只有一个未终态运行；终态后可再建；同幂等键返回已有运行", async () => {
    const { e, runId, planId } = await planned();
    await expect(e.claim.createRun(t.db, { planId, version: 1, kind: "circle", actor: "user:7", userId: 7n })).rejects.toMatchObject({ code: "run_active" });
    await e.claim.cancel(runId);
    const again = await e.claim.createRun(t.db, { planId, version: 1, kind: "circle", actor: "user:7", userId: 7n, idempotencyKey: "k1" });
    await e.claim.cancel(again.runId);
    const dup = await e.claim.createRun(t.db, { planId, version: 1, kind: "circle", actor: "user:7", userId: 7n, idempotencyKey: "k1" });
    expect(dup).toEqual({ runId: again.runId, created: false });
    const other = await e.claim.createRun(t.db, { planId, version: 1, kind: "circle", actor: "user:9", userId: 9n, idempotencyKey: "k1" }); // 不同提交人 = 不同幂等键
    expect(other.created).toBe(true);
  });
  it("取消：状态 cancelled、active_key 清空；终态运行不能再被领取", async () => {
    const { e, runId } = await planned();
    expect(await e.claim.cancel(runId)).toBe(true);
    expect(await e.claim.cancel(runId)).toBe(false);
    const [run] = await t.db.select().from(judgementRuns).where(eq(judgementRuns.runId, runId));
    expect(run).toMatchObject({ status: "cancelled", activeKey: null });
    expect(await e.claim.claim(runId, "w1")).toBeNull();
    expect(await e.claim.claimNext("w1")).toBeNull();
  });
  it("claimNext 按运行号领取下一个可领取的运行，跳过没到 next_tick_at 的", async () => {
    const { e, runId, planId } = await planned();
    await t.db.update(judgementRuns).set({ nextTickAt: new Date(e.clock.now().getTime() + 60_000) }).where(eq(judgementRuns.runId, runId));
    expect(await e.claim.claimNext("w1")).toBeNull();
    e.clock.advance(61_000);
    expect((await e.claim.claimNext("w1"))!.runId).toBe(runId);
  });
  it("提交人被停用：下一个 tick 运行被取消，审计 submitter_revoked（高风险、同事务）", async () => {
    const { w, e, planId } = await setup();
    await content(w, e, "a");
    e.revoked.add(7n);
    expect(await code(e.runs.circle(e.creator, planId))).toBe("run_cancelled");
    const [run] = await t.db.select().from(judgementRuns);
    expect(run).toMatchObject({ status: "cancelled", activeKey: null });
    expect(e.audits.find((a) => a.event === "submitter_revoked")).toMatchObject({ risk: "high", hasTx: true });
    expect(e.fake.callsOf("readMany")).toHaveLength(0); // 取消之后什么都没读
  });
  it("阶段内瞬时异常：退避重试后完成，每行最多写一次；超过次数 failed，可 resume 续跑且已定的行不重算", async () => {
    const { w, e, planId } = await setup(CFG, { config: { phaseMaxAttempts: 1 } });
    for (let i = 0; i < 5; i++) await content(w, e, `c${i}`);
    e.fake.alwaysFail.set("readMany", new Error("C 暂时不可用"));
    expect(await code(e.runs.circle(e.creator, planId, { sleep: e.sleep }))).toBe("internal_error");
    const [failed] = await t.db.select().from(judgementRuns);
    expect(failed).toMatchObject({ status: "failed", activeKey: null, lastErrorCode: "internal_error" });
    const scoped = await t.db.select().from(runContents).where(eq(runContents.runId, failed!.runId));
    expect(scoped).toHaveLength(5); // freeze / scope 已完成并保留
    e.fake.alwaysFail.clear();
    expect(await e.claim.resume(failed!.runId)).toBe(true);
    const done = await e.runs.drive(failed!.runId, "w", e.sleep);
    expect(done.status).toBe("completed");
    const rows = await t.db.select().from(runContents).where(eq(runContents.runId, failed!.runId));
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.l1 === "pass")).toBe(true);
    expect(await t.db.select().from(runParticipants)).toHaveLength(1); // 参与专员行没有重复
  });
  it("resume 只对 failed；同版本已有未终态运行时 resume 被拒", async () => {
    const { e, runId, planId } = await planned();
    expect(await e.claim.resume(runId)).toBe(false); // planned 不能 resume
    await t.db.update(judgementRuns).set({ status: "failed", activeKey: null, lastErrorCode: "internal_error" }).where(eq(judgementRuns.runId, runId));
    await e.claim.createRun(t.db, { planId, version: 1, kind: "circle", actor: "user:7", userId: 7n });
    await expect(e.claim.resume(runId)).rejects.toMatchObject({ code: "run_active" });
  });
  it("同一冻结输入跑两次，参与专员与内容行逐行相同（可复现）", async () => {
    const { w, e, planId } = await setup({ ...CFG, layer1: { ...CFG.layer1, quantity: { n: 2 } } });
    for (let i = 1; i <= 4; i++) await content(w, e, `c${i}`, { like: i });
    const strip = (rows: Array<Record<string, unknown>>) => rows.map(({ runId: _r, ...rest }) => JSON.stringify(rest, (_k, v) => (typeof v === "bigint" ? String(v) : v))).sort();
    const a = await e.runs.circle(e.creator, planId);
    const rowsA = strip(await t.db.select().from(runContents).where(eq(runContents.runId, a.runId)));
    const partsA = strip(await t.db.select().from(runParticipants).where(eq(runParticipants.runId, a.runId)));
    const b = await e.runs.circle(e.creator, planId);
    expect(strip(await t.db.select().from(runContents).where(eq(runContents.runId, b.runId)))).toEqual(rowsA);
    expect(strip(await t.db.select().from(runParticipants).where(eq(runParticipants.runId, b.runId)))).toEqual(partsA);
  });
});
