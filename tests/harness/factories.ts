// 数据库测试的最小行工厂：只填 NOT NULL 字段，其余留给各测试按需覆盖。
import { createHash } from "node:crypto";
import type { Db } from "../../src/db/client";
import {
  accountProfileSnapshots,
  contentSnapshots,
  contents,
  externalAccounts,
  mediaAssets,
  odsProviderCalls,
  ossObjects,
  staffAccountAssignments,
  syncBatches,
  syncTasks,
} from "../../src/db/schema";
import { platformIdOf, providerIdOf } from "./seed";

export const sha = (text: string): Buffer => createHash("sha256").update(text, "utf8").digest();
const ZERO = BigInt(0);

let batchSeq = 0;
export async function insertBatch(db: Db, now: Date, key = `batch-${++batchSeq}`): Promise<bigint> {
  const [r] = await db.insert(syncBatches).values({
    batchKey: sha(key),
    triggerType: "manual",
    purpose: "intake",
    logicalAt: now,
    status: "running",
    settingsVersion: 1n,
    settingsSnapshot: { initial_content_limit: 20 },
    createdAt: now,
    updatedAt: now,
  });
  return BigInt(r.insertId);
}

export async function insertAccount(db: Db, platform: string, now: Date, accountId?: bigint): Promise<bigint> {
  const [r] = await db.insert(externalAccounts).values({
    ...(accountId === undefined ? {} : { accountId }),
    platformId: await platformIdOf(db, platform),
    firstSeenAt: now,
    lastSeenAt: now,
    createdAt: now,
    updatedAt: now,
  });
  return accountId ?? BigInt(r.insertId);
}

export async function insertAssignment(
  db: Db,
  a: { accountId: bigint; platform: string; staffId: bigint; now: Date; locator?: string },
): Promise<bigint> {
  const locator = a.locator ?? `https://example.test/${a.accountId}`;
  const [r] = await db.insert(staffAccountAssignments).values({
    watchType: "staff",
    staffId: a.staffId,
    accountId: a.accountId,
    platformId: await platformIdOf(db, a.platform),
    currentHomeLocator: locator,
    currentHomeLocatorSha256: sha(locator),
    resolvedHomeUrl: locator,
    resolvedHomeUrlSha256: sha(locator),
    intakeStatus: "normal",
    createdAt: a.now,
    updatedAt: a.now,
  });
  return BigInt(r.insertId);
}

export async function insertTask(
  db: Db,
  t: { batchId: bigint; platform: string; now: Date; status?: string; action?: string; key?: string },
): Promise<bigint> {
  const [r] = await db.insert(syncTasks).values({
    batchId: t.batchId,
    providerId: await providerIdOf(db),
    platformId: await platformIdOf(db, t.platform),
    requestedAction: t.action ?? "resolve_account",
    subjectType: "media_staff",
    taskParameters: { schema_version: "data-foundation-tracer-task-parameters.v1", effective_initial_content_limit: 20 },
    idempotencyKey: sha(t.key ?? `task-${Math.random()}`),
    status: t.status ?? "pending",
    attemptCount: 0,
    maxAttempts: 3,
    expiresAt: new Date(t.now.getTime() + 365 * 24 * 3600 * 1000),
    createdAt: t.now,
    updatedAt: t.now,
  });
  return BigInt(r.insertId);
}

export async function insertPreparedCall(db: Db, taskId: bigint, platform: string, now: Date, seq = 1): Promise<bigint> {
  const [r] = await db.insert(odsProviderCalls).values({
    syncTaskId: taskId,
    providerId: await providerIdOf(db),
    platformId: await platformIdOf(db, platform),
    attemptNo: 1,
    callSequence: seq,
    requestedAction: "media_user_info",
    expectedResponseAction: "media_user_info",
    endpoint: "/openapi/v1/media_user_info",
    callStatus: "prepared",
    preparedAt: now,
    requestCapturedAt: now,
    expiresAt: new Date(now.getTime() + 365 * 24 * 3600 * 1000),
  });
  return BigInt(r.insertId);
}

export async function insertProfileSnapshot(
  db: Db,
  s: { batchId: bigint; accountId: bigint; assignmentId: bigint; now: Date; callId?: bigint },
): Promise<bigint> {
  const [r] = await db.insert(accountProfileSnapshots).values({
    batchId: s.batchId,
    accountId: s.accountId,
    assignmentId: s.assignmentId,
    providerId: await providerIdOf(db),
    ...(s.callId === undefined ? {} : { sourceProviderCallId: s.callId }),
    followerValue: ZERO,
    followerState: "value",
    followingValue: null,
    followingState: "missing",
    likeValue: null,
    likeState: "explicit_null",
    postValue: null,
    postState: "invalid",
    responseReceivedAt: s.now,
    adapterVersion: "aimaster-adapter.v1",
    createdAt: s.now,
  });
  return BigInt(r.insertId);
}

export async function insertContent(db: Db, c: { platform: string; accountId: bigint; platformContentId: string; now: Date }): Promise<bigint> {
  const [r] = await db.insert(contents).values({
    platformId: await platformIdOf(db, c.platform),
    accountId: c.accountId,
    platformContentId: c.platformContentId,
    platformContentIdSha256: sha(c.platformContentId),
    firstSeenAt: c.now,
    lastSeenAt: c.now,
    createdAt: c.now,
    updatedAt: c.now,
  });
  return BigInt(r.insertId);
}

export async function insertContentSnapshot(db: Db, s: { batchId: bigint; contentId: bigint; now: Date; status?: "building" | "finalized" }): Promise<bigint> {
  const status = s.status ?? "building";
  const [r] = await db.insert(contentSnapshots).values({
    batchId: s.batchId,
    contentId: s.contentId,
    snapshotStatus: status,
    durationState: "missing",
    playState: "unsupported",
    likeState: "value",
    likeValue: ZERO,
    commentState: "missing",
    collectState: "missing",
    shareState: "missing",
    forwardState: "missing",
    snapshotAt: s.now,
    mergePolicyVersion: "merge.v1",
    finalizedAt: status === "finalized" ? s.now : null,
    createdAt: s.now,
    updatedAt: s.now,
  });
  return BigInt(r.insertId);
}

export async function insertOssObject(
  db: Db,
  o: { category: "ods" | "media" | "temp"; key: string; now: Date },
): Promise<bigint> {
  const [r] = await db.insert(ossObjects).values({
    objectCategory: o.category,
    providerCode: "aliyun-oss",
    region: "cn-beijing",
    bucket: "hbecho-test",
    objectKey: o.key,
    storageClass: "Standard",
    encryptionMode: "SSE-OSS",
    status: "pending",
    createdAt: o.now,
    updatedAt: o.now,
  });
  return BigInt(r.insertId);
}

export async function insertMediaAsset(db: Db, a: { key: string; now: Date; hex?: string }): Promise<bigint> {
  const obj = await insertOssObject(db, { category: "media", key: a.key, now: a.now });
  const [r] = await db.insert(mediaAssets).values({
    sha256: sha(a.hex ?? a.key),
    byteLength: 10n,
    mediaKind: "image",
    mimeType: "image/jpeg",
    ossObjectId: obj,
    verificationStatus: "verified",
    verifiedAt: a.now,
    createdAt: a.now,
  });
  return BigInt(r.insertId);
}
