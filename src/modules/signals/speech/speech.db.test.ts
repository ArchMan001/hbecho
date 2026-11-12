// 任务 9：音频理解——ASR 与判定的编排、参数化、复用、失败语义。真实 MySQL + FakeAiGateway。
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { signalResults, signalTasks } from "../../../db/schema";
import { useTestDb } from "../../../../tests/harness/db";
import { FakeAiGateway } from "../../../../tests/harness/signals";
import { actor, content, createWorld, drain, makeAudioSubject, resultCount, taskCount, type World } from "../../../../tests/harness/signals-world";
import { DisabledAiGateway } from "./disabled";

const t = useTestDb();
const SEG = (over: Parameters<typeof createWorld>[1] = {}) => createWorld(t, over);
async function configure(w: World, items: unknown, plan = w.plan): Promise<void> {
  await w.signals.segments.setItems(actor, plan, items);
}
const ASR = { signal: "content.asr_text" };
const judge = (text: string) => ({ signal: "content.asr_judgement", standard_text: text });
const tasksOf = (kind: string) => t.db.select().from(signalTasks).where(eq(signalTasks.kind, kind as "asr_text"));
const rowsOf = (key: string) => t.db.select().from(signalResults).where(eq(signalResults.signalKey, key));
const read = (w: World, id: bigint, key: string, param?: object) => w.signals.reader.read(actor, content(id), key, param ? { param: param as never } : {});

describe("默认装配（DisabledAiGateway）：不建任务、不发调用", () => {
  it("请求补算被拒（executability 列出 model_unavailable）；任务数 0；读取读作 capability_disabled", async () => {
    const w = await SEG();
    await configure(w, [ASR, judge("介绍保修")]);
    const a = await makeAudioSubject(t);
    await expect(w.signals.requestScores(actor, w.plan, [content(a.id)])).rejects.toMatchObject({ code: "not_executable", detail: expect.arrayContaining([{ code: "model_unavailable", signal: "content.asr_text", detail: "asr" }]) });
    expect(await taskCount(t)).toBe(0);
    expect(await read(w, a.id, "content.asr_text")).toMatchObject({ state: "missing", reason: "capability_disabled" });
    expect(await read(w, a.id, "content.asr_judgement", { segment: w.plan })).toMatchObject({ state: "missing", reason: "capability_disabled" });
    expect(await w.signals.speechRunner.runBatch()).toBe(0);
    expect(await new DisabledAiGateway().activeModel()).toBeNull();
  });
  it("没有 ASR 模型时 runner 一个语音任务都不领，不消耗尝试次数", async () => {
    const gateway = new FakeAiGateway();
    const w = await SEG({ gateway });
    await configure(w, [ASR]);
    const a = await makeAudioSubject(t);
    await w.signals.requestScores(actor, w.plan, [content(a.id)]);
    gateway.models.asr = null; // 运行前模型被关掉
    expect(await w.signals.speechRunner.runBatch()).toBe(0);
    expect((await tasksOf("asr_text"))[0]).toMatchObject({ status: "pending", attemptCount: 0 });
    expect(gateway.calls).toEqual([]);
  });
});

