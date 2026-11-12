// 任务 13 补测：acceptance.md 里被任务 2–12 的测试只间接覆盖或没有覆盖的条目。
// D4 / D7（评论）、E6（列）、G6 / G11 / G12（监控段）、H13 / L5 / L8 / M7 / N5（fake D 的调用序列）、I12（执行路径）、K12（重算期间读取）。
import { asc, count, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { commentFeatures, monitoringSegments, signalHistory, signalResults, signalTasks } from "../../db/schema";
import { useTestDb } from "../../../tests/harness/db";
import { insertAccount } from "../../../tests/harness/factories";
import { SIGNALS_T0 as T0, insertComment, seedContent } from "../../../tests/harness/signals";
import { actor, content, createWorld, makeSubject, png, resultCount, taskCount } from "../../../tests/harness/signals-world";
import { createFacts } from "./facts";
import { ingestComment } from "./features/ingest";
import { scanContents } from "./features/scan";
import { CAPABILITY_VERSIONS } from "./catalog";
import { NORMALIZERS } from "./text/normalize";

const t = useTestDb();
const at = (y: number, m: number, d: number, h = 3) => new Date(Date.UTC(y, m - 1, d, h));

describe("D4 / D7：评论特征行", () => {
  it("评论正文从 NULL 变空串：指纹不同，触发一次重算并写历史；评论转 suspected_deleted 后不再抽取，已有特征行保留", async () => {
    const w = await createWorld(t);
    const acct = await insertAccount(t.db, "douyin", T0);
    const c = await seedContent(t.db, { accountId: acct, pcid: "d7" });
    const k = await insertComment(t.db, { contentId: c.contentId, pcid: "n", text: null });
    const deps = { db: t.db, clock: w.clock };
    const fact = (await createFacts(t.db).commentFacts([k])).get(k)!;
    expect(await ingestComment(deps, fact)).toBe("created");
    expect(await ingestComment(deps, { ...fact, contentText: "" })).toBe("updated");
    const history = await t.db.select().from(signalHistory).where(eq(signalHistory.subjectId, k));
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ value: "", supersededReason: "material_changed" });
    expect(await ingestComment(deps, { ...fact, contentText: "" })).toBe("unchanged");
    expect(await ingestComment(deps, { ...fact, contentText: "", status: "suspected_deleted" })).toBe("skipped_inactive");
    expect((await t.db.select({ n: count() }).from(commentFeatures))[0]!.n).toBe(1);
  });
});

describe("E6：C 的表里没有 A 的事实字段", () => {
  it("content_features / comment_features / signal_results / signal_history 的列里没有发布时间、互动数、作者、昵称", async () => {
    const [cols] = await t.pool.query("SELECT table_name AS t, column_name AS c FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name IN ('content_features','comment_features','signal_results','signal_history')");
    const names = (cols as Array<{ t: string; c: string }>).map((r) => r.c);
    expect(names.length).toBeGreaterThan(20); // 查到了列
    expect(names.filter((c) => /published|digg|like|comment_count|play|share|collect|follower|author|nickname|avatar_url/i.test(c))).toEqual([]);
  });
});

describe("监控段：平台限制、清除不级联、同版本更新", () => {
  it("G6：小红书计划不能保存 account.avatar_element_score（也没有账号背景）", async () => {
    const w = await createWorld(t);
    await w.signals.segments.create(actor, { planId: 5n, platform: "xiaohongshu" });
    await expect(w.signals.segments.setItems(actor, { planId: 5n, version: 1 }, [{ signal: "account.avatar_element_score", element_key: "logo" }])).rejects.toMatchObject({ code: "signal_not_available_on_platform" });
    await expect(w.signals.segments.setItems(actor, { planId: 5n, version: 1 }, [{ signal: "account.bg_template_score" }])).rejects.toMatchObject({ code: "signal_not_available_on_platform" });
  });

  it("G11：purge 之后结果行与任务仍在（由保留期清理，不级联）", async () => {
    const w = await createWorld(t);
    const s = await makeSubject(t, "archived");
    await w.signals.requestScores(actor, w.plan, [content(s.id)]);
    await w.signals.scoreRunner.runBatch();
    expect(await resultCount(t)).toBe(1);
    await w.signals.segments.purge(actor, w.plan.planId);
    expect(await resultCount(t)).toBe(1);
    expect(await taskCount(t)).toBe(1);
    expect((await t.db.select({ n: count() }).from(monitoringSegments))[0]!.n).toBe(0);
  });

  it("I12（执行路径）：库里被绕过校验写进两个判定项时，executability 列出 too_many_judgements", async () => {
    const w = await createWorld(t);
    await t.db.update(monitoringSegments).set({ items: [{ signal: "content.asr_judgement", standard_text: "a" }, { signal: "content.asr_judgement", standard_text: "b" }] }).where(eq(monitoringSegments.planId, 1n));
    const ex = await w.signals.segments.executability(actor, w.plan);
    expect(ex.executable).toBe(false);
    expect(ex.blockers).toEqual(expect.arrayContaining([{ code: "too_many_judgements", signal: "content.asr_judgement" }]));
  });
});

