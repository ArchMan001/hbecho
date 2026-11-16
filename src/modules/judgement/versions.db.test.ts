// d-rule-engine 任务 4（versions）：JP-2 / JP-3 / JP-4——配置校验与失效矩阵、元素图与 elementKey、回退、新建草稿、发布协议与对账。
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { judgementPlanVersions, judgementPlans, judgementRuns, runContents, runParticipants, mediaStaff, stores, sectors, branches } from "../../db/schema";
import { useTestDb } from "../../../tests/harness/db";
import { sha } from "../../../tests/harness/factories";
import { addContent, judgementEnv, judgementWorld, type JudgementEnv, type JudgementWorld } from "../../../tests/harness/judgement";
import { JudgementError } from "./errors";
import { parseConfig } from "./config";

const t = useTestDb();
const NOW = new Date("2026-11-16T02:00:00.000Z");
const BASE = { window: { from: "2026-11-01", to: "2026-11-30" }, kinds: ["video"], layer1: { text: [{ fields: ["title"], mode: "any", keywords: ["海信"] }], quantity: { n: 3 } } };
const ab = (o: Record<string, unknown> = {}) => ({ abilityId: "a1", kind: "whole_image", target: "cover", threshold: "6.5", ...o });
const bytes = (s: string) => new Uint8Array(Buffer.from(s));
const hex = (s: string) => createHash("sha256").update(Buffer.from(s)).digest("hex");

async function setup(over: Record<string, unknown> = BASE) {
  const w = await judgementWorld(t);
  const e = judgementEnv(t, w);
  const { planId } = await e.plans.create(e.creator, { activityPlanId: w.planId, alias: "计划 A" });
  if (over) await e.versions.setConfig(e.creator, planId, over);
  return { w, e, planId };
}
const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (err) {
    return err instanceof JudgementError ? err.code : `非 JudgementError：${String(err)}`;
  }
  return "no_error";
};
const draft = async (planId: bigint) => (await t.db.select().from(judgementPlanVersions).where(and(eq(judgementPlanVersions.planId, planId), eq(judgementPlanVersions.status, "draft"))))[0]!;
const setStep = (planId: bigint, version: number, wizardStep: string) => t.db.update(judgementPlanVersions).set({ wizardStep }).where(and(eq(judgementPlanVersions.planId, planId), eq(judgementPlanVersions.version, version)));
const runCount = async (planId: bigint) => (await t.db.select().from(judgementRuns).where(eq(judgementRuns.planId, planId))).map((r) => r.runKind).sort();

/** 造一个已完成的圈定 / 试跑运行，带一个参与专员与一条内容行，用来观察失效矩阵与回退删了什么。 */
async function seedRun(w: JudgementWorld, planId: bigint, version: number, kind: "circle" | "compare", status: "completed" | "planned" = "completed"): Promise<bigint> {
  const [r] = await t.db.insert(judgementRuns).values({
    planId, version, runKind: kind, status, frozen: {}, submittedByActor: "user:7", createdAt: NOW, updatedAt: NOW, expiresAt: new Date(NOW.getTime() + 86_400_000),
    ...(status === "completed" ? { completedAt: NOW, activeKey: null } : { activeKey: sha(`k-${planId}-${version}-${kind}`) }),
  });
  const runId = BigInt(r.insertId);
  const [s] = await t.db.select().from(mediaStaff).where(eq(mediaStaff.staffId, w.staff.zhao));
  const [st] = await t.db.select().from(stores).where(eq(stores.storeId, s!.storeId));
  const [sec] = await t.db.select().from(sectors).where(eq(sectors.sectorId, st!.sectorId));
  const [br] = await t.db.select().from(branches).where(eq(branches.branchId, sec!.branchId));
  await t.db.insert(runParticipants).values({ runId, accountId: w.accZhao, staffId: w.staff.zhao, storeId: st!.storeId, dealerId: st!.dealerId, brandId: st!.brandId, sectorId: st!.sectorId, branchId: br!.branchId, regionId: br!.regionId });
  const c = await addContent(t.db, { accountId: w.accZhao, platformContentId: `c-${runId}` });
  await t.db.insert(runContents).values({ runId, contentId: c.contentId, accountId: w.accZhao, contentSnapshotId: c.snapshotId!, likeState: "value", likeValue: 1n });
  return runId;
}