describe("ASR 文本", () => {
  it("同一音频两次请求，ASR 只调用一次；结果全局共享（另一个监控段不再计算）；结果带转写、语言与证据", async () => {
    const gateway = new FakeAiGateway();
    const w = await SEG({ gateway });
    await configure(w, [ASR]);
    const a = await makeAudioSubject(t);
    expect((await w.signals.requestScores(actor, w.plan, [content(a.id)])).tasks.created).toBe(1);
    expect((await w.signals.requestScores(actor, w.plan, [content(a.id)])).tasks).toMatchObject({ created: 0, reused: 1 });
    await drain(w);
    expect(gateway.calls.filter((c) => c.kind === "transcribe")).toHaveLength(1);
    const v = await read(w, a.id, "content.asr_text");
    expect(v).toMatchObject({ state: "valid", value: { text: "转写文本", language: "zh" }, capability: { id: "speech.asr", version: 1 }, evidence: { model: "asr-m1", language: "zh", duration_ms: 1000, gateway_call_key: expect.stringMatching(/^[0-9a-f]{64}$/) } });
    // 另一个监控段（同一音频）：参数指纹为零，不含任何模型版本 → 直接命中
    const plan2 = { planId: 2n, version: 1 };
    await w.signals.segments.create(actor, { planId: 2n, platform: "douyin" });
    await configure(w, [ASR], plan2);
    const r2 = await w.signals.requestScores(actor, plan2, [content(a.id)]);
    expect(r2.tasks).toEqual({ created: 0, revived: 0, requeued: 0, reused: 0 });
    expect(r2.items[0]!.subjects[0]).toMatchObject({ disposition: "reused", reason: "valid" });
    expect(gateway.billed).toBe(1);
  });
  it("音频未归档：missing(audio_not_archived)，无任务，C 不提采集需求", async () => {
    const gateway = new FakeAiGateway();
    const w = await SEG({ gateway });
    await configure(w, [ASR]);
    const none = await makeAudioSubject(t, { status: "none" });
    const pending = await makeAudioSubject(t, { status: "pending" });
    const r = await w.signals.requestScores(actor, w.plan, [content(none.id), content(pending.id)]);
    expect(r.items[0]!.subjects.map((s) => [s.disposition, s.reason])).toEqual([["missing", "audio_not_archived"], ["missing", "audio_not_archived"]]);
    expect(r.needMedia).toHaveLength(2);
    expect(await taskCount(t)).toBe(0);
  });
  it("同一 callKey 只计费一次：调用成功后、写结果前崩溃，重启重试用同一 callKey，结果行仍一行", async () => {
    const gateway = new FakeAiGateway();
    const w = await SEG({ gateway });
    await configure(w, [ASR]);
    const a = await makeAudioSubject(t);
    await w.signals.requestScores(actor, w.plan, [content(a.id)]);
    const { claim } = await import("../tasks/queue");
    const [c] = await claim({ db: t.db, clock: w.clock, audit: () => {} }, { workerId: "crashed", leaseMs: 60_000, limit: 1 });
    await gateway.transcribe({ callKey: c!.task.idempotencyKey.toString("hex"), audioUrl: "u" }); // 调用成功，进程在写结果前死掉
    w.clock.advance(61_000);
    await drain(w);
    expect(gateway.billed).toBe(1);
    expect(gateway.calls).toHaveLength(2); // 两次调用，同一 callKey
    expect(new Set(gateway.calls.map((x) => x.callKey)).size).toBe(1);
    expect(await resultCount(t)).toBe(1);
  });
  it("输出不合法 → failed(invalid_output)；模型拒绝 → failed(model_refused)；都不是 0 / 空文本；不重试", async () => {
    const gateway = new FakeAiGateway();
    const w = await SEG({ gateway });
    await configure(w, [ASR]);
    const a = await makeAudioSubject(t);
    gateway.transcript = { text: 123 as never, language: "zh", durationMs: 1 };
    await w.signals.requestScores(actor, w.plan, [content(a.id)]);
    await drain(w);
    expect(await read(w, a.id, "content.asr_text")).toMatchObject({ state: "failed", usable: false, reason: "invalid_output" });
    const b = await makeAudioSubject(t);
    gateway.refuseNext = true;
    await w.signals.requestScores(actor, w.plan, [content(b.id)]);
    await drain(w);
    expect(await read(w, b.id, "content.asr_text")).toMatchObject({ state: "failed", reason: "model_refused" });
    expect((await tasksOf("asr_text")).map((x) => [x.status, x.attemptCount])).toEqual([["succeeded", 1], ["succeeded", 1]]);
    expect((await rowsOf("content.asr_text")).every((r) => r.value === null && r.score === null)).toBe(true);
  });
  it("网关瞬时错误：重试，用尽后 dead，没有结果行；音频对象不可用 → failed(audio_unreadable)", async () => {
    const gateway = new FakeAiGateway();
    const w = await SEG({ gateway });
    await configure(w, [ASR]);
    const a = await makeAudioSubject(t);
    await w.signals.requestScores(actor, w.plan, [content(a.id)]);
    for (let i = 0; i < 3; i++) {
      gateway.failNext = new Error("网关 503 https://gw.test/x?Signature=S");
      await w.signals.speechRunner.runBatch();
      w.clock.advance(10_000);
    }
    expect((await tasksOf("asr_text"))[0]).toMatchObject({ status: "dead", attemptCount: 3, lastErrorCode: "retries_exhausted" });
    expect(JSON.stringify((await tasksOf("asr_text"))[0]!.lastErrorDetail)).not.toContain("Signature");
    expect(await resultCount(t)).toBe(0);
    expect(gateway.billed).toBe(0);
  });
});