describe("fake D 的调用序列（L8）：create → putImage → setItems → requestScores → readMany 轮询 → publish → newDraft → purge", () => {
  it("序列通过，轮询最终无 pending；同版本更新不产生新版本；草稿与已发布都可请求；审计事件齐全且不含 URL；任务保留一年；结果里没有“匹配 / 不匹配”字段", async () => {
    const w = await createWorld(t);
    const seg = w.signals.segments;
    const plan = { planId: 7n, version: 1 };
    await seg.create(actor, { planId: 7n, platform: "douyin" });
    await seg.putImage(actor, { ...plan, kind: "template", target: "cover" }, png("d-standard"));
    await seg.setItems(actor, plan, [{ signal: "content.cover_template_score" }]);
    await seg.putImage(actor, { ...plan, kind: "template", target: "cover" }, png("d-standard-2")); // 同版本草稿改图
    // G12：同一 (plan_id, version) 行被更新，不产生新版本
    expect((await t.db.select().from(monitoringSegments).where(eq(monitoringSegments.planId, 7n))).map((r) => r.version)).toEqual([1]);

    const subjects = [await makeSubject(t, "archived"), await makeSubject(t, "archived"), await makeSubject(t, "archived")];
    const refs = subjects.map((s) => content(s.id));
    const first = await w.signals.requestScores(actor, plan, refs); // L5：可执行的草稿可请求
    expect(first.tasks.created).toBe(3);
    // M7：任务保留期 = 创建 + 1 年
    expect((await t.db.select().from(signalTasks)).every((r) => r.expiresAt.getTime() === at(2027, 11, 12).getTime())).toBe(true);

    let values = await w.signals.reader.readMany(actor, refs, "content.cover_template_score", { param: { segment: plan } });
    let polls = 0;
    while ([...values.values()].some((v) => v.pending !== undefined) && polls++ < 10) {
      await w.signals.scoreRunner.runBatch();
      values = await w.signals.reader.readMany(actor, refs, "content.cover_template_score", { param: { segment: plan } });
    }
    expect([...values.values()].map((v) => v.state)).toEqual(["valid", "valid", "valid"]);
    expect([...values.values()].some((v) => v.pending !== undefined)).toBe(false);
    // H13：得分、能力版本与证据；没有匹配 / 不匹配的结论字段
    const one = [...values.values()][0]!;
    expect(one.score).toBeTypeOf("number");
    expect(one.capability).toEqual({ id: "image.template", version: CAPABILITY_VERSIONS["image.template"] });
    expect(Object.keys(one).filter((k) => /^(is_?)?match(ed|es)?$|^verdict$|^pass(ed)?$/i.test(k))).toEqual([]);
    expect(JSON.stringify((await t.db.select().from(signalResults))[0]!.evidence)).not.toMatch(/"(is_)?match(ed)?"\s*:\s*(true|false)/);

    await seg.publish(actor, plan);
    const again = await w.signals.requestScores(actor, plan, refs); // L5：已发布的也可请求，且全部命中
    expect(again.tasks).toEqual({ created: 0, revived: 0, requeued: 0, reused: 0 });
    const draft2 = await seg.newDraft(actor, { planId: 7n, fromVersion: 1 });
    expect(draft2).toEqual({ planId: 7n, version: 2 });
    await seg.removeImage(actor, { ...draft2, kind: "template", target: "cover" });
    await seg.purge(actor, 7n);
    expect((await t.db.select({ n: count() }).from(monitoringSegments).where(eq(monitoringSegments.planId, 7n)))[0]!.n).toBe(0);

    // N5：监控段与标准图的审计事件（重算与 dead 在各自的用例里）
    expect(w.events.filter((e) => e.plan_id === "7").map((e) => e.event_type)).toEqual(["segment_created", "image_uploaded", "image_uploaded", "segment_published", "segment_created", "image_removed", "segment_purged"]);
    expect(JSON.stringify(w.events)).not.toMatch(/https?:\/\/|Signature|Expires=/);
  });
});

describe("K12：重算期间读取不阻塞，仍读到旧值并标 stale", () => {
  it("apply 之后、分块执行之前读取：stale 且带旧值；执行完成后读到新值", async () => {
    const w = await createWorld(t);
    const acct = await insertAccount(t.db, "douyin", T0);
    const c = await seedContent(t.db, { accountId: acct, pcid: "k12", title: "原标题" });
    await scanContents({ db: t.db, clock: w.clock, config: { scanBatch: 100, lookbackMs: 60_000 } });
    const versions = CAPABILITY_VERSIONS as Record<string, number>;
    const normalizers = NORMALIZERS as Record<number, (s: string) => string>;
    versions["text.normalize"] = 2;
    normalizers[2] = (s) => NORMALIZERS[1]!(s);
    try {
      await w.signals.recompute.apply(actor, { signal: "text.title_normalized", scope: { contentIds: [c.contentId] } });
      expect(await w.signals.reader.read(actor, content(c.contentId), "text.title_normalized")).toMatchObject({ state: "stale", usable: true, value: "原标题", normalizerVersion: 1 });
      while ((await w.signals.recompute.runBatch()) > 0);
      expect(await w.signals.reader.read(actor, content(c.contentId), "text.title_normalized")).toMatchObject({ state: "valid", normalizerVersion: 2 });
      expect((await t.db.select({ n: count() }).from(signalHistory).orderBy(asc(signalHistory.historyId)))[0]!.n).toBeGreaterThan(0);
    } finally {
      versions["text.normalize"] = 1;
      delete normalizers[2];
    }
  });
});
