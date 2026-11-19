// f-video-square 服务测试的共用装配：真实 B 的授权器 / 审计 / DataScope，假封面签名器，FakeClock。
// 造数函数按「账号 → 作品」两步：一个专员在一个平台同一时刻只能占一个账号名额，所以一个账号下可以挂很多作品。
import { eq } from "drizzle-orm";
import { accessEnv, insertAccessUser, seedAccessOrg, type AccessEnv, type AccessOrg } from "./access";
import type { Db } from "../../src/db/client";
import type { TestDb } from "./db";
import { insertAccount, insertAssignment, insertBatch, insertContent, insertContentSnapshot, insertMediaAsset, insertProfileSnapshot, sha } from "./factories";
import {
  buildDataScope,
  capabilitiesOf,
  createAuthorizer,
  createOrgDirectory,
  createRegistry,
  denialAuditor,
  type AuthContext,
  type RoleCode,
} from "../../src/modules/access-control";
import { accountProfileSnapshots, contentSnapshots, contents, externalAccounts, mediaReferences, ossObjects, staffAccountAssignments } from "../../src/db/schema";
import { platformIdOf } from "./seed";
import { createSquareStrategy, type SquareDeps } from "../../src/modules/video-square";

export class FakeCovers {
  readonly signed: Array<{ key: string; ttlSeconds: number }> = [];
  /** 对匹配的 key 抛错（验证单卡失败不影响整页）。 */
  failFor: ((key: string) => boolean) | null = null;
  async signedGetUrl(key: string, ttlSeconds: number): Promise<string> {
    if (this.failFor?.(key)) throw new Error("OSS signatureUrl 失败（test）");
    this.signed.push({ key, ttlSeconds });
    return `https://fake-media.test/${key}?ttl=${ttlSeconds}`;
  }
}

export type StoreKey = "A" | "B" | "C";
export interface AccountSpec {
  /** A = 北京海信（专员甲）；B = 北京日立（专员乙）；C = 上海海信（专员丙）。 */
  store?: StoreKey;
  platform?: "douyin" | "xiaohongshu" | "kuaishou";
  /** staff = 专员名下在用；released = 名额已释放；external = 外部监控账号（竞品 / 官方号）。 */
  assignment?: "staff" | "released" | "external";
  nickname?: string | null;
}
export interface WorkSpec {
  kind?: "video" | "image" | "text" | "unknown";
  title?: string;
  /** 数值；likeState 非 value 时忽略。 */
  like?: number | bigint;
  likeState?: "value" | "missing" | "explicit_null" | "invalid" | "unsupported";
  comment?: number | null;
  publishedAt?: Date | null;
  shareUrl?: string | null;
  contentStatus?: "active" | "unavailable" | "deleted";
  snapshot?: "finalized" | "building";
  /** 给当前快照挂一张已归档的 cover_normalized。 */
  cover?: boolean;
}

export interface SquareEnv {
  env: AccessEnv;
  org: AccessOrg;
  deps: SquareDeps;
  covers: FakeCovers;
  alerts: unknown[];
  /** 以指定角色建一个用户并返回他此刻的授权上下文（每次调用现建，不缓存）。 */
  actor(role: RoleCode, over?: { brandIds?: bigint[]; branchIds?: bigint[]; staff?: bigint }): Promise<AuthContext>;
  addAccount(spec?: AccountSpec): Promise<bigint>;
  addWork(accountId: bigint, spec?: WorkSpec): Promise<{ contentId: bigint; snapshotId: bigint }>;
}

export async function squareEnv(t: TestDb): Promise<SquareEnv> {
  const env = accessEnv(t, { flow: false });
  const org = await seedAccessOrg(env);
  const dir = createOrgDirectory(t.db);
  const registry = createRegistry();
  registry.registerScopeStrategy("content_square", createSquareStrategy(t.db) as never);
  const authorizer = createAuthorizer({ registry, onDenied: denialAuditor(env.audit) });
  const covers = new FakeCovers();
  const alerts: unknown[] = [];
  const deps: SquareDeps = { db: t.db, clock: env.clock, authorizer, audit: env.audit, covers, coverTtlSeconds: 900, alert: (e) => void alerts.push(e) };
  let seq = 0;
  async function actor(role: RoleCode, o: { brandIds?: bigint[]; branchIds?: bigint[]; staff?: bigint } = {}): Promise<AuthContext> {
    const brandIds = o.brandIds ?? [];
    const branchIds = o.branchIds ?? [];
    const userId = await insertAccessUser(env, {
      role,
      phone: `1370000${String(++seq).padStart(4, "0")}`,
      password: false,
      brandIds,
      branchIds,
      ...(o.staff !== undefined ? { mediaStaffId: o.staff } : {}),
    });
    const scope = await buildDataScope({ role, mediaStaffId: o.staff ?? null, brandIds: new Set(brandIds), branchIds: new Set(branchIds) }, dir);
    return { kind: "user", actor: `user:${userId}`, userId, role, capabilities: capabilitiesOf(role), scope, sessionId: "s" };
  }
  const staffOf = (k: StoreKey): bigint => ({ A: org.staffA, B: org.staffB, C: org.staffC })[k];
  let n = 0;
  return {
    env,
    org,
    deps,
    covers,
    alerts,
    actor,
    addAccount: (spec = {}) => seedSquareAccount(t.db, spec.assignment === "external" ? null : staffOf(spec.store ?? "A"), spec, env.clock.now()),
    addWork: (accountId, w = {}) => seedSquareWork(t.db, accountId, w, env.clock.now(), ++n),
  };
}

