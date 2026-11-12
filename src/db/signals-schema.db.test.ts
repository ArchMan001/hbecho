// c-signals 任务 1：九张新表与 contents 上的一条索引，在真实 MySQL 8.4 上是否真的强制设计（design §6）里的约束。
import { describe, expect, it } from "vitest";
import { createDb, createPool, runMigrations, type Db } from "./client";
import { expectRejected, useTestDb } from "../../tests/harness/db";
import { insertAccount, insertBatch, insertContent, insertContentSnapshot, sha } from "../../tests/harness/factories";
import {
  commentFeatures,
  comments,
  contentFeatures,
  monitoringSegments,
  segmentImages,
  signalCursors,
  signalHistory,
  signalRecomputeRuns,
  signalResults,
  signalTasks,
} from "./schema";

const NOW = new Date("2026-11-12T02:00:00.000000Z");

/** 一次写入同时违反多条 CHECK 时，MySQL 只报告其中一条；用于「这几条都在守」的断言。 */
async function expectRejectedByAny(op: PromiseLike<unknown>, constraints: string[]): Promise<void> {
  try {
    await op;
  } catch (e) {
    const err = e as { message?: string; cause?: { sqlMessage?: string; message?: string } };
    const text = `${err.cause?.sqlMessage ?? ""} ${err.cause?.message ?? ""} ${err.message ?? ""}`;
    if (constraints.some((c) => text.includes(c))) return;
    throw new Error(`数据库拒绝了写入，但不是因为 ${constraints.join(" / ")}：${text}`);
  }
  throw new Error(`期望数据库拒绝（${constraints.join(" / ")}），但写入成功了`);
}

const t = useTestDb();

const ISO = NOW.toISOString();
const entry = (state: "valid" | "failed" | "missing", cap = "text.normalize") => ({ state, cap, ver: 1, nv: 1, at: ISO });
const VALID_SIGNALS = {
  "text.title_normalized": entry("valid"),
  "text.body_normalized": entry("valid"),
  "text.hashtags": entry("valid", "text.hashtags.douyin"),
};

async function newContent(db: Db, id = "c1") {
  const accountId = await insertAccount(t.db, "douyin", NOW);
  const batchId = await insertBatch(db, NOW);
  const contentId = await insertContent(db, { platform: "douyin", accountId, platformContentId: id, now: NOW });
  const snapshotId = await insertContentSnapshot(db, { batchId, contentId, now: NOW, status: "finalized" });
  return { accountId, batchId, contentId, snapshotId };
}

