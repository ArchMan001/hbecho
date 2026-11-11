// g-learning-min 服务测试的共用装配：真实 B 的授权器 / 出口 / 审计 / DataScope，假 OSS，FakeClock。
// 授权上下文用 B 的 buildDataScope 现建（不手写范围），所以角色 → 人员级别 / 品牌范围的映射就是生产用的那一份。
import { eq } from "drizzle-orm";
import type { TestDb } from "./db";
import { accessEnv, insertAccessUser, seedAccessOrg, type AccessEnv, type AccessOrg, type UserSpec } from "./access";
import { FakeCourseStore } from "./fake-course-store";
import { FakeVod } from "./fake-vod";
import { auditEvents, courseBrandScopes, courses, courseTags, tags } from "../../src/db/schema";
import {
  buildDataScope,
  capabilitiesOf,
  createAuthorizer,
  createEgress,
  createOrgDirectory,
  createRegistry,
  denialAuditor,
  type AuthContext,
  type RoleCode,
} from "../../src/modules/access-control";
import { DEFAULT_LEARNING_CONFIG, learningCourseStrategy, type LearningConfig, type LearningDeps } from "../../src/modules/learning";

export interface LearningEnv {
  env: AccessEnv;
  org: AccessOrg;
  store: FakeCourseStore;
  vod: FakeVod;
  deps: LearningDeps;
  /** 以指定角色建一个用户并返回他此刻的授权上下文（每次调用现建，不缓存）。 */
  actor(role: RoleCode, over?: { brandIds?: bigint[]; branchIds?: bigint[]; staff?: bigint }): Promise<AuthContext>;
  /** 直接插一门课（绕过服务层），返回 ID。 */
  insertCourse(over?: Partial<typeof courses.$inferInsert> & { brandIds?: bigint[]; tagIds?: bigint[] }): Promise<bigint>;
  insertTag(name: string): Promise<bigint>;
}

export async function learningEnv(t: TestDb, over: { config?: Partial<LearningConfig> } = {}): Promise<LearningEnv> {
  const env = accessEnv(t, { flow: false });
  const org = await seedAccessOrg(env);
  const dir = createOrgDirectory(t.db);
  const registry = createRegistry();
  registry.registerScopeStrategy("learning_course", learningCourseStrategy as never);
  const authorizer = createAuthorizer({ registry, onDenied: denialAuditor(env.audit) });
  const egress = createEgress({ authorizer, audit: env.audit });
  const store = new FakeCourseStore();
  const vod = new FakeVod();
  store.now = () => env.clock.now();
  vod.now = () => env.clock.now();
  const deps: LearningDeps = { db: t.db, clock: env.clock, authorizer, egress, audit: env.audit, store, vod, config: { ...DEFAULT_LEARNING_CONFIG, ...over.config } };

  let seq = 0;
  async function actor(role: RoleCode, o: { brandIds?: bigint[]; branchIds?: bigint[]; staff?: bigint } = {}): Promise<AuthContext> {
    const brandIds = o.brandIds ?? [];
    const branchIds = o.branchIds ?? [];
    const spec: UserSpec = { role, phone: `1390000${String(++seq).padStart(4, "0")}`, password: false, brandIds, branchIds };
    if (o.staff !== undefined) spec.mediaStaffId = o.staff;
    const userId = await insertAccessUser(env, spec);
    const scope = await buildDataScope({ role, mediaStaffId: o.staff ?? null, brandIds: new Set(brandIds), branchIds: new Set(branchIds) }, dir);
    return { kind: "user", actor: `user:${userId}`, userId, role, capabilities: capabilitiesOf(role), scope, sessionId: "s" };
  }

  const admin = actor("platform_admin");
  let n = 0;
  async function insertCourse(o: Partial<typeof courses.$inferInsert> & { brandIds?: bigint[]; tagIds?: bigint[] } = {}): Promise<bigint> {
    const { brandIds, tagIds, ...row } = o;
    const now = env.clock.now();
    n += 1;
    const [r] = await t.db.insert(courses).values({
      title: `课程 ${n}`,
      kind: "document",
      status: "published",
      brandScope: brandIds?.length ? "specified" : "all",
      coverKey: `cover/00000000-0000-0000-0000-${String(n).padStart(12, "0")}.png`,
      fileKey: `doc/00000000-0000-0000-0000-${String(n).padStart(12, "0")}.pdf`,
      fileMime: "application/pdf",
      fileSize: 1024,
      createdBy: (await admin).userId!,
      createdAt: now,
      updatedAt: now,
      ...(row.status && row.status !== "published" ? { unpublishedAt: now } : {}),
      ...row,
    });
    const courseId = BigInt(r.insertId);
    if (brandIds?.length) await t.db.insert(courseBrandScopes).values(brandIds.map((brandId) => ({ courseId, brandId })));
    if (tagIds?.length) await t.db.insert(courseTags).values(tagIds.map((tagId) => ({ courseId, tagId })));
    return courseId;
  }
  async function insertTag(name: string): Promise<bigint> {
    const [r] = await t.db.insert(tags).values({ name, createdAt: env.clock.now() });
    return BigInt(r.insertId);
  }
  return { env, org, store, vod, deps, actor, insertCourse, insertTag };
}

export const auditOf = (t: TestDb, eventType: string) => t.db.select().from(auditEvents).where(eq(auditEvents.eventType, eventType));

import { expect } from "vitest";
import { LearningError } from "../../src/modules/learning";
/** 期望一次调用以指定 HTTP 状态（和错误码）失败；返回错误，便于断言 detail。 */
export async function fails(p: Promise<unknown>, status: number, code?: string): Promise<LearningError> {
  const err = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(err).toBeInstanceOf(LearningError);
  expect((err as LearningError).status).toBe(status);
  if (code) expect((err as LearningError).code).toBe(code);
  return err as LearningError;
}
