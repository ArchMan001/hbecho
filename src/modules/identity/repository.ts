// 账号身份与当前归属的写入（R5、R7）。全部在调用方给定的短事务里完成，不做网络 IO。
// 标识永远是 (namespace, 原文)：哈希命中后复核原文；归属是账号上的当前单一事实，采集不抢占。
import { and, eq, isNull } from "drizzle-orm";
import type { DbTx } from "../../db/client";
import { externalAccountIdentifiers, externalAccounts, mediaStaff, staffAccountAssignments, stores } from "../../db/schema";
import { sha256Utf8 } from "../canonical-json";

export class IdentityError extends Error {
  constructor(
    readonly code: "identifier_text_mismatch" | "platform_mismatch",
    message: string,
  ) {
    super(message);
    this.name = "IdentityError";
  }
}

export interface IdentifierRef {
  namespace: string;
  value: string;
}

export interface IntakeInput {
  platformId: bigint;
  staffId: bigint;
  primary: IdentifierRef;
  /** 提交的原始入口（current_home_locator）。 */
  submittedLocator: string;
  /** 发给供应商的清洗后入口，取自已落地的请求字节（resolved_home_url，v2 §8.3：不是供应商确认的主页 URL）。 */
  cleanedLocator: string;
  intakeStatus: "normal" | "suspected_empty";
  now: Date;
}

export type IntakeResult =
  | { kind: "ready"; accountId: bigint; assignmentId: bigint; accountCreated: boolean; assignmentCreated: boolean; intakeStatus: "normal" | "suspected_empty" }
  | { kind: "assignment_conflict"; accountId: bigint; assignmentId: bigint; ownerStaffId: bigint | null; ownerWatchType: string }
  | { kind: "staff_platform_slot_taken"; existingAccountId: bigint; existingAssignmentId: bigint };

async function findIdentifier(tx: DbTx, ref: IdentifierRef) {
  const [row] = await tx
    .select()
    .from(externalAccountIdentifiers)
    .where(and(eq(externalAccountIdentifiers.namespaceCode, ref.namespace), eq(externalAccountIdentifiers.identifierSha256, sha256Utf8(ref.value))))
    .for("update");
  if (row && row.identifierValue !== ref.value) {
    throw new IdentityError("identifier_text_mismatch", "标识哈希命中但原文不同，拒绝合并");
  }
  return row;
}

async function slotHolder(tx: DbTx, staffId: bigint, platformId: bigint) {
  const [row] = await tx
    .select({ assignmentId: staffAccountAssignments.assignmentId, accountId: staffAccountAssignments.accountId })
    .from(staffAccountAssignments)
    .where(
      and(
        eq(staffAccountAssignments.staffId, staffId),
        eq(staffAccountAssignments.platformId, platformId),
        eq(staffAccountAssignments.watchType, "staff"),
        isNull(staffAccountAssignments.slotReleasedAt),
      ),
    )
    .for("update");
  return row;
}