/** 造一个账号及其归属（staffId 为 null = 外部监控账号）。预览环境（tests/demo/preview.ts）与服务测试共用。 */
export async function seedSquareAccount(db: Db, staffId: bigint | null, spec: AccountSpec, now: Date): Promise<bigint> {
  const platform = spec.platform ?? "douyin";
  const accountId = await insertAccount(db, platform, now);
  let assignmentId: bigint;
  if (staffId === null) {
    const locator = `https://example.test/ext/${accountId}`;
    const [r] = await db.insert(staffAccountAssignments).values({
      watchType: "external",
      accountId,
      platformId: await platformIdOf(db, platform),
      currentHomeLocator: locator,
      currentHomeLocatorSha256: sha(locator),
      resolvedHomeUrl: locator,
      resolvedHomeUrlSha256: sha(locator),
      intakeStatus: "normal",
      createdAt: now,
      updatedAt: now,
    });
    assignmentId = BigInt(r.insertId);
  } else {
    assignmentId = await insertAssignment(db, { accountId, platform, staffId, now });
    if (spec.assignment === "released") await db.update(staffAccountAssignments).set({ slotReleasedAt: now }).where(eq(staffAccountAssignments.assignmentId, assignmentId));
  }
  if (spec.nickname !== null) {
    const profile = await insertProfileSnapshot(db, { batchId: await insertBatch(db, now), accountId, assignmentId, now });
    await db.update(accountProfileSnapshots).set({ nickname: spec.nickname ?? `账号${accountId}` }).where(eq(accountProfileSnapshots.profileSnapshotId, profile));
    await db.update(externalAccounts).set({ currentProfileSnapshotId: profile, currentProfileSelectedAt: now }).where(eq(externalAccounts.accountId, accountId));
  }
  return accountId;
}

/** 造一条作品及其当前快照；`seq` 只用来让平台内容 ID 与封面对象 key 不重复。 */
export async function seedSquareWork(db: Db, accountId: bigint, w: WorkSpec, now: Date, seq: number): Promise<{ contentId: bigint; snapshotId: bigint }> {
  const [acc] = await db.select({ platformId: externalAccounts.platformId }).from(externalAccounts).where(eq(externalAccounts.accountId, accountId));
  const contentId = BigInt(
    (
      await db.insert(contents).values({
        platformId: acc!.platformId,
        accountId,
        platformContentId: `work-${seq}`,
        platformContentIdSha256: sha(`work-${seq}`),
        contentKind: w.kind ?? "video",
        status: w.contentStatus ?? "active",
        firstSeenAt: now,
        lastSeenAt: now,
        createdAt: now,
        updatedAt: now,
      })
    )[0].insertId,
  );
  const snapshotId = await insertContentSnapshot(db, { batchId: await insertBatch(db, now), contentId, now, status: w.snapshot ?? "finalized" });
  const likeState = w.likeState ?? "value";
  const comment = w.comment === undefined ? 5 : w.comment;
  const shareUrl = w.shareUrl === undefined ? `https://www.douyin.test/video/${seq}` : w.shareUrl;
  await db
    .update(contentSnapshots)
    .set({
      title: w.title ?? `作品 ${seq}`,
      likeState,
      likeValue: likeState === "value" ? BigInt(w.like ?? 100) : null,
      commentState: comment === null ? "missing" : "value",
      commentValue: comment === null ? null : BigInt(comment),
      publishedAt: w.publishedAt === undefined ? new Date(now.getTime() - 3 * 86_400_000) : w.publishedAt,
      shareUrl,
      shareUrlSha256: shareUrl === null ? null : sha(shareUrl),
    })
    .where(eq(contentSnapshots.contentSnapshotId, snapshotId));
  await db.update(contents).set({ currentSnapshotId: snapshotId, currentSnapshotSelectedAt: now }).where(eq(contents.contentId, contentId));
  if (w.cover) {
    const key = `media/cover-${seq}.jpg`;
    const asset = await insertMediaAsset(db, { key, now });
    await db.update(ossObjects).set({ status: "available", byteLength: 10n, sha256: sha(`cover-${seq}`), verifiedAt: now }).where(eq(ossObjects.objectKey, key));
    await db.insert(mediaReferences).values({ contentSnapshotId: snapshotId, role: "cover_normalized", slotIndex: 0, observedAt: now, mediaAssetId: asset, archiveStatus: "archived", createdAt: now, updatedAt: now });
  }
  return { contentId, snapshotId };
}