describe("setConfig（JP-2）", () => {
  it("保存配置、返回哈希，并把推导出的 items 同步给 C（事务之外）", async () => {
    const { e, planId } = await setup();
    const d = await draft(planId);
    expect(parseConfig(d.config).layer1.quantity).toEqual({ n: 3 });
    expect(Buffer.from(d.configSha256)).toHaveLength(32);
    const last = e.fake.callsOf("segments.setItems").at(-1)!.args as { raw: unknown[] };
    expect(last.raw).toEqual([{ signal: "text.title_normalized" }]);
  });
  it("校验失败被拒并带问题清单：image_text（2.0）、N 没有文本 / 话题、快手 + 评论、未知字段", async () => {
    const { e, planId } = await setup();
    const bad = async (raw: unknown) => {
      try {
        await e.versions.setConfig(e.creator, planId, raw);
      } catch (err) {
        return err as JudgementError;
      }
      throw new Error("期望被拒");
    };
    expect((await bad({ ...BASE, layer2: { abilities: [ab({ kind: "image_text" })] } })).message).toContain("2.0");
    expect((await bad({ ...BASE, layer1: { quantity: { n: 3 } } })).message).toContain("数量要求");
    expect((await bad({ ...BASE, regex: "x" })).code).toBe("config_invalid");
    expect((await bad({ ...BASE, kinds: ["video", "image"], layer1: { ...BASE.layer1, duration: { minSeconds: 1 } } })).message).toContain("时长");
    expect(parseConfig((await draft(planId)).config).layer1.quantity).toEqual({ n: 3 }); // 被拒的写入没有留下痕迹
  });
  it("elementKey 不接受调用方设置：新能力带 elementKey 被清掉；已有能力沿用旧 key", async () => {
    const { e, planId } = await setup();
    await e.versions.setConfig(e.creator, planId, { ...BASE, layer2: { abilities: [ab({ kind: "image_element", elementKey: "hacker" })] } });
    expect(parseConfig((await draft(planId)).config).layer2.abilities[0]!.elementKey).toBeUndefined();
    await e.versions.putElement(e.creator, planId, "a1", bytes("img-1"));
    await e.versions.setConfig(e.creator, planId, { ...BASE, layer2: { abilities: [ab({ kind: "image_element", elementKey: "other", threshold: "7" })] } });
    expect(parseConfig((await draft(planId)).config).layer2.abilities[0]).toMatchObject({ elementKey: hex("img-1"), threshold: "7.00".replace(".00", "") });
  });
  it("缺 abilityId 时由 D 生成；非创建者不能改", async () => {
    const { e, planId } = await setup();
    await e.versions.setConfig(e.creator, planId, { ...BASE, layer2: { abilities: [{ kind: "whole_image", target: "cover", threshold: "6" }] } });
    expect(parseConfig((await draft(planId)).config).layer2.abilities[0]!.abilityId).toMatch(/^a-/);
    expect(await code(e.versions.setConfig(e.other, planId, BASE))).toBe("denied_predicate_failed");
  });
  it("没有任何要求的空草稿可保存；圈定 / 发布前才被要求", async () => {
    const { e, planId } = await setup({ window: BASE.window, kinds: ["video"] });
    expect(parseConfig((await draft(planId)).config).layer1.text).toEqual([]);
    expect(await code(e.versions.publish(e.creator, planId))).toBe("config_invalid");
  });
});