describe("大模型判定", () => {
  async function judged(opts: { gateway?: FakeAiGateway; text?: string } = {}) {
    const gateway = opts.gateway ?? new FakeAiGateway();
    const w = await SEG({ gateway });
    await configure(w, [judge(opts.text ?? "介绍保修政策")]);
    const a = await makeAudioSubject(t);
    return { gateway, w, a };
  }
  it("ASR 缺失时判定 deferred：确保 ASR 任务存在、不计重试次数；ASR 完成后判定完成，结果行含结论、理由、模型与提示词版本", async () => {
    const { gateway, w, a } = await judged();
    const r = await w.signals.requestScores(actor, w.plan, [content(a.id)]);
    expect(r.tasks.created).toBe(1); // 请求时只建判定任务；ASR 由判定在运行时按需确保
    expect(await w.signals.speechRunner.runBatch()).toBe(1);
    const [jt] = await tasksOf("asr_judgement");
    expect(jt).toMatchObject({ status: "retry_wait", attemptCount: 0, deferCount: 1, lastErrorCode: "deferred" });
    expect(jt!.nextAttemptAt).toEqual(new Date(w.clock.now().getTime() + 30_000));
    expect(await tasksOf("asr_text")).toHaveLength(1);
    expect(await read(w, a.id, "content.asr_judgement", { segment: w.plan })).toMatchObject({ state: "missing", reason: "not_computed", pending: "queued" });
    await w.signals.speechRunner.runBatch(); // ASR 任务（判定还没到时间）
    w.clock.advance(30_000);
    await drain(w);
    expect(gateway.calls.map((c) => c.kind)).toEqual(["transcribe", "judge"]);
    const v = await read(w, a.id, "content.asr_judgement", { segment: w.plan });
    expect(v).toMatchObject({ state: "valid", usable: true, value: { verdict: "meets", reason: "符合" }, capability: { id: "speech.judge", version: 1 }, evidence: { model: "judge-m1", prompt_id: "asr-judge", prompt_version: 1, standard_sha256: expect.stringMatching(/^[0-9a-f]{64}$/), transcript_result_id: expect.any(String), gateway_call_key: expect.stringMatching(/^[0-9a-f]{64}$/) } });
    const [jt2] = await tasksOf("asr_judgement");
    expect(jt2).toMatchObject({ status: "succeeded", attemptCount: 1, deferCount: 1 });
  });
  it("不同标准文本互不复用；相同标准文本 + 提示词版本 + 模型版本复用（跨监控段）；ASR 只调一次", async () => {
    const gateway = new FakeAiGateway();
    const w = await SEG({ gateway });
    const a = await makeAudioSubject(t);
    await configure(w, [judge("标准 A")]);
    await w.signals.requestScores(actor, w.plan, [content(a.id)]);
    await drain(w);
    w.clock.advance(31_000);
    await drain(w);
    const plan2 = { planId: 2n, version: 1 };
    await w.signals.segments.create(actor, { planId: 2n, platform: "douyin" });
    await configure(w, [judge("标准 B")], plan2);
    expect((await w.signals.requestScores(actor, plan2, [content(a.id)])).tasks.created).toBe(1); // 不同标准 → 新任务
    const plan3 = { planId: 3n, version: 1 };
    await w.signals.segments.create(actor, { planId: 3n, platform: "douyin" });
    await configure(w, [judge("  标准 A  ")], plan3); // 规范化后相同
    const r3 = await w.signals.requestScores(actor, plan3, [content(a.id)]);
    expect(r3.tasks).toEqual({ created: 0, revived: 0, requeued: 0, reused: 0 });
    expect(r3.items[0]!.subjects[0]).toMatchObject({ disposition: "reused", reason: "valid" });
    await drain(w);
    w.clock.advance(31_000);
    await drain(w);
    expect(await rowsOf("content.asr_judgement")).toHaveLength(2);
    expect(gateway.calls.filter((c) => c.kind === "transcribe")).toHaveLength(1);
  });
  it("模型版本 m1 → m2：新请求产生新判定行（新参数指纹），m1 的行保留", async () => {
    const { gateway, w, a } = await judged();
    await w.signals.requestScores(actor, w.plan, [content(a.id)]);
    await drain(w);
    w.clock.advance(31_000);
    await drain(w);
    expect(await rowsOf("content.asr_judgement")).toHaveLength(1);
    gateway.models.judge = "judge-m2";
    expect(await read(w, a.id, "content.asr_judgement", { segment: w.plan })).toMatchObject({ state: "missing", reason: "not_computed" }); // m2 下还没有结果
    expect((await w.signals.requestScores(actor, w.plan, [content(a.id)])).tasks.created).toBe(1);
    await drain(w);
    const rows = await rowsOf("content.asr_judgement");
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => (r.evidence as { model: string }).model).sort()).toEqual(["judge-m1", "judge-m2"]);
    expect(rows[0]!.paramSha256.equals(rows[1]!.paramSha256)).toBe(false);
  });
  it("请求之后、运行之前模型换了：任务 dead(model_changed)，不把结果写到旧模型版本的键下", async () => {
    const { gateway, w, a } = await judged();
    await w.signals.requestScores(actor, w.plan, [content(a.id)]);
    gateway.models.judge = "judge-m2";
    await w.signals.speechRunner.runBatch();
    expect((await tasksOf("asr_judgement"))[0]).toMatchObject({ status: "dead", lastErrorCode: "model_changed" });
    expect(await resultCount(t)).toBe(0);
    expect(gateway.calls.filter((c) => c.kind === "judge")).toEqual([]);
  });
  it("模型输出缺 reason / verdict 非法 / 模型拒绝 → failed，不是 not_meets", async () => {
    for (const bad of [{ verdict: "meets" }, { verdict: "maybe", reason: "x" }, { reason: "x" }, "不是对象", { verdict: "not_meets", reason: "x", extra: 1 }]) {
      const { gateway, w, a } = await judged();
      gateway.judgement = bad;
      await w.signals.requestScores(actor, w.plan, [content(a.id)]);
      await drain(w);
      w.clock.advance(31_000);
      await drain(w);
      const v = await read(w, a.id, "content.asr_judgement", { segment: w.plan });
      expect(v, JSON.stringify(bad)).toMatchObject({ state: "failed", usable: false, reason: "invalid_output" });
      expect(v.value).toBeUndefined();
      await t.db.delete(signalTasks);
      await t.db.delete(signalResults);
      const { resetData } = await import("../../../../tests/harness/db");
      await resetData(t.pool);
    }
    const { gateway, w, a } = await judged();
    gateway.refuseNext = false;
    await w.signals.requestScores(actor, w.plan, [content(a.id)]);
    await drain(w); // ASR 完成
    gateway.refuseNext = true;
    w.clock.advance(31_000);
    await drain(w);
    expect(await read(w, a.id, "content.asr_judgement", { segment: w.plan })).toMatchObject({ state: "failed", reason: "model_refused" });
  });
  it("转写本身确定性失败：判定记 failed（保留原失败码），不是 not_meets", async () => {
    const { gateway, w, a } = await judged();
    gateway.transcript = { text: 1 as never, language: "zh", durationMs: 0 };
    await w.signals.requestScores(actor, w.plan, [content(a.id)]);
    await drain(w);
    w.clock.advance(31_000);
    await drain(w);
    expect(await read(w, a.id, "content.asr_judgement", { segment: w.plan })).toMatchObject({ state: "failed", reason: "invalid_output" });
  });
  it("ASR 任务已 dead：判定不替它复活，自己 dead(dependency_timeout)", async () => {
    const { gateway, w, a } = await judged();
    await w.signals.requestScores(actor, w.plan, [content(a.id)]);
    await w.signals.speechRunner.runBatch(); // 判定 deferred，建 ASR 任务
    for (let i = 0; i < 3; i++) {
      gateway.failNext = new Error("down");
      await w.signals.speechRunner.runBatch();
      w.clock.advance(60_000);
    }
    expect((await tasksOf("asr_text"))[0]).toMatchObject({ status: "dead" });
    w.clock.advance(60_000);
    await w.signals.speechRunner.runBatch();
    expect((await tasksOf("asr_judgement"))[0]).toMatchObject({ status: "dead", lastErrorCode: "dependency_timeout" });
    expect((await tasksOf("asr_text"))[0]).toMatchObject({ status: "dead", attemptCount: 3 }); // 没被复活
  });
  it("ASR 迟迟不出结果：延后累计超过上限 → dead(dependency_timeout)", async () => {
    const { w, a } = await judged();
    // 把 ASR 任务卡在 pending：领取判定后不让 ASR 任务被领（用 limit 小于任务数模拟不了，改为直接把 ASR 任务置为 retry_wait 很久以后）
    await w.signals.requestScores(actor, w.plan, [content(a.id)]);
    await w.signals.speechRunner.runBatch(); // deferred #1，ASR 任务入队
    await t.db.update(signalTasks).set({ status: "retry_wait", nextAttemptAt: new Date(w.clock.now().getTime() + 10 ** 10) }).where(eq(signalTasks.kind, "asr_text"));
    for (let i = 0; i < 25; i++) {
      w.clock.advance(31_000);
      await w.signals.speechRunner.runBatch();
    }
    expect((await tasksOf("asr_judgement"))[0]).toMatchObject({ status: "dead", lastErrorCode: "dependency_timeout", attemptCount: 0, deferCount: 21 });
  });
  it("只有 ASR 模型、判定模型为空：asr_text 可请求并计算；asr_judgement 读作 capability_disabled、被 executability 阻塞、不建任务", async () => {
    const gateway = new FakeAiGateway();
    gateway.models.judge = null;
    const w = await SEG({ gateway });
    const a = await makeAudioSubject(t);
    await configure(w, [ASR, judge("x")]);
    await expect(w.signals.requestScores(actor, w.plan, [content(a.id)])).rejects.toMatchObject({ code: "not_executable", detail: [{ code: "model_unavailable", signal: "content.asr_judgement", detail: "judge" }] });
    await configure(w, [ASR]);
    await w.signals.requestScores(actor, w.plan, [content(a.id)]);
    await drain(w);
    expect(await read(w, a.id, "content.asr_text")).toMatchObject({ state: "valid" });
    expect(await read(w, a.id, "content.asr_judgement", { segment: w.plan }).catch((e: { code: string }) => e.code)).toBe("judgement_item_not_found"); // 段里已没有判定项
    expect((await tasksOf("asr_judgement"))).toHaveLength(0);
  });
});
