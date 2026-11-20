// d-rule-engine 的测试世界：活动计划 + 名单 + 专员 + 账号 + 内容 + 快照 + 同步任务的工厂。
// 在 rosterWorld（品牌 HITACHI、分公司 101 已加入、门店 S-W1 等）之上再造，造数函数都说明「为什么这样造」。
import { eq } from "drizzle-orm";
import type { Db } from "../../src/db/client";
import { comments, contents, contentSnapshots, syncCheckpoints, syncTasks } from "../../src/db/schema";
import { insertAccount, insertAssignment, insertBatch, insertContent, sha } from "./factories";
import { platformIdOf, providerIdOf } from "./seed";
import type { TestDb } from "./db";
import { insertRosterEntry, insertStaff, T0 } from "./plan";
import { rosterWorld, type RosterWorld } from "./roster";

export { T0 };
export interface JudgementWorld extends RosterWorld {
  /** 名单里的参与专员（老赵）与他的账号：rosterWorld 已建，这里给出便于取用的别名 */
  zhao: { staffId: bigint; accountId: bigint };
}
export async function judgementWorld(t: TestDb): Promise<JudgementWorld> {
  const w = await rosterWorld(t, { createdBy: "user:7" });
  return { ...w, zhao: { staffId: w.staff.zhao, accountId: w.accZhao } };
}
/** 再加一名参与专员（门店 S-W1、抖音账号、已在名单）。 */
export async function addParticipant(t: TestDb, w: RosterWorld, name: string, phone: string): Promise<{ staffId: bigint; accountId: bigint }> {
  const staffId = await insertStaff(t.db, { storeId: w.stores.sW1, name, phone });
  const accountId = await insertAccount(t.db, "douyin", T0);
  await insertAssignment(t.db, { accountId, platform: "douyin", staffId, now: T0, locator: `https://www.douyin.com/user/${phone}` });
  await insertRosterEntry(t.db, { planId: w.planId, accountId, staffId, storeId: w.stores.sW1, branchId: w.bj });
  return { staffId, accountId };
}
export interface ContentSpec {
  accountId: bigint;
  platformContentId: string;
  kind?: "video" | "image" | "text" | "unknown";
  /** null = 发布时间缺失 */
  publishedAt?: Date | null;
  /** 点赞：数字 = value；字符串 = 该值状态（missing / explicit_null / invalid / unsupported） */
  like?: number | "missing" | "explicit_null" | "invalid" | "unsupported";
  durationSeconds?: number | "unknown_unit" | "missing";
  status?: "active" | "unavailable" | "deleted";
  /** false = 只有 building 快照（不是 finalized） */
  finalized?: boolean;
  noSnapshot?: boolean;
  batchId?: bigint;
  now?: Date;
}
/** 造一条内容与它的当前快照；contents.current_snapshot_id 指向它（复合外键）。 */
export async function addContent(db: Db, s: ContentSpec): Promise<{ contentId: bigint; snapshotId: bigint | null }> {
  const now = s.now ?? T0;
  const contentId = await insertContent(db, { platform: "douyin", accountId: s.accountId, platformContentId: s.platformContentId, now });
  await db.update(contents).set({ contentKind: s.kind ?? "video", status: s.status ?? "active" }).where(eq(contents.contentId, contentId));
  if (s.noSnapshot) return { contentId, snapshotId: null };
  const batchId = s.batchId ?? (await insertBatch(db, now));
  const like = s.like ?? 0;
  const dur = s.durationSeconds ?? 30;
  const finalized = s.finalized !== false;
  const [r] = await db.insert(contentSnapshots).values({
    batchId,
    contentId,
    snapshotStatus: finalized ? "finalized" : "building",
    publishedAt: s.publishedAt === undefined ? new Date("2026-11-05T04:00:00.000Z") : s.publishedAt,
    durationState: typeof dur === "number" ? "value" : "missing",
    durationValue: typeof dur === "number" ? String(dur) : null,
    durationUnit: typeof dur === "number" ? "seconds" : dur === "unknown_unit" ? "unknown" : "unknown",
    playState: "unsupported",
    likeState: typeof like === "number" ? "value" : like,
    likeValue: typeof like === "number" ? BigInt(like) : null,
    commentState: "missing",
    collectState: "missing",
    shareState: "missing",
    forwardState: "missing",
    snapshotAt: now,
    mergePolicyVersion: "merge.v1",
    finalizedAt: finalized ? now : null,
    createdAt: now,
    updatedAt: now,
  });
  const snapshotId = BigInt(r.insertId);
  if (dur === "unknown_unit") await db.update(contentSnapshots).set({ durationState: "value", durationValue: "30", durationUnit: "unknown" }).where(eq(contentSnapshots.contentSnapshotId, snapshotId));
  if (finalized) await db.update(contents).set({ currentSnapshotId: snapshotId, currentSnapshotSelectedAt: now }).where(eq(contents.contentId, contentId));
  return { contentId, snapshotId };
}
/** 造一条一级评论（active）；评论正文不进测试数据，文本信号由 FakeSignals 编程。 */
/** 给内容追加一条更新的 finalized 快照（点赞为 like）并把 contents.current_snapshot_id 指向它：模拟「冻结之后又有一次同步」。 */
export async function moveCurrentSnapshot(db: Db, contentId: bigint, o: { like: number }): Promise<bigint> {
  const [c] = await db.select().from(contents).where(eq(contents.contentId, contentId));
  const [old] = await db.select().from(contentSnapshots).where(eq(contentSnapshots.contentSnapshotId, c!.currentSnapshotId!));
  const later = new Date(old!.snapshotAt.getTime() + 3_600_000);
  const batchId = await insertBatch(db, later);
  const { contentSnapshotId: _drop, ...rest } = old!;
  const [r] = await db.insert(contentSnapshots).values({ ...rest, batchId, likeState: "value", likeValue: BigInt(o.like), snapshotAt: later, finalizedAt: later, createdAt: later, updatedAt: later });
  const id = BigInt(r.insertId);
  await db.update(contents).set({ currentSnapshotId: id, currentSnapshotSelectedAt: later }).where(eq(contents.contentId, contentId));
  return id;
}
export async function addComment(db: Db, a: { contentId: bigint; platformCommentId: string; status?: "active" | "suspected_deleted" | "deleted"; now?: Date }): Promise<bigint> {
  const now = a.now ?? T0;
  const [r] = await db.insert(comments).values({ contentId: a.contentId, platformCommentId: a.platformCommentId, platformCommentIdSha256: sha(a.platformCommentId), status: a.status ?? "active", likeState: "missing", replyState: "missing", firstSeenAt: now, lastSeenAt: now, createdAt: now, updatedAt: now });
  return BigInt(r.insertId);
}
/** 造一条已终态的列表同步任务（批次 logical_at = at）。 */
export async function addListTask(db: Db, a: { accountId: bigint; status: "succeeded" | "succeeded_with_gap" | "failed" | "dead" | "cancelled" | "pending"; at: Date; gap?: boolean }): Promise<void> {
  const batchId = await insertBatch(db, a.at);
  const terminal = a.status !== "pending";
  await db.insert(syncTasks).values({
    batchId,
    providerId: await providerIdOf(db),
    platformId: await platformIdOf(db, "douyin"),
    accountId: a.accountId,
    requestedAction: "fetch_content_list",
    subjectType: "external_account",
    taskParameters: { schema_version: "data-foundation-tracer-task-parameters.v1", effective_initial_content_limit: 20 },
    idempotencyKey: sha(`list-${a.accountId}-${a.at.toISOString()}-${a.status}-${Math.random()}`),
    status: a.status,
    attemptCount: 0,
    maxAttempts: 3,
    continuityGapDetected: a.gap === true || a.status === "succeeded_with_gap",
    ...(a.status === "succeeded_with_gap" ? { stopReason: "window_overflow", windowOverflowDetected: true } : {}),
    ...(terminal ? { finishedAt: a.at } : {}),
    expiresAt: new Date(a.at.getTime() + 365 * 86_400_000),
    createdAt: a.at,
    updatedAt: a.at,
  });
}
/** `scope` 缺省 default；给别的 scope 造一条检查点，用来证明谓词只读 default（I16）。 */
export async function addCheckpoint(db: Db, accountId: bigint, continuityStatus: "ready" | "in_progress" | "rebased_after_gap" | "blocked", lastGapAt: Date | null = null, scope = "default"): Promise<void> {
  await db.insert(syncCheckpoints).values({ accountId, checkpointScope: scope, providerId: await providerIdOf(db), anchorMode: "empty", cursorEnvelope: { kind: "null" }, cursorSha256: sha("cursor"), continuityStatus, lastGapAt, version: 1n, updatedAt: T0 });
}