describe("失效矩阵与进度（JP-4）", () => {
  const withRuns = async () => {
    const s = await setup({ ...BASE, layer2: { abilities: [ab()] } });
    const circle = await seedRun(s.w, s.planId, 1, "circle");
    const compare = await seedRun(s.w, s.planId, 1, "compare");
    await setStep(s.planId, 1, "compared");
    return { ...s, circle, compare };
  };
  it.each([
    ["关键词与 N", { layer1: { text: [{ fields: ["title"], mode: "any", keywords: ["海信", "618"] }], quantity: { n: 3 } } }],
    ["只改数量 N", { layer1: { ...BASE.layer1, quantity: { n: 4 } } }],
  ])("改%s → 圈定与试跑结果及其行全部删除，进度回到 draft", async (_name, edit) => {
    const { e, planId } = await withRuns();
    const r = await e.versions.setConfig(e.creator, planId, { ...BASE, layer2: { abilities: [ab()] }, ...edit });
    expect(r.invalidation).toBe("circle_and_trial");
    expect(await runCount(planId)).toEqual([]);
    expect(await t.db.select().from(runContents)).toHaveLength(0);
    expect(await t.db.select().from(runParticipants)).toHaveLength(0);
    expect((await draft(planId)).wizardStep).toBe("draft");
  });
  it("删掉最后一个文本项（连同 N）→ 圈定与试跑都失效", async () => {
    const { e, planId } = await withRuns();
    expect((await e.versions.setConfig(e.creator, planId, { ...BASE, layer1: { text: [] }, layer2: { abilities: [ab()] } })).invalidation).toBe("circle_and_trial");
  });
  it("改第 2 层能力结构 → 只删试跑，进度回到 circled；圈定保留", async () => {
    const { e, planId } = await withRuns();
    const r = await e.versions.setConfig(e.creator, planId, { ...BASE, layer2: { abilities: [ab(), ab({ abilityId: "a2", target: "avatar" })] } });
    expect(r.invalidation).toBe("trial");
    expect(await runCount(planId)).toEqual(["circle"]);
    expect((await draft(planId)).wizardStep).toBe("circled");
  });
  it("只改能力别名 / 阈值 / 评论要求 / ASR → 什么都不失效，进度不变，别名不改哈希", async () => {
    const { e, planId } = await withRuns();
    const before = Buffer.from((await draft(planId)).configSha256).toString("hex");
    const r1 = await e.versions.setConfig(e.creator, planId, { ...BASE, layer1: { text: [{ alias: "主推文本", ...BASE.layer1.text[0] }], quantity: { n: 3 } }, layer2: { abilities: [ab({ alias: "封面" })] } });
    expect(r1.invalidation).toBe("none");
    expect(r1.configSha256).toBe(before);
    const r2 = await e.versions.setConfig(e.creator, planId, { ...BASE, layer2: { abilities: [ab({ threshold: "9" })] }, commentRequirement: { mode: "any", keywords: ["安装"], method: { type: "any" } }, contentRequirement: { layer3: { standardText: "t" } } });
    expect(r2.invalidation).toBe("none");
    expect(r2.configSha256).not.toBe(before); // 阈值进哈希
    expect(await runCount(planId)).toEqual(["circle", "compare"]);
    expect((await draft(planId)).wizardStep).toBe("compared");
  });
  it("有在途的圈定 / 试跑时不能改会使它失效的配置", async () => {
    const { w, e, planId } = await setup();
    await seedRun(w, planId, 1, "circle", "planned");
    expect(await code(e.versions.setConfig(e.creator, planId, { ...BASE, layer1: { ...BASE.layer1, quantity: { n: 9 } } }))).toBe("run_active");
    expect((await e.versions.setConfig(e.creator, planId, { ...BASE, layer1: { text: [{ alias: "只改别名", ...BASE.layer1.text[0] }], quantity: { n: 3 } } })).invalidation).toBe("none");
  });
});

