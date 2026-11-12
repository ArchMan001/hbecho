// requestScores / executability 的 only（D 按层请求的付费边界）：只处理、只检查指定信号，其余信号一个任务都不建、一个缺口都不算。
import { describe, expect, it } from "vitest";
import { signalTasks } from "../../db/schema";
import { useTestDb } from "../../../tests/harness/db";
import { FakeAiGateway, insertAvailableAsset, insertMediaReference } from "../../../tests/harness/signals";
import { actor, content, createWorld, makeSubject, png, taskCount } from "../../../tests/harness/signals-world";

const t = useTestDb();
const COVER = "content.cover_template_score";
const JUDGE = "content.asr_judgement";
const kinds = async () => (await t.db.select({ kind: signalTasks.kind }).from(signalTasks)).map((r) => r.kind).sort();

/** 计划 2:封面比对 + ASR 判定(付费)。主体有已归档的封面和音频。 */
async function setup(gateway = new FakeAiGateway()) {
  const w = await createWorld(t, { gateway });
  const plan = { planId: 2n, version: 1 };
  await w.signals.segments.create(actor, { planId: 2n, platform: "douyin" });
  await w.signals.segments.setItems(actor, plan, [{ signal: COVER }, { signal: JUDGE, standard_text: "介绍保修政策" }]);
  await w.signals.segments.putImage(actor, { ...plan, kind: "template", target: "cover" }, png("only-standard"));
  const subjects = [];
  for (let i = 0; i < 3; i++) {
    const s = await makeSubject(t, "archived");
    const audio = await insertAvailableAsset(t.db, { key: `media/only-au${i}`, hex: `only-audio-${i}` });
    await insertMediaReference(t.db, { contentSnapshotId: s.snapshotId, role: "audio", status: "archived", mediaAssetId: audio });
    subjects.push(content(s.id));
  }
  return { w, gateway, plan, subjects };
}

describe("only：本次只补算指定信号", () => {
  it("不传 only:封面与判定都建任务(行为不变);传 only=[封面]:只建封面任务,判定(付费)一个都不建", async () => {
    const all = await setup();
    await all.w.signals.requestScores(actor, all.plan, all.subjects);
    expect(await kinds()).toEqual(["asr_judgement", "asr_judgement", "asr_judgement", "score_template", "score_template", "score_template"]);
  });

  it("only=[封面]", async () => {
    const { w, plan, subjects } = await setup();
    const r = await w.signals.requestScores(actor, plan, subjects, { only: [COVER] });
    expect(await kinds()).toEqual(["score_template", "score_template", "score_template"]);
    expect(r.items.map((i) => i.signal)).toEqual([COVER]);
    expect(r.tasks.created).toBe(3);
    // 之后第 3 层再单独请求判定:只多出判定任务,封面任务不重复
    const r3 = await w.signals.requestScores(actor, plan, subjects, { only: [JUDGE] });
    expect(r3.items.map((i) => i.signal)).toEqual([JUDGE]);
    expect(await kinds()).toEqual(["asr_judgement", "asr_judgement", "asr_judgement", "score_template", "score_template", "score_template"]);
  });

  it("参数检查:空数组被拒;目录外的键 signal_unregistered;目录里有但监控段没配的键不报错也不建任务", async () => {
    const { w, plan, subjects } = await setup();
    await expect(w.signals.requestScores(actor, plan, subjects, { only: [] })).rejects.toMatchObject({ code: "only_empty" });
    await expect(w.signals.requestScores(actor, plan, subjects, { only: ["content.cover_ocr_text"] })).rejects.toMatchObject({ code: "signal_unregistered" });
    const r = await w.signals.requestScores(actor, plan, subjects, { only: ["account.bg_template_score"] });
    expect(r.items).toEqual([]);
    expect(await taskCount(t)).toBe(0);
  });
});

describe("only:可执行性只看指定信号", () => {
  it("判定模型中途丢失:整段不可执行(默认行为不变),但 only=[封面] 的请求与检查不受影响", async () => {
    const { w, gateway, plan, subjects } = await setup();
    gateway.models.judge = null;
    expect((await w.signals.segments.executability(actor, plan)).blockers).toEqual([{ code: "model_unavailable", signal: JUDGE, detail: "judge" }]);
    await expect(w.signals.requestScores(actor, plan, subjects)).rejects.toMatchObject({ code: "not_executable" });
    expect(await w.signals.segments.executability(actor, plan, { only: [COVER] })).toEqual({ executable: true, blockers: [] });
    const r = await w.signals.requestScores(actor, plan, subjects, { only: [COVER] });
    expect(r.tasks.created).toBe(3);
    // 反过来:只看判定时,阻塞项只有判定自己的
    expect((await w.signals.segments.executability(actor, plan, { only: [JUDGE] })).blockers).toEqual([{ code: "model_unavailable", signal: JUDGE, detail: "judge" }]);
    await expect(w.signals.requestScores(actor, plan, subjects, { only: [JUDGE] })).rejects.toMatchObject({ code: "not_executable" });
  });

  it("封面标准图缺失:整段不可执行,但 only=[判定] 可执行(第 2 层图片能力的缺口不误伤第 3 层)", async () => {
    const { w, plan } = await setup();
    await w.signals.segments.removeImage(actor, { ...plan, kind: "template", target: "cover" });
    expect((await w.signals.segments.executability(actor, plan)).blockers).toEqual([{ code: "image_missing", signal: COVER }]);
    expect(await w.signals.segments.executability(actor, plan, { only: [JUDGE] })).toEqual({ executable: true, blockers: [] });
  });

  it("executability 的 only 同样做参数检查,且仍先于读库做授权", async () => {
    const { w, plan } = await setup();
    await expect(w.signals.segments.executability(actor, plan, { only: [] })).rejects.toMatchObject({ code: "only_empty" });
    const nobody = { ...actor, capabilities: new Set<string>() };
    await expect(w.signals.segments.executability(nobody, plan, { only: [COVER] })).rejects.toMatchObject({ code: "forbidden" });
    await expect(w.signals.requestScores(nobody, plan, [], { only: [COVER] })).rejects.toMatchObject({ code: "forbidden" });
  });
});