// ---- 装配：判定模块的真实实现 + FakeSignals + 内存审计 -------------------------------------------------------
import { createAuthorizer, createRegistry, ROLE_CAPABILITIES, type AuthContext, type DataScope, type RoleCode } from "../../src/modules/access-control";
import { CATALOG } from "../../src/modules/signals/catalog";
import { createPlanReader } from "../../src/modules/activity-plan/reader";
import type { JudgementAuditEvent } from "../../src/modules/judgement/audit";
import { createJudgement, type Judgement } from "../../src/modules/judgement/assemble";
import { FakeDemand, FakeSignals } from "../../src/modules/judgement/fakes";
import type { Sleep } from "../../src/modules/judgement/runs";
import type { JudgementConfig } from "../../src/modules/judgement/env";
import { FakeClock } from "./fake-clock";

export const LIMITS = { maxItems: 50, maxKeywordLength: 64 } as const;
/** 测试用的数值配置（生产没有代码默认值）；块大小取很小，让分块与游标续跑真的被走到。 */
export const TEST_CONFIG: JudgementConfig = { blockSize: 2, signalBatch: 3, demandBatch: 10, pollSeconds: 30, waitSignalSeconds: 600, waitDemandSeconds: 7200, waitCollectSeconds: 3600, leaseSeconds: 120, tickBudgetMs: 60_000, phaseMaxAttempts: 3, maxItems: 50, maxKeywordLength: 64, trialRetentionDays: 30, keepContentRuns: 5, failedRetentionDays: 30 };
export const userCtx = (role: RoleCode, id: number, scope: DataScope): AuthContext => ({ kind: "user", actor: `user:${id}`, userId: BigInt(id), role, capabilities: ROLE_CAPABILITIES[role], scope, sessionId: null });
export const ALL_SCOPE: DataScope = { brands: "all", branches: "all", self: { kind: "none" }, level: 3 };
export interface JudgementEnv {
  fake: FakeSignals;
  demand: FakeDemand;
  clock: FakeClock;
  plans: Judgement["plans"];
  versions: Judgement["versions"];
  runs: Judgement["runs"];
  outcomes: Judgement["outcomes"];
  views: Judgement["views"];
  claim: Judgement["claim"];
  /** 休眠 = 推进 FakeClock，并在每次休眠后调用 onSleep（让测试在等待期间「让信号就绪」） */
  sleep: Sleep;
  onSleep: { fn: (() => void | Promise<void>) | null };
  facts: Judgement["facts"];
  authz: Judgement["authz"];
  /** 与 createJudgement 同一份审计（downstream 等直接构造的部件用它） */
  audit: Judgement["audit"];
  audits: Array<{ event: string; risk: string; hasTx: boolean; detail: unknown }>;
  /** 活动计划创建者（user:7，hq_manager，范围 = 该品牌） */
  creator: AuthContext;
  /** 同品牌的另一位 hq_manager（不是创建者） */
  other: AuthContext;
  admin: AuthContext;
  /** 让某次 contextForUser 失败（提交人被停用） */
  revoked: Set<bigint>;
}
export function judgementEnv(t: TestDb, w: RosterWorld, over: { limits?: { maxItems: number; maxKeywordLength: number }; config?: Partial<JudgementConfig> } = {}): JudgementEnv {
  const fake = new FakeSignals();
  const demand = new FakeDemand();
  for (const p of ["douyin", "xiaohongshu", "kuaishou"]) fake.platformMap.set(p, new Set(CATALOG.filter((e) => (e.platforms as readonly string[]).includes(p)).map((e) => e.key)));
  const clock = new FakeClock(new Date("2026-11-16T02:00:00.000Z"));
  const registry = createRegistry();
  const revoked = new Set<bigint>();
  const brandScope: DataScope = { brands: new Set([w.org.hitachiBrandId]), branches: "all", self: { kind: "none" }, level: 2 };
  const creator = userCtx("hq_manager", 7, brandScope);
  const audits: JudgementEnv["audits"] = [];
  const config = { ...TEST_CONFIG, ...(over.config ?? {}), ...(over.limits ?? {}) };
  // 与生产同一份装配（createJudgement）：测试证明的就是生产接线
  const j = createJudgement({
    db: t.db,
    clock,
    reader: createPlanReader({ db: t.db, resolver: { targets: async () => ({ rows: [], next: null }) } as never }),
    signals: fake,
    demand,
    resolver: { contextForUser: async (id: bigint) => (revoked.has(id) ? ({ ok: false, kind: "unauthenticated", reason: "user_not_active" } as never) : ({ ok: true, ctx: id === 7n ? creator : userCtx("hq_manager", Number(id), brandScope) } as never)) },
    authorizer: createAuthorizer({ registry }),
    registry,
    auditWriter: { write: async (e, o) => void audits.push({ event: e.eventType.replace("judgement.", "") as JudgementAuditEvent, risk: o.risk, hasTx: o.tx !== undefined, detail: e.detail }) },
    config,
  });
  const onSleep: JudgementEnv["onSleep"] = { fn: null };
  const sleep: Sleep = async (ms) => {
    clock.advance(ms);
    await onSleep.fn?.();
  };
  return { fake, demand, clock, plans: j.plans, versions: j.versions, runs: j.runs, outcomes: j.outcomes, views: j.views, claim: j.claim, sleep, onSleep, facts: j.facts, authz: j.authz, audit: j.audit, audits, creator, other: userCtx("hq_manager", 8, brandScope), admin: userCtx("platform_admin", 1, ALL_SCOPE), revoked };
}