describe("元素图与标准图", () => {
  const elem = async () => setup({ ...BASE, layer2: { abilities: [ab({ kind: "image_element" }), ab({ abilityId: "a2", kind: "image_element", target: "avatar" })] } });
  it("上传：字节 SHA-256 作 elementKey 写进能力；C 收到该 key；试跑作废", async () => {
    const { w, e, planId } = await elem();
    await seedRun(w, planId, 1, "compare");
    await setStep(planId, 1, "compared");
    const r = await e.versions.putElement(e.creator, planId, "a1", bytes("img-1"));
    expect(r.elementKey).toBe(hex("img-1"));
    expect(r.elementKey).toMatch(/^[A-Za-z0-9_.-]{1,64}$/);
    expect(parseConfig((await draft(planId)).config).layer2.abilities[0]!.elementKey).toBe(r.elementKey);
    expect((e.fake.callsOf("segments.putImage").at(-1)!.args as { key: { elementKey: string; kind: string } }).key).toMatchObject({ kind: "element", elementKey: r.elementKey });
    expect(await runCount(planId)).toEqual([]);
    expect((await draft(planId)).wizardStep).toBe("circled");
    expect((e.fake.callsOf("segments.setItems").at(-1)!.args as { raw: unknown[] }).raw).toContainEqual({ signal: "content.cover_element_score", element_key: r.elementKey });
  });
  it("换图换 key、旧图行被删；同一图片重复上传是空操作；同 target 另一能力用相同字节被拒", async () => {
    const { e, planId } = await elem();
    const k1 = (await e.versions.putElement(e.creator, planId, "a1", bytes("img-1"))).elementKey;
    expect((await e.versions.putElement(e.creator, planId, "a1", bytes("img-1"))).elementKey).toBe(k1);
    expect(e.fake.segs.get(`${planId}:1`)!.images.has(`element/cover/${k1}`)).toBe(true); // 重复上传不能把刚上传的图删掉
    expect(e.fake.callsOf("segments.putImage")).toHaveLength(1);
    const k2 = (await e.versions.putElement(e.creator, planId, "a1", bytes("img-2"))).elementKey;
    expect(k2).not.toBe(k1);
    const removed = e.fake.callsOf("segments.removeImage").map((c) => (c.args as { key: { elementKey: string } }).key.elementKey);
    expect(removed).toContain(k1);
    // 同 target（cover）再加一个元素能力，用与 a1 相同的字节
    await e.versions.setConfig(e.creator, planId, { ...BASE, layer2: { abilities: [ab({ kind: "image_element" }), ab({ abilityId: "a3", kind: "image_element" }), ab({ abilityId: "a2", kind: "image_element", target: "avatar" })] } });
    expect(await code(e.versions.putElement(e.creator, planId, "a3", bytes("img-2")))).toBe("element_duplicate");
    await e.versions.putElement(e.creator, planId, "a2", bytes("img-2")); // 不同 target 可以
  });
  it("空图片、能力种类不符、不存在的能力", async () => {
    const { e, planId } = await elem();
    expect(await code(e.versions.putElement(e.creator, planId, "a1", new Uint8Array()))).toBe("image_empty");
    expect(await code(e.versions.putTemplate(e.creator, planId, "a1", bytes("x")))).toBe("ability_kind_mismatch");
    expect(await code(e.versions.putElement(e.creator, planId, "nope", bytes("x")))).toBe("ability_not_found");
  });
  it("整张图片对比的标准图：按 target 覆盖，图片字节变了试跑作废；删除能力时 C 的图一并清掉", async () => {
    const { w, e, planId } = await setup({ ...BASE, layer2: { abilities: [ab()] } });
    await seedRun(w, planId, 1, "compare");
    await setStep(planId, 1, "compared");
    await e.versions.putTemplate(e.creator, planId, "a1", bytes("std-1"));
    expect(await runCount(planId)).toEqual([]);
    expect((e.fake.callsOf("segments.putImage").at(-1)!.args as { key: { kind: string; target: string } }).key).toMatchObject({ kind: "template", target: "cover" });
    await e.versions.setConfig(e.creator, planId, { ...BASE, layer2: { abilities: [] } });
    expect(e.fake.callsOf("segments.removeImage").some((c) => (c.args as { key: { kind: string } }).key.kind === "template")).toBe(true);
  });
  it("removeImage 清掉元素图与能力的 elementKey；发布前缺 key 的元素能力被挡住", async () => {
    const { e, planId } = await elem();
    await e.versions.putElement(e.creator, planId, "a1", bytes("img-1"));
    await e.versions.removeImage(e.creator, planId, "a1");
    expect(parseConfig((await draft(planId)).config).layer2.abilities[0]!.elementKey).toBeUndefined();
    await setStep(planId, 1, "compared");
    expect(await code(e.versions.publish(e.creator, planId))).toBe("image_missing");
  });
  it("reconcileDraft：C 有而配置无的元素图删掉；配置有而 C 无的 key 清掉（上传两步之间崩溃的善后）", async () => {
    const { e, planId } = await elem();
    const actor = { actor: "x", capabilities: new Set<string>(), brandScope: "all" as const };
    await e.fake.segments.putImage(actor, { planId, version: 1, kind: "element", target: "cover", elementKey: "orphan" }, bytes("o"));
    const k = (await e.versions.putElement(e.creator, planId, "a2", bytes("img-9"))).elementKey;
    e.fake.segs.get(`${planId}:1`)!.images.delete(`element/avatar/${k}`); // C 侧丢了
    const r = await e.versions.reconcileDraft(e.creator, planId);
    expect(r).toEqual({ removedOrphans: 1, clearedKeys: 1 });
    expect(parseConfig((await draft(planId)).config).layer2.abilities.find((a) => a.abilityId === "a2")!.elementKey).toBeUndefined();
  });
});