type FeatureInsert = typeof contentFeatures.$inferInsert;
const feature = (c: { contentId: bigint; snapshotId: bigint }, over: Partial<FeatureInsert> = {}): FeatureInsert => ({
  contentId: c.contentId,
  contentSnapshotId: c.snapshotId,
  textMaterialSha256: sha("m"),
  titleNormalized: "标题",
  bodyNormalized: "",
  hashtags: ["618"],
  signals: VALID_SIGNALS,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

describe("content_features", () => {
  it("合法行：三个信号 valid，空字符串是合法的 valid 值", async () => {
    const c = await newContent(t.db);
    await t.db.insert(contentFeatures).values(feature(c));
  });

  it("平台没有标题字段：条目缺失、列为空，是合法的（读取时推出 not_applicable）", async () => {
    const c = await newContent(t.db);
    const { "text.title_normalized": _omit, ...rest } = VALID_SIGNALS;
    await t.db.insert(contentFeatures).values(feature(c, { titleNormalized: null, signals: rest }));
  });

  it("值列与信封必须一致：列非空 ⇔ 信封 valid，信封缺条目也被拦住（不被 NULL 放行）", async () => {
    const c = await newContent(t.db);
    const { "text.title_normalized": _omit, ...noTitle } = VALID_SIGNALS;
    // 标题非空而信封 failed
    await expectRejected(t.db.insert(contentFeatures).values(feature(c, { signals: { ...VALID_SIGNALS, "text.title_normalized": entry("failed") } })), "ck_content_features_title");
    // 标题非空而信封缺条目
    await expectRejected(t.db.insert(contentFeatures).values(feature(c, { signals: noTitle })), "ck_content_features_title");
    // 标题为空而信封 valid
    await expectRejected(t.db.insert(contentFeatures).values(feature(c, { titleNormalized: null })), "ck_content_features_title");
    await expectRejected(t.db.insert(contentFeatures).values(feature(c, { bodyNormalized: null })), "ck_content_features_body");
    await expectRejected(t.db.insert(contentFeatures).values(feature(c, { hashtags: null })), "ck_content_features_tags");
  });

  it("信封里的状态只能是 valid / failed；信封必须是对象；话题必须是数组", async () => {
    const c = await newContent(t.db);
    await expectRejected(
      t.db.insert(contentFeatures).values(feature(c, { titleNormalized: null, signals: { ...VALID_SIGNALS, "text.title_normalized": entry("missing") } })),
      "ck_content_features_states",
    );
    await expectRejected(
      t.db.insert(contentFeatures).values(feature(c, { titleNormalized: null, signals: { ...VALID_SIGNALS, "text.title_normalized": { ...entry("valid"), state: "stale" } } })),
      "ck_content_features_states",
    );
    await expectRejected(
      t.db.insert(contentFeatures).values(feature(c, { titleNormalized: null, bodyNormalized: null, hashtags: null, signals: [] as unknown as Record<string, unknown> })),
      "ck_content_features_signals",
    );
    await expectRejected(t.db.insert(contentFeatures).values(feature(c, { hashtags: { a: 1 } as unknown as string[] })), "ck_content_features_hashtags");
  });

  it("所基于的快照必须属于同一个内容（复合外键）；一个内容只有一行", async () => {
    const a = await newContent(t.db, "a");
    const b = await newContent(t.db, "b");
    await expectRejected(t.db.insert(contentFeatures).values(feature({ contentId: a.contentId, snapshotId: b.snapshotId })), "fk_content_features_snapshot");
    await t.db.insert(contentFeatures).values(feature(a));
    await expectRejected(t.db.insert(contentFeatures).values(feature(a)), "PRIMARY");
  });

  it("被特征行引用的内容快照与内容不能被删除", async () => {
    const a = await newContent(t.db);
    await t.db.insert(contentFeatures).values(feature(a));
    await expectRejected(t.pool.query("DELETE FROM content_snapshots WHERE content_snapshot_id = ?", [a.snapshotId]), "fk_content_features_snapshot");
  });
});

describe("comment_features", () => {
  async function newComment() {
    const c = await newContent(t.db);
    const [r] = await t.db.insert(comments).values({
      contentId: c.contentId,
      platformCommentId: "cm1",
      platformCommentIdSha256: sha("cm1"),
      likeState: "missing",
      replyState: "missing",
      firstSeenAt: NOW,
      lastSeenAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    });
    return BigInt(r.insertId);
  }
  const row = (commentId: bigint, over: Partial<typeof commentFeatures.$inferInsert> = {}): typeof commentFeatures.$inferInsert => ({
    commentId,
    textMaterialSha256: sha("t"),
    textNormalized: "好看",
    signals: { "comment.text_normalized": entry("valid") },
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  });

  it("值与信封一致、状态枚举、信封必须是对象", async () => {
    const id = await newComment();
    await expectRejected(t.db.insert(commentFeatures).values(row(id, { signals: { "comment.text_normalized": entry("failed") } })), "ck_comment_features_text");
    await expectRejected(t.db.insert(commentFeatures).values(row(id, { signals: {} })), "ck_comment_features_text");
    await expectRejected(t.db.insert(commentFeatures).values(row(id, { textNormalized: null })), "ck_comment_features_text");
    await expectRejected(
      t.db.insert(commentFeatures).values(row(id, { textNormalized: null, signals: { "comment.text_normalized": entry("missing") } })),
      "ck_comment_features_states",
    );
    await expectRejected(t.db.insert(commentFeatures).values(row(id, { signals: [] as unknown as Record<string, unknown> })), "ck_comment_features_signals");
    await t.db.insert(commentFeatures).values(row(id));
  });

  it("评论必须存在（外键）；一条评论一行", async () => {
    await expectRejected(t.db.insert(commentFeatures).values(row(999999n)), "comment_features_comment_id_comments_comment_id_fk");
    const id = await newComment();
    await t.db.insert(commentFeatures).values(row(id));
    await expectRejected(t.db.insert(commentFeatures).values(row(id)), "PRIMARY");
  });
});

describe("signal_history", () => {
  const h = (over: Partial<typeof signalHistory.$inferInsert> = {}): typeof signalHistory.$inferInsert => ({
    subjectKind: "content",
    subjectId: 1n,
    signalKey: "text.title_normalized",
    state: "valid",
    value: "旧标题",
    capabilityId: "text.normalize",
    capabilityVersion: 1,
    normalizerVersion: 1,
    producedAt: NOW,
    supersededAt: NOW,
    supersededReason: "material_changed",
    expiresAt: NOW,
    ...over,
  });
  it("枚举与版本由 CHECK 守护", async () => {
    await t.db.insert(signalHistory).values(h());
    await expectRejected(t.db.insert(signalHistory).values(h({ subjectKind: "account" })), "ck_signal_history_kind");
    await expectRejected(t.db.insert(signalHistory).values(h({ state: "stale" })), "ck_signal_history_state");
    await expectRejected(t.db.insert(signalHistory).values(h({ supersededReason: "deleted" })), "ck_signal_history_reason");
    await expectRejected(t.db.insert(signalHistory).values(h({ capabilityVersion: 0 })), "ck_signal_history_version");
  });
});

describe("signal_results", () => {
  const ZERO32 = Buffer.alloc(32);
  const r = (over: Partial<typeof signalResults.$inferInsert> = {}): typeof signalResults.$inferInsert => ({
    signalKey: "content.cover_template_score",
    materialSha256: sha("img"),
    paramSha256: sha("std"),
    capabilityId: "image.template",
    capabilityVersion: 1,
    state: "valid",
    score: "8.30",
    evidence: { elapsed_ms: 74 },
    producedAt: NOW,
    expiresAt: NOW,
    createdAt: NOW,
    ...over,
  });

  it("复用键唯一：同键只有一行；换标准图、换版本、换能力标识都是新行", async () => {
    await t.db.insert(signalResults).values(r());
    await expectRejected(t.db.insert(signalResults).values(r()), "uq_signal_results_key");
    await t.db.insert(signalResults).values(r({ paramSha256: sha("std2") }));
    await t.db.insert(signalResults).values(r({ capabilityVersion: 2 }));
    await t.db.insert(signalResults).values(r({ capabilityId: "image.template.v2" }));
    await t.db.insert(signalResults).values(r({ signalKey: "account.bg_template_score" }));
  });

  it("分数范围 0.00–10.00：边界合法，越界被拒", async () => {
    await t.db.insert(signalResults).values(r({ score: "10.00" }));
    await t.db.insert(signalResults).values(r({ score: "0.00", materialSha256: sha("img0") }));
    await expectRejected(t.db.insert(signalResults).values(r({ score: "10.01", materialSha256: sha("a") })), "ck_signal_results_score");
    await expectRejected(t.db.insert(signalResults).values(r({ score: "-0.01", materialSha256: sha("b") })), "ck_signal_results_score");
  });

  it("形状：valid 恰好有 score 或 value 之一；failed 必带失败码且不带值", async () => {
    // valid：score 与 value 同时有 / 都没有
    await expectRejected(t.db.insert(signalResults).values(r({ value: { text: "x" } })), "ck_signal_results_shape");
    await expectRejected(t.db.insert(signalResults).values(r({ score: null })), "ck_signal_results_shape");
    // valid 带失败码
    await expectRejected(t.db.insert(signalResults).values(r({ failureCode: "image_unreadable" })), "ck_signal_results_shape");
    // failed：不带失败码、带分数、带值
    await expectRejected(t.db.insert(signalResults).values(r({ state: "failed", score: null })), "ck_signal_results_shape");
    await expectRejected(t.db.insert(signalResults).values(r({ state: "failed", failureCode: "image_unreadable" })), "ck_signal_results_shape");
    await expectRejected(t.db.insert(signalResults).values(r({ state: "failed", score: null, value: { text: "x" }, failureCode: "x" })), "ck_signal_results_shape");
    // 合法的 failed 与 value 型 valid
    await t.db.insert(signalResults).values(r({ state: "failed", score: null, failureCode: "image_unreadable" }));
    await t.db.insert(signalResults).values(r({ signalKey: "content.asr_text", capabilityId: "speech.asr", paramSha256: ZERO32, score: null, value: { text: "你好", language: "zh" } }));
  });

  it("存储态只有 valid / failed；能力版本为正", async () => {
    // 非法 state 同时违反 state 枚举与形状两条 CHECK，MySQL 报告其中之一；两条都在，所以任一即可
    for (const s of ["missing", "stale", "not_applicable"]) {
      await expectRejectedByAny(t.db.insert(signalResults).values(r({ state: s })), ["ck_signal_results_state", "ck_signal_results_shape"]);
    }
    await expectRejected(t.db.insert(signalResults).values(r({ capabilityVersion: 0 })), "ck_signal_results_version");
  });
});

describe("monitoring_segments 与 segment_images", () => {
  const seg = (over: Partial<typeof monitoringSegments.$inferInsert> = {}): typeof monitoringSegments.$inferInsert => ({
    planId: 7n,
    version: 1,
    platformCode: "douyin",
    status: "draft",
    items: [{ signal: "text.hashtags" }],
    createdByActor: "service:test",
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  });
  const img = (over: Partial<typeof segmentImages.$inferInsert> = {}): typeof segmentImages.$inferInsert => ({
    planId: 7n,
    version: 1,
    kind: "template",
    target: "cover",
    elementKey: "",
    sha256: sha("img"),
    byteLength: 1000n,
    width: 540,
    height: 960,
    mime: "image/jpeg",
    bucket: "hbecho-signals",
    objectKey: "segments/7/1/cover/template/abc",
    createdByActor: "service:test",
    createdAt: NOW,
    ...over,
  });

  it("监控段：状态、平台、发布时间与状态一致、items 为数组、版本为正", async () => {
    await expectRejected(t.db.insert(monitoringSegments).values(seg({ status: "frozen" })), "ck_segments_status");
    await expectRejected(t.db.insert(monitoringSegments).values(seg({ platformCode: "weishi" })), "ck_segments_platform");
    await expectRejected(t.db.insert(monitoringSegments).values(seg({ status: "published" })), "ck_segments_published");
    await expectRejected(t.db.insert(monitoringSegments).values(seg({ publishedAt: NOW })), "ck_segments_published");
    await expectRejected(t.db.insert(monitoringSegments).values(seg({ items: {} as unknown as unknown[] })), "ck_segments_items");
    await expectRejected(t.db.insert(monitoringSegments).values(seg({ version: 0 })), "ck_segments_version");
    await t.db.insert(monitoringSegments).values(seg());
    await t.db.insert(monitoringSegments).values(seg({ version: 2, status: "published", publishedAt: NOW }));
    await expectRejected(t.db.insert(monitoringSegments).values(seg()), "PRIMARY");
  });

  it("计划 ID 无外键：D 还没有任何表，C 先建段是合法的", async () => {
    await t.db.insert(monitoringSegments).values(seg({ planId: 987654321n }));
  });

  it("同计划版本同图像对象至多一张模板图；元素图按 element_key 可有多张", async () => {
    await t.db.insert(monitoringSegments).values(seg());
    await t.db.insert(segmentImages).values(img());
    await expectRejected(t.db.insert(segmentImages).values(img({ sha256: sha("other"), objectKey: "segments/7/1/cover/template/def" })), "uq_segment_images_slot");
    await t.db.insert(segmentImages).values(img({ target: "background", objectKey: "k/bg" }));
    await t.db.insert(segmentImages).values(img({ kind: "element", elementKey: "logo-1", objectKey: "k/e1" }));
    await t.db.insert(segmentImages).values(img({ kind: "element", elementKey: "logo-2", objectKey: "k/e2" }));
    await expectRejected(t.db.insert(segmentImages).values(img({ kind: "element", elementKey: "logo-2", objectKey: "k/e3" })), "uq_segment_images_slot");
  });

  it("模板图不得带 element_key，元素图必须带；枚举与尺寸由 CHECK 守护", async () => {
    await t.db.insert(monitoringSegments).values(seg());
    await expectRejected(t.db.insert(segmentImages).values(img({ elementKey: "x" })), "ck_segment_images_element");
    await expectRejected(t.db.insert(segmentImages).values(img({ kind: "element", elementKey: "" })), "ck_segment_images_element");
    await expectRejected(t.db.insert(segmentImages).values(img({ kind: "ocr", elementKey: "x" })), "ck_segment_images_kind");
    await expectRejected(t.db.insert(segmentImages).values(img({ target: "poster" })), "ck_segment_images_target");
    await expectRejected(t.db.insert(segmentImages).values(img({ byteLength: 0n })), "ck_segment_images_size");
    await expectRejected(t.db.insert(segmentImages).values(img({ width: 0 })), "ck_segment_images_size");
  });

  it("图片必须属于已存在的（计划，版本）；有图的监控段不能被删除（RESTRICT）", async () => {
    await expectRejected(t.db.insert(segmentImages).values(img({ planId: 404n })), "fk_segment_images_segment");
    await t.db.insert(monitoringSegments).values(seg());
    await t.db.insert(segmentImages).values(img());
    await expectRejected(t.pool.query("DELETE FROM monitoring_segments WHERE plan_id = 7 AND version = 1"), "fk_segment_images_segment");
  });
});

describe("signal_recompute_runs", () => {
  const run = (over: Partial<typeof signalRecomputeRuns.$inferInsert> = {}): typeof signalRecomputeRuns.$inferInsert => ({
    requestedByActor: "user:1",
    signalKey: "text.hashtags",
    scope: { accountIds: ["1"] },
    scopeSha256: sha("scope"),
    scopeCount: 10,
    fromVersion: 1,
    toVersion: 2,
    status: "running",
    activeKey: sha("active"),
    startedAt: NOW,
    createdAt: NOW,
    ...over,
  });

  it("同范围同一时刻至多一个未完成 run；完成 / 取消的 run 不阻止再次执行", async () => {
    await t.db.insert(signalRecomputeRuns).values(run());
    await expectRejected(t.db.insert(signalRecomputeRuns).values(run()), "uq_recompute_active");
    await t.db.insert(signalRecomputeRuns).values(run({ status: "completed", activeKey: null, finishedAt: NOW }));
    await t.db.insert(signalRecomputeRuns).values(run({ status: "completed", activeKey: null, finishedAt: NOW }));
    await t.db.insert(signalRecomputeRuns).values(run({ status: "cancelled", activeKey: null, finishedAt: NOW }));
    // failed 与 running 一样占着 active_key（可续跑）
    await t.db.insert(signalRecomputeRuns).values(run({ activeKey: sha("active2"), status: "failed", finishedAt: NOW }));
    await expectRejected(t.db.insert(signalRecomputeRuns).values(run({ status: "failed", finishedAt: NOW })), "uq_recompute_active");
  });

  it("状态与 active_key、finished_at 必须一致；版本与计数合法", async () => {
    await expectRejected(t.db.insert(signalRecomputeRuns).values(run({ status: "completed", finishedAt: NOW })), "ck_recompute_active");
    await expectRejected(t.db.insert(signalRecomputeRuns).values(run({ activeKey: null })), "ck_recompute_active");
    await expectRejected(t.db.insert(signalRecomputeRuns).values(run({ finishedAt: NOW, activeKey: sha("k1") })), "ck_recompute_finished");
    await expectRejected(t.db.insert(signalRecomputeRuns).values(run({ status: "completed", activeKey: null })), "ck_recompute_finished");
    await expectRejected(t.db.insert(signalRecomputeRuns).values(run({ status: "paused", activeKey: null, finishedAt: NOW })), "ck_recompute_status");
    await expectRejected(t.db.insert(signalRecomputeRuns).values(run({ fromVersion: 3, toVersion: 2, activeKey: sha("k2") })), "ck_recompute_versions");
    await expectRejected(t.db.insert(signalRecomputeRuns).values(run({ scopeCount: -1, activeKey: sha("k3") })), "ck_recompute_counts");
    // 范围内全无旧值：from_version 为空是合法的
    await t.db.insert(signalRecomputeRuns).values(run({ fromVersion: null, activeKey: sha("k4") }));
  });
});

describe("signal_tasks", () => {
  const task = (over: Partial<typeof signalTasks.$inferInsert> = {}): typeof signalTasks.$inferInsert => ({
    kind: "score_template",
    idempotencyKey: sha("task"),
    params: { signal_key: "content.cover_template_score" },
    status: "pending",
    maxAttempts: 3,
    createdAt: NOW,
    updatedAt: NOW,
    expiresAt: NOW,
    ...over,
  });

  it("幂等键唯一；种类、状态、租约、重试次数由 CHECK 守护", async () => {
    await t.db.insert(signalTasks).values(task());
    await expectRejected(t.db.insert(signalTasks).values(task()), "uq_signal_tasks_idempotency");
    await expectRejected(t.db.insert(signalTasks).values(task({ idempotencyKey: sha("k1"), kind: "ocr" })), "ck_signal_tasks_kind");
    await expectRejected(t.db.insert(signalTasks).values(task({ idempotencyKey: sha("k2"), status: "leased" })), "ck_signal_tasks_status");
    // running 必须带租约
    await expectRejected(t.db.insert(signalTasks).values(task({ idempotencyKey: sha("k3"), status: "running" })), "ck_signal_tasks_lease");
    await t.db.insert(signalTasks).values(task({ idempotencyKey: sha("k4"), status: "running", leaseOwner: "w1", leaseExpiresAt: NOW }));
    await expectRejected(t.db.insert(signalTasks).values(task({ idempotencyKey: sha("k5"), attemptCount: 4 })), "ck_signal_tasks_attempts");
    await expectRejected(t.db.insert(signalTasks).values(task({ idempotencyKey: sha("k6"), deferCount: -1 })), "ck_signal_tasks_attempts");
  });

  it("结果行被保留期清理后，任务行保留且 result_id 置空；被任务引用的 run 不能删除", async () => {
    const [res] = await t.db.insert(signalResults).values({
      signalKey: "content.cover_template_score",
      materialSha256: sha("img"),
      paramSha256: sha("std"),
      capabilityId: "image.template",
      capabilityVersion: 1,
      state: "valid",
      score: "5.00",
      evidence: {},
      producedAt: NOW,
      expiresAt: NOW,
      createdAt: NOW,
    });
    const resultId = BigInt(res.insertId);
    const [tk] = await t.db.insert(signalTasks).values(task({ status: "succeeded", resultId, finishedAt: NOW }));
    await t.pool.query("DELETE FROM signal_results WHERE result_id = ?", [resultId]);
    const [rows] = await t.pool.query("SELECT result_id AS r FROM signal_tasks WHERE task_id = ?", [BigInt(tk.insertId)]);
    expect((rows as Array<{ r: unknown }>)[0]?.r).toBeNull();

    const [rr] = await t.db.insert(signalRecomputeRuns).values({
      requestedByActor: "user:1",
      signalKey: "text.hashtags",
      scope: {},
      scopeSha256: sha("s"),
      scopeCount: 1,
      toVersion: 2,
      status: "running",
      activeKey: sha("a"),
      startedAt: NOW,
      createdAt: NOW,
    });
    await t.db.insert(signalTasks).values(task({ idempotencyKey: sha("chunk"), kind: "recompute_chunk", runId: BigInt(rr.insertId) }));
    await expectRejected(t.pool.query("DELETE FROM signal_recompute_runs WHERE run_id = ?", [BigInt(rr.insertId)]), "fk_signal_tasks_run");
  });
});

describe("signal_cursors", () => {
  it("游标名即主键", async () => {
    await t.db.insert(signalCursors).values({ cursorName: "content_scan", watermarkAt: NOW, watermarkId: 0n, updatedAt: NOW });
    await expectRejected(t.db.insert(signalCursors).values({ cursorName: "content_scan", watermarkAt: NOW, watermarkId: 1n, updatedAt: NOW }), "PRIMARY");
  });
});

describe("迁移与整体约束", () => {
  it("可重复执行：第二次迁移不改变任何东西", async () => {
    const pool = createPool(process.env.HBECHO_TEST_DATABASE_URL!);
    try {
      await runMigrations(createDb(pool));
      const [[before]] = (await pool.query("SELECT COUNT(*) c FROM __drizzle_migrations")) as unknown as [Array<{ c: number }>];
      await runMigrations(createDb(pool));
      const [[after]] = (await pool.query("SELECT COUNT(*) c FROM __drizzle_migrations")) as unknown as [Array<{ c: number }>];
      expect(after?.c).toBe(before?.c);
    } finally {
      await pool.end();
    }
  });

  it("C 的九张表存在；外键没有级联删除，唯一的 SET NULL 是任务 → 结果行", async () => {
    const [tables] = await t.pool.query(
      "SELECT table_name n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN ('content_features','comment_features','signal_history','signal_results','monitoring_segments','segment_images','signal_tasks','signal_cursors','signal_recompute_runs')",
    );
    expect((tables as unknown[]).length).toBe(9);
    const [fks] = await t.pool.query(
      `SELECT constraint_name n, delete_rule r FROM information_schema.referential_constraints
       WHERE constraint_schema = DATABASE()
         AND (table_name IN ('content_features','comment_features','signal_history','signal_results','monitoring_segments','segment_images','signal_tasks','signal_cursors','signal_recompute_runs')
              OR referenced_table_name IN ('content_features','comment_features','signal_results','monitoring_segments','signal_recompute_runs'))`,
    );
    const rows = fks as Array<{ n: string; r: string }>;
    expect(rows.length).toBeGreaterThanOrEqual(6);
    expect(rows.filter((x) => x.r === "CASCADE")).toEqual([]);
    expect(rows.filter((x) => x.r === "SET NULL").map((x) => x.n)).toEqual(["fk_signal_tasks_result"]);
  });

  it("contents 上多了且只多了一条索引 idx_contents_current_selected(current_snapshot_selected_at, content_id)", async () => {
    const [rows] = await t.pool.query(
      "SELECT column_name c FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'contents' AND index_name = 'idx_contents_current_selected' ORDER BY seq_in_index",
    );
    expect((rows as Array<{ c: string }>).map((r) => r.c)).toEqual(["current_snapshot_selected_at", "content_id"]);
  });
});