export async function intakeAccount(tx: DbTx, i: IntakeInput): Promise<IntakeResult> {
  const found = await findIdentifier(tx, i.primary);

  let accountId: bigint;
  let accountCreated = false;
  if (found) {
    const [acct] = await tx.select().from(externalAccounts).where(eq(externalAccounts.accountId, found.accountId)).for("update");
    if (!acct) throw new Error("标识指向不存在的账号");
    if (acct.platformId !== i.platformId) throw new IdentityError("platform_mismatch", "标识所属账号属于另一个平台");
    accountId = acct.accountId;

    const [assn] = await tx.select().from(staffAccountAssignments).where(eq(staffAccountAssignments.accountId, accountId)).for("update");
    await touch(tx, accountId, found.accountIdentifierId, i.now);
    if (assn) {
      if (assn.watchType === "staff" && assn.staffId === i.staffId) {
        return {
          kind: "ready",
          accountId,
          assignmentId: assn.assignmentId,
          accountCreated: false,
          assignmentCreated: false,
          intakeStatus: assn.intakeStatus as "normal" | "suspected_empty",
        };
      }
      // 不抢占：既不改绑也不关闭原归属
      return { kind: "assignment_conflict", accountId, assignmentId: assn.assignmentId, ownerStaffId: assn.staffId, ownerWatchType: assn.watchType };
    }
  } else {
    // 新账号：名额冲突时不建账号（不留下无人归属的孤儿账号）
    const holder = await slotHolder(tx, i.staffId, i.platformId);
    if (holder) return { kind: "staff_platform_slot_taken", existingAccountId: holder.accountId, existingAssignmentId: holder.assignmentId };
    const [res] = await tx.insert(externalAccounts).values({
      platformId: i.platformId,
      firstSeenAt: i.now,
      lastSeenAt: i.now,
      createdAt: i.now,
      updatedAt: i.now,
    });
    accountId = BigInt(res.insertId);
    accountCreated = true;
    await tx.insert(externalAccountIdentifiers).values({
      accountId,
      namespaceCode: i.primary.namespace,
      identifierValue: i.primary.value,
      identifierSha256: sha256Utf8(i.primary.value),
      bindingMethod: "same_payload",
      confidence: "observed",
      firstSeenAt: i.now,
      lastSeenAt: i.now,
      createdAt: i.now,
    });
  }

  // 已有账号但没有归属（例如此前只有身份观察）：同样要检查名额
  if (!accountCreated) {
    const holder = await slotHolder(tx, i.staffId, i.platformId);
    if (holder) return { kind: "staff_platform_slot_taken", existingAccountId: holder.accountId, existingAssignmentId: holder.assignmentId };
  }

  const [a] = await tx.insert(staffAccountAssignments).values({
    watchType: "staff",
    staffId: i.staffId,
    accountId,
    platformId: i.platformId,
    monitoringEnabled: true,
    currentHomeLocator: i.submittedLocator,
    currentHomeLocatorSha256: sha256Utf8(i.submittedLocator),
    previousHomeLocator: null,
    previousHomeLocatorSha256: null,
    resolvedHomeUrl: i.cleanedLocator,
    resolvedHomeUrlSha256: sha256Utf8(i.cleanedLocator),
    intakeStatus: i.intakeStatus,
    createdAt: i.now,
    updatedAt: i.now,
  });
  return { kind: "ready", accountId, assignmentId: BigInt(a.insertId), accountCreated, assignmentCreated: true, intakeStatus: i.intakeStatus };
}

async function touch(tx: DbTx, accountId: bigint, identifierId: bigint, now: Date): Promise<void> {
  await tx.update(externalAccountIdentifiers).set({ lastSeenAt: now }).where(eq(externalAccountIdentifiers.accountIdentifierId, identifierId));
  await tx.update(externalAccounts).set({ lastSeenAt: now, updatedAt: now }).where(eq(externalAccounts.accountId, accountId));
}

export type SecondaryBinding = { kind: "bound" | "already_bound" } | { kind: "bound_to_other_account"; otherAccountId: bigint };

/** 同一 payload 明确关联的第二官方标识（same_payload）：已绑定到同账号则只更新观察时间；绑到别的账号则不动并报告冲突。 */
export async function bindSecondaryIdentifier(tx: DbTx, p: { accountId: bigint; ref: IdentifierRef; now: Date }): Promise<SecondaryBinding> {
  const found = await findIdentifier(tx, p.ref);
  if (found) {
    if (found.accountId !== p.accountId) return { kind: "bound_to_other_account", otherAccountId: found.accountId };
    await tx.update(externalAccountIdentifiers).set({ lastSeenAt: p.now }).where(eq(externalAccountIdentifiers.accountIdentifierId, found.accountIdentifierId));
    return { kind: "already_bound" };
  }
  await tx.insert(externalAccountIdentifiers).values({
    accountId: p.accountId,
    namespaceCode: p.ref.namespace,
    identifierValue: p.ref.value,
    identifierSha256: sha256Utf8(p.ref.value),
    bindingMethod: "same_payload",
    confidence: "observed",
    firstSeenAt: p.now,
    lastSeenAt: p.now,
    createdAt: p.now,
  });
  return { kind: "bound" };
}

/** 采集当时的归属快照（专员 → 门店 → 品牌）；external 型归属没有这三者，返回 null。 */
export async function loadOwnerSnapshot(tx: DbTx, assignmentId: bigint): Promise<{ staffId: bigint; storeId: bigint; brandId: bigint } | null> {
  const [row] = await tx
    .select({ staffId: mediaStaff.staffId, storeId: mediaStaff.storeId, brandId: stores.brandId, watchType: staffAccountAssignments.watchType })
    .from(staffAccountAssignments)
    .innerJoin(mediaStaff, eq(mediaStaff.staffId, staffAccountAssignments.staffId))
    .innerJoin(stores, eq(stores.storeId, mediaStaff.storeId))
    .where(eq(staffAccountAssignments.assignmentId, assignmentId));
  return row && row.watchType === "staff" ? { staffId: row.staffId, storeId: row.storeId, brandId: row.brandId } : null;
}