describe("回退（JP-4）", () => {
  it("预览不改任何表；--apply 一次只退一层并删除后续运行与行；不能跳层", async () => {
    const { w, e, planId } = await setup();
    await seedRun(w, planId, 1, "circle");
    await seedRun(w, planId, 1, "compare");
    await setStep(planId, 1, "compared");
    const p = await e.versions.rollback(e.creator, planId, { apply: false });
    expect(p).toMatchObject({ from: "compared", to: "circled", applied: false, runs: 1 });
    expect(await runCount(planId)).toEqual(["circle", "compare"]);
    expect((await draft(planId)).wizardStep).toBe("compared");
    const a = await e.versions.rollback(e.creator, planId, { apply: true });
    expect(a).toMatchObject({ to: "circled", applied: true, runs: 1 });
    expect(await runCount(planId)).toEqual(["circle"]);
    expect((await draft(planId)).wizardStep).toBe("circled");
    const b = await e.versions.rollback(e.creator, planId, { apply: true });
    expect(b.to).toBe("draft");
    expect(await runCount(planId)).toEqual([]);
    expect(await t.db.select().from(runContents)).toHaveLength(0);
    expect(await code(e.versions.rollback(e.creator, planId, { apply: true }))).toBe("nothing_to_rollback");
    expect(e.audits.filter((x) => x.event === "rollback_applied").every((x) => x.risk === "high" && x.hasTx)).toBe(true);
  });
  it("有在途运行时不能回退；已发布版本不能回退，提示新建草稿", async () => {
    const { w, e, planId } = await setup();
    await seedRun(w, planId, 1, "circle", "planned");
    await setStep(planId, 1, "circled");
    expect(await code(e.versions.rollback(e.creator, planId, { apply: true }))).toBe("run_active");
    await t.db.delete(runContents);
    await t.db.delete(runParticipants);
    await t.db.delete(judgementRuns);
    await setStep(planId, 1, "circled");
    await e.versions.publish(e.creator, planId);
    expect(await code(e.versions.rollback(e.creator, planId, { apply: true }))).toBe("version_immutable");
  });
});

