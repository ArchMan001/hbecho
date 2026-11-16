// d-rule-engine 的测试世界：活动计划 + 名单 + 专员 + 账号 + 内容 + 快照 + 同步任务的工厂。
// 在 rosterWorld（品牌 HITACHI、分公司 101 已加入、门店 S-W1 等）之上再造，造数函数都说明「为什么这样造」。
import { eq } from "drizzle-orm";
import type { Db } from "../../src/db/client";
import { contents, contentSnapshots, syncCheckpoints, syncTasks } from "../../src/db/schema";
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
  const w = await rosterWorld(t);
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
export async function addCheckpoint(db: Db, accountId: bigint, continuityStatus: "ready" | "in_progress" | "rebased_after_gap" | "blocked", lastGapAt: Date | null = null): Promise<void> {
  await db.insert(syncCheckpoints).values({ accountId, providerId: await providerIdOf(db), anchorMode: "empty", cursorEnvelope: { kind: "null" }, cursorSha256: sha("cursor"), continuityStatus, lastGapAt, version: 1n, updatedAt: T0 });
}