describe("发布与新建草稿（JP-3）", () => {
  it("发布：C 发布 → D 置 published；写配置 / 写图片被拒（version_immutable）；高风险审计与业务写入同事务", async () => {
    const { e, planId } = await setup();
    await setStep(planId, 1, "circled");
    expect(await e.versions.publish(e.creator, planId)).toEqual({ version: 1 });
    const [v] = await t.db.select().from(judgementPlanVersions).where(eq(judgementPlanVersions.planId, planId));
    expect(v).toMatchObject({ status: "published", publishedByActor: "user:7" });
    expect(e.fake.segs.get(`${planId}:1`)!.status).toBe("published");
    expect(await code(e.versions.setConfig(e.creator, planId, BASE))).toBe("version_immutable");
    expect(await code(e.versions.putTemplate(e.creator, planId, "a1", bytes("x")))).toBe("version_immutable");
    const pub = e.audits.find((a) => a.event === "version_published")!;
    expect(pub).toMatchObject({ risk: "high", hasTx: true });
  });
  it("向导进度不够被拒：还没圈定", async () => {
    const a = await setup();
    expect(await code(a.e.versions.publish(a.e.creator, a.planId))).toBe("wizard_step_required");
  });
  it("第 2 页有能力要试跑过才能发布；没有能力则圈定后即可", async () => {
    const b = await setup({ ...BASE, layer2: { abilities: [ab()] } });
    await b.e.versions.putTemplate(b.e.creator, b.planId, "a1", bytes("std"));
    await setStep(b.planId, 1, "circled");
    expect(await code(b.e.versions.publish(b.e.creator, b.planId))).toBe("wizard_step_required");
    await setStep(b.planId, 1, "compared");
    await b.e.versions.publish(b.e.creator, b.planId);
  });
  it("不可执行（如 ASR 能力未启用）：发布被拒并列出阻塞项；D 草稿与 C 均未变", async () => {
    const { e, planId } = await setup({ ...BASE, contentRequirement: { layer3: { standardText: "口播提到海信" } } });
    await setStep(planId, 1, "circled");
    e.fake.blockers = [{ code: "capability_disabled", signal: "content.asr_judgement" }];
    let err: JudgementError | undefined;
    try {
      await e.versions.publish(e.creator, planId);
    } catch (x) {
      err = x as JudgementError;
    }
    expect(err!.code).toBe("not_executable");
    expect((err!.detail as { blockers: Array<{ code: string }> }).blockers[0]!.code).toBe("capability_disabled");
    expect((await draft(planId)).status).toBe("draft");
    expect(e.fake.segs.get(`${planId}:1`)!.status).toBe("draft");
    expect(e.fake.callsOf("segments.publish")).toHaveLength(0);
  });
  it("C 在 publish 时才拒绝：D 回到 draft 并带阻塞项", async () => {
    const { e, planId } = await setup();
    await setStep(planId, 1, "circled");
    e.fake.failNext = { fn: "segments.publish", error: new (await import("../signals/errors")).SignalError("conflict", "not_executable", "不可执行", [{ code: "capability_disabled" }]) };
    expect(await code(e.versions.publish(e.creator, planId))).toBe("not_executable");
    expect((await draft(planId)).status).toBe("draft");
  });
  it("发布前会把 deriveItems 再同步给 C（setConfig 之后的 setItems 失败过也不会带上线）", async () => {
    const { e, planId } = await setup();
    await setStep(planId, 1, "circled");
    e.fake.segs.get(`${planId}:1`)!.items = []; // C 侧落后
    await e.versions.publish(e.creator, planId);
    expect(e.fake.segs.get(`${planId}:1`)!.items).toEqual([{ signal: "text.title_normalized" }]);
  });
  it("onPublished 与「置 published」同一事务：钩子抛错则整笔回滚（版本仍是 publishing，可对账）", async () => {
    const { e, planId } = await setup();
    await setStep(planId, 1, "circled");
    await expect(e.versions.publish(e.creator, planId, { onPublished: async () => { throw new Error("建执行失败"); } })).rejects.toThrow("建执行失败");
    expect((await t.db.select().from(judgementPlanVersions))[0]!.status).toBe("publishing");
    expect(e.fake.segs.get(`${planId}:1`)!.status).toBe("published"); // C 已发布，D 未置位
    expect(await e.versions.reconcilePublishing(e.creator, planId)).toEqual({ state: "published" }); // 以 C 为准补完
    expect((await t.db.select().from(judgementPlanVersions))[0]!.status).toBe("published");
    expect(await e.versions.reconcilePublishing(e.creator, planId)).toEqual({ state: "none" });
  });
  it("对账 publishing：C 仍是草稿 → 回到 draft", async () => {
    const { e, planId } = await setup();
    await t.db.update(judgementPlanVersions).set({ status: "publishing" }).where(eq(judgementPlanVersions.planId, planId));
    expect(await e.versions.reconcilePublishing(e.creator, planId)).toEqual({ state: "reverted" });
    expect((await t.db.select().from(judgementPlanVersions))[0]!.status).toBe("draft");
  });
  it("非活动计划创建者的 hq_manager 不能发布", async () => {
    const { e, planId } = await setup();
    await setStep(planId, 1, "circled");
    expect(await code(e.versions.publish(e.other, planId))).toBe("denied_predicate_failed");
  });

  const published = async () => {
    const s = await setup();
    await setStep(s.planId, 1, "circled");
    await s.e.versions.publish(s.e.creator, s.planId);
    return s;
  };
  it("新建草稿：版本 +1、复制来源配置、based_on_version 记来源；plans.latest_version 同步；旧版本仍可读", async () => {
    const { e, planId } = await published();
    expect(await e.versions.newDraft(e.creator, planId)).toEqual({ version: 2 });
    const d = await draft(planId);
    expect(d).toMatchObject({ version: 2, basedOnVersion: 1, wizardStep: "draft" });
    expect(parseConfig(d.config)).toEqual(parseConfig((await e.versions.versionOf(planId, 1))!.config));
    expect((await t.db.select().from(judgementPlans).where(eq(judgementPlans.planId, planId)))[0]!.latestVersion).toBe(2);
    expect((await e.versions.showConfig(e.creator, planId, 1)).status).toBe("published");
  });
  it("草稿存在时再新建被拒；归档的计划被拒；来源可以是任意已发布版本", async () => {
    const { e, planId } = await published();
    await e.versions.newDraft(e.creator, planId);
    expect(await code(e.versions.newDraft(e.creator, planId))).toBe("draft_exists");
    await setStep(planId, 2, "circled");
    await e.versions.setConfig(e.creator, planId, { ...BASE, layer1: { ...BASE.layer1, quantity: { n: 5 } } });
    await setStep(planId, 2, "circled");
    await e.versions.publish(e.creator, planId);
    await e.plans.archive(e.creator, planId);
    expect(await code(e.versions.newDraft(e.creator, planId))).toBe("plan_archived");
    await e.plans.unarchive(e.creator, planId);
    expect(await e.versions.newDraft(e.creator, planId, 1)).toEqual({ version: 3 });
    expect(parseConfig((await draft(planId)).config).layer1.quantity).toEqual({ n: 3 }); // 取自 v1，不是最新的 v2
    expect(await code(e.versions.newDraft(e.creator, planId, 9))).toBe("draft_exists");
  });
  it("版本号与 C 不一致 → version_mismatch 并停止，不静默对齐", async () => {
    const { e, planId } = await published();
    e.fake.segs.set(`${planId}:3`, { platform: "douyin", status: "draft", items: [], images: new Map() }); // C 侧凭空多了 v3
    expect(await code(e.versions.newDraft(e.creator, planId))).toBe("version_mismatch");
    expect(await t.db.select().from(judgementPlanVersions).where(eq(judgementPlanVersions.version, 2))).toHaveLength(0);
  });
  it("上次 C 已建 v2、D 未落行就崩溃：再次新建采用 C 里的 v2，不再建 v3", async () => {
    const { e, planId } = await published();
    e.fake.failNext = null;
    await e.fake.segments.newDraft({ actor: "x", capabilities: new Set(), brandScope: "all" }, { planId, fromVersion: 1 }); // C 已有 v2
    expect(await e.versions.newDraft(e.creator, planId)).toEqual({ version: 2 });
    expect(e.fake.segs.has(`${planId}:3`)).toBe(false);
  });
  it("任意时刻 D 与 C 的版本号逐版本相等；同一计划两个草稿被数据库拒绝", async () => {
    const { e, planId } = await published();
    await e.versions.newDraft(e.creator, planId);
    const dv = (await t.db.select().from(judgementPlanVersions).where(eq(judgementPlanVersions.planId, planId))).map((v) => v.version).sort();
    const cv = [...e.fake.segs.keys()].filter((k) => k.startsWith(`${planId}:`)).map((k) => Number(k.split(":")[1])).sort();
    expect(dv).toEqual(cv);
  });
});
