// 数据出口框架的契约测试（任务 10；AX-9，acceptance I1–I14）。用 fake 出口，各域接入时可照此复用。
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { accessEnv, accessLinkage, insertAccessUser, loginAs, seedAccessOrg, type AccessEnv, type AccessOrg } from "../../../tests/harness/access";
import { useTestDb } from "../../../tests/harness/db";
import { accessUserBranches, accessUserBrands, accessUsers, auditEvents } from "../../db/schema";
import { createAuthenticator } from "./authenticate";
import { createAuthorizer, type AuthContext } from "./authorize";
import { createEgress, EXIT_KEYS, exportCapabilityFor, MAX_SIGNED_LINK_TTL_SECONDS, parseScope, serializeScope, type Egress, type ExitNo } from "./egress";
import { CAPABILITIES, type Capability } from "./roles";
import { createRegistry, createOrgDirectory, createStoreStrategy, type DataScope } from "./scope";
import { serviceCapabilities } from "./service-principals";
import { createUserAdmin } from "./users/admin";

const t = useTestDb();
let env: AccessEnv;
let org: AccessOrg;
let egress: Egress;
let alerts: Array<{ code: string; name: string; userActor: string }>;
let authn: ReturnType<typeof createAuthenticator>;

// raw_payload 是 B 自带的「仅平台级」策略，不重复注册
const KEYS = ["account", "report", "media", "content", "notification", "learning_course"] as const;
const PLATFORM: DataScope = { brands: "all", branches: "all", self: { kind: "none" }, level: 3 };

beforeEach(async () => {
  env = accessEnv(t);
  org = await seedAccessOrg(env);
  const dir = createOrgDirectory(t.db);
  const registry = createRegistry();
  for (const k of KEYS) registry.registerScopeStrategy(k, createStoreStrategy(dir) as never); // fake 出口：全部按门店判断
  alerts = [];
  egress = createEgress({ authorizer: createAuthorizer({ registry }), audit: env.audit, alert: (a) => void alerts.push(a) });
  authn = createAuthenticator({ db: t.db, auth: env.auth, dir, linkage: accessLinkage(env, { dir }) });
});

/** 手工构造的上下文：所有能力 / 指定范围。守卫逻辑与角色矩阵无关，所以不依赖矩阵。 */
const scopeOf = (brands: bigint[], branches: bigint[]): DataScope => ({ brands: new Set(brands), branches: new Set(branches), self: { kind: "none" }, level: 2 });
const userCtx = (over: Partial<AuthContext> = {}): AuthContext => ({
  kind: "user",
  actor: "user:5",
  userId: 5n,
  role: "branch_manager",
  capabilities: new Set(CAPABILITIES),
  scope: scopeOf([org.hisense], [org.bj]),
  sessionId: "s",
  ...over,
});
const serviceCtx = (name: "service:sync-worker" | "service:plan-worker", over: Partial<AuthContext> = {}): AuthContext => ({
  kind: "service",
  actor: name,
  userId: null,
  role: null,
  capabilities: serviceCapabilities(name),
  scope: { brands: "all", branches: "all", self: { kind: "none" }, level: 3 },
  sessionId: null,
  ...over,
});
const auditRows = (type?: string) => (type ? t.db.select().from(auditEvents).where(eq(auditEvents.eventType, type)) : t.db.select().from(auditEvents));

/** 十个出口各一份：动作、资源键、该出口对守卫的特殊要求。 */
const FAKE_EXITS: Array<{ exit: ExitNo; capability: Capability; key?: (typeof KEYS)[number] | "raw_payload"; audited: boolean; extra?: { rowLimit: number } }> = [
  { exit: 1, capability: "data.account.read", key: "account", audited: false },
  { exit: 2, capability: "data.sync.trigger", key: "account", audited: true },
  { exit: 3, capability: "report.read", key: "report", audited: false },
  { exit: 4, capability: "data.export", key: "account", audited: true },
  { exit: 5, capability: "data.media.read", key: "media", audited: false },
  { exit: 6, capability: "data.raw_payload.read", key: "raw_payload", audited: true },
  { exit: 8, capability: "data.content.read", key: "content", audited: true, extra: { rowLimit: 50 } },
  { exit: 9, capability: "report.read", key: "notification", audited: false },
  { exit: 10, capability: "learning.read", key: "learning_course", audited: true },
];
const req = (f: (typeof FAKE_EXITS)[number], storeId: bigint) => ({ capability: f.capability, resource: { key: f.key!, ref: { storeId } }, ...(f.extra ?? {}) });

describe("十个出口各一条「动作权限 + 范围」守卫用例（I1）", () => {
  for (const f of FAKE_EXITS) {
    it(`出口 ${f.exit} ${EXIT_KEYS[f.exit]}：范围内放行；范围外 = 未找到；缺动作权限 = 403；动作不属于该出口 / 缺资源被拒`, async () => {
      // 原始载荷（出口 6）的范围策略是 B 自带的「仅平台级」：只有平台级范围放行，分公司范围一律不在范围内
      const inScope = f.exit === 6 ? userCtx({ scope: PLATFORM }) : userCtx();
      const outScope = f.exit === 6 ? userCtx() : userCtx();
      expect(await egress.guardExit(f.exit, inScope, req(f, org.storeA))).toMatchObject({ ok: true });
      expect(await egress.guardExit(f.exit, outScope, req(f, f.exit === 6 ? org.storeA : org.storeC))).toMatchObject({ ok: false, kind: "not_found", reason: "out_of_scope" }); // 上海店
      expect(await egress.guardExit(f.exit, userCtx({ capabilities: new Set(), scope: inScope.scope }), req(f, org.storeA))).toMatchObject({ ok: false, kind: "forbidden" });
      expect(await egress.guardExit(f.exit, userCtx(), { capability: f.capability, ...(f.extra ?? {}) })).toMatchObject({ ok: false, reason: "scope_required" });
      if (f.exit === 4 || f.exit === 2 || f.exit === 6 || f.exit === 10 || f.exit === 3 || f.exit === 5) {
        expect(await egress.guardExit(f.exit, userCtx(), { ...req(f, org.storeA), capability: "user.manage" })).toMatchObject({ ok: false, reason: "exit_not_allowed" });
      }
    });
  }

  it("出口 7 后台 Worker：合法服务身份放行；带角色的服务身份（伪造超管）被拒；用户触发的任务继承提交者", async () => {
    expect(await egress.guardExit(7, serviceCtx("service:sync-worker"), { capability: "data.sync.trigger" })).toMatchObject({ ok: true });
    expect(await egress.guardExit(7, serviceCtx("service:sync-worker", { role: "platform_admin" }), { capability: "data.sync.trigger" })).toMatchObject({ ok: false, reason: "service_principal_forbidden" });
    expect(await egress.guardExit(7, serviceCtx("service:sync-worker"), { capability: "user.manage" })).toMatchObject({ ok: false, reason: "service_principal_forbidden" });
    expect(await egress.guardExit(7, userCtx(), { capability: "data.sync.trigger" })).toMatchObject({ ok: true }); // 继承提交者
    expect(await egress.guardExit(7, userCtx({ capabilities: new Set() }), { capability: "data.sync.trigger" })).toMatchObject({ ok: false });
  });

  it("计划任务身份调用导出 / 原始载荷 / 媒资 / 学习下载被拒（I9）", async () => {
    for (const [exit, capability] of [[4, "data.export"], [4, "report.export"], [6, "data.raw_payload.read"], [5, "data.media.read"], [10, "learning.read"]] as const) {
      expect(await egress.guardExit(exit, serviceCtx("service:plan-worker"), { capability, resource: { key: "account", ref: { storeId: org.storeA } } })).toMatchObject({ ok: false, reason: "service_principal_forbidden" });
    }
  });

  it("出口 8 AI 工具取数：必须声明行数上限，守卫原样带回", async () => {
    const f = FAKE_EXITS.find((x) => x.exit === 8)!;
    expect(await egress.guardExit(8, userCtx(), { capability: f.capability, resource: { key: "content", ref: { storeId: org.storeA } } })).toMatchObject({ ok: false, reason: "row_limit_required" });
    expect(await egress.guardExit(8, userCtx(), { ...req(f, org.storeA), rowLimit: 0 })).toMatchObject({ ok: false, reason: "row_limit_required" });
    expect(await egress.guardExit(8, userCtx(), req(f, org.storeA))).toEqual({ ok: true, rowLimit: 50 });
  });

  it("出口 9 通知：按接收者当前范围复查，范围外的摘要不发（I11）", async () => {
    const f = FAKE_EXITS.find((x) => x.exit === 9)!;
    const receiver = userCtx({ actor: "user:8", userId: 8n });
    expect(await egress.guardExit(9, receiver, req(f, org.storeA))).toMatchObject({ ok: true });
    expect(await egress.guardExit(9, receiver, req(f, org.storeC))).toMatchObject({ ok: false, kind: "not_found" });
  });
});

describe("审计（I13、I14）", () => {
  it("需要审计的出口，允许与拒绝都记；不需要的不记；学习资料下载含操作者 / 课程 / 文件标识 / 时间 / 结果", async () => {
    const learn = { capability: "learning.read" as const, resource: { key: "learning_course", ref: { storeId: org.storeA } }, audit: { targetType: "course", targetId: "C-9", detail: { fileId: "F-1" } } };
    await egress.guardExit(10, userCtx(), learn);
    await egress.guardExit(10, userCtx({ capabilities: new Set() }), learn);
    await egress.guardExit(1, userCtx(), { capability: "data.account.read", resource: { key: "account", ref: { storeId: org.storeA } } });
    const rows = await auditRows("egress.learning_download");
    expect(rows).toHaveLength(2);
    const ok = rows.find((r) => r.outcome === "succeeded")!;
    expect(ok).toMatchObject({ actor: "user:5", targetType: "course", targetId: "C-9", reasonCode: "egress_allowed" });
    expect(ok.detail).toMatchObject({ exit: 10, fileId: "F-1" });
    expect(ok.occurredAt).toEqual(env.clock.now());
    expect(rows.find((r) => r.outcome === "denied")!.reasonCode).toBe("capability_not_granted");
    expect(await auditRows("egress.page_query")).toHaveLength(0); // 页面查询（含看手机号）不逐条记审计
  });

  it("批量导出（出口 4）由调用方标注含手机号，记一条", async () => {
    await egress.guardExit(4, userCtx(), { capability: "data.export", resource: { key: "account", ref: { storeId: org.storeA } }, audit: { targetType: "export_job", targetId: "J-1", detail: { includesPhone: true, rows: 120 } } });
    const [r] = await auditRows("egress.export_file");
    expect(r!.detail).toMatchObject({ includesPhone: true, rows: 120 });
  });
});

describe("data.export 与 report.export（I12）", () => {
  it("按导出物主结构划分；点检表下钻明细算 report.export；回流文件不属于这两个出口", () => {
    expect(exportCapabilityFor("raw_objects")).toBe("data.export");
    expect(exportCapabilityFor("report_artifact")).toBe("report.export");
    expect(exportCapabilityFor("report_drilldown")).toBe("report.export");
  });
  it("出口 4 只接受这两个动作", async () => {
    const r = (capability: string) => ({ capability, resource: { key: "account", ref: { storeId: org.storeA } } });
    expect(await egress.guardExit(4, userCtx(), r("data.export"))).toMatchObject({ ok: true });
    expect(await egress.guardExit(4, userCtx(), r("report.export"))).toMatchObject({ ok: true });
    expect(await egress.guardExit(4, userCtx(), r("data.account.read"))).toMatchObject({ ok: false, reason: "exit_not_allowed" });
  });
});

describe("异步任务：范围只收窄（I2、I3、I4、I8）", () => {
  async function bm() {
    const id = await insertAccessUser(env, { role: "branch_manager", phone: "13000000003", brandIds: [org.hisense], branchIds: [org.bj] });
    const ctx = async (): Promise<AuthContext | null> => {
      const r = await authn.contextForUser(id, null);
      return r.ok ? r.ctx : null;
    };
    return { id, ctx };
  }

  it("序列化往返：提交时的范围快照可以存进任务表再取出", async () => {
    const { ctx } = await bm();
    const s = egress.snapshotForJob((await ctx())!, "data.export");
    const back = parseScope(JSON.parse(JSON.stringify(serializeScope(s.submittedScope))));
    expect(back).toEqual(s.submittedScope);
  });

  it("任务继承提交者身份，不用服务身份；服务身份提交快照被拒", async () => {
    const { ctx } = await bm();
    expect(egress.snapshotForJob((await ctx())!, "data.export").actor).toMatch(/^user:/);
    expect(() => egress.snapshotForJob(serviceCtx("service:plan-worker"), "data.sync.trigger")).toThrow();
  });

  it("提交后扩权：旧任务有效范围不变（I3）", async () => {
    const { id, ctx } = await bm();
    const snap = egress.snapshotForJob((await ctx())!, "data.export");
    await t.db.insert(accessUserBrands).values({ userId: id, brandId: org.hitachi });
    await t.db.insert(accessUserBranches).values({ userId: id, branchId: org.sh });
    const now = (await ctx())!;
    expect(now.scope.brands).toEqual(new Set([org.hisense, org.hitachi])); // 当前范围确实变大了
    const d = await egress.checkJobAtExecution(snap, now);
    expect(d).toMatchObject({ action: "run", narrowed: false });
    if (d.action === "run") expect(d.scope).toEqual(snap.submittedScope);
  });

  it("提交后部分撤权：有效范围 = 交集（收窄）；全部撤光则取消并审计 delivery_scope_shrunk（I4）", async () => {
    const { id, ctx } = await bm();
    // 先给两个品牌 + 两个分公司，提交；再收回一个品牌
    await t.db.insert(accessUserBrands).values({ userId: id, brandId: org.hitachi });
    const snap = egress.snapshotForJob((await ctx())!, "data.export");
    await t.db.delete(accessUserBrands).where(eq(accessUserBrands.brandId, org.hitachi));
    const d1 = await egress.checkJobAtExecution(snap, (await ctx())!);
    expect(d1).toMatchObject({ action: "run", narrowed: true });
    if (d1.action === "run") expect(d1.scope.brands).toEqual(new Set([org.hisense]));
    // 分公司换成上海：与提交时的北京没有交集 → 取消
    await t.db.delete(accessUserBranches).where(eq(accessUserBranches.userId, id));
    await t.db.insert(accessUserBranches).values({ userId: id, branchId: org.sh });
    expect(await egress.checkJobAtExecution(snap, (await ctx())!)).toEqual({ action: "cancel", reason: "scope_empty" });
    const ev = (await auditRows("egress.job_cancelled")).filter((r) => r.reasonCode === "delivery_scope_shrunk");
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ actor: `user:${id}`, outcome: "denied" });
  });

  it("三个检查点任一处撤权都不交付：提交时 / 执行时 / 交付前（I2）", async () => {
    const { id, ctx } = await bm();
    const resource = { key: "account", ref: { storeId: org.storeA } };
    // 检查点 1：提交时（出口 4 守卫）
    expect(await egress.guardExit(4, (await ctx())!, { capability: "data.export", resource })).toMatchObject({ ok: true });
    const snap = egress.snapshotForJob((await ctx())!, "data.export");
    const artifact = { scope: snap.submittedScope, rebuildable: false };
    expect(egress.recheckDelivery(artifact, (await ctx())!)).toBe("deliver");

    // 撤权：降为门店专员（没有 data.export，且范围由门店推出）——在三个检查点分别验证
    await t.db.update(accessUsers).set({ roleCode: "store_staff", mediaStaffId: org.staffC }).where(eq(accessUsers.userId, id));
    await t.db.delete(accessUserBrands).where(eq(accessUserBrands.userId, id));
    await t.db.delete(accessUserBranches).where(eq(accessUserBranches.userId, id));
    const revoked = (await ctx())!;
    expect(await egress.guardExit(4, revoked, { capability: "data.export", resource })).toMatchObject({ ok: false }); // 提交时
    expect(await egress.checkJobAtExecution(snap, revoked)).toMatchObject({ action: "cancel" }); // 执行时
    expect(egress.recheckDelivery(artifact, revoked)).toBe("deny"); // 交付前
  });

  it("用户已停用：执行时取消（user_not_active）", async () => {
    const { id, ctx } = await bm();
    const snap = egress.snapshotForJob((await ctx())!, "data.export");
    await t.db.update(accessUsers).set({ status: "disabled", statusBeforeDisable: "active", disabledAt: env.clock.now(), disabledByActor: "user:0", disabledReason: "manual" }).where(eq(accessUsers.userId, id));
    expect(await ctx()).toBeNull();
    expect(await egress.checkJobAtExecution(snap, null)).toEqual({ action: "cancel", reason: "user_not_active" });
  });
});

describe("recheckDelivery（I5）", () => {
  it("产物范围 ⊆ 当前范围 → deliver；不⊆但可重建 → rebuild；不可重建 → deny；当前范围为空不重建", () => {
    const art = { scope: scopeOf([10n, 11n], [20n]), rebuildable: true };
    expect(egress.recheckDelivery(art, userCtx({ scope: scopeOf([10n, 11n, 12n], [20n, 21n]) }))).toBe("deliver");
    expect(egress.recheckDelivery(art, userCtx({ scope: scopeOf([10n], [20n]) }))).toBe("rebuild");
    expect(egress.recheckDelivery({ ...art, rebuildable: false }, userCtx({ scope: scopeOf([10n], [20n]) }))).toBe("deny");
    expect(egress.recheckDelivery(art, userCtx({ scope: scopeOf([], [20n]) }))).toBe("deny");
  });
});

describe("撤权取消用户任务（I6、I7）", () => {
  it("取消该用户触发的未完成任务；计划任务（服务身份）与别的用户的任务不受影响", async () => {
    const jobs = [
      { id: 1, owner: "user:5", done: false },
      { id: 2, owner: "user:5", done: true },
      { id: 3, owner: "user:6", done: false },
      { id: 4, owner: "service:plan-worker", done: false },
    ];
    const cancelled = new Set<number>();
    egress.registerJobCanceller("export", async (actor) => {
      const mine = jobs.filter((j) => j.owner === actor && !j.done);
      mine.forEach((j) => cancelled.add(j.id));
      return mine.length;
    });
    const r = await egress.cancelUserJobs("user:5");
    expect(r).toEqual({ byName: { export: 1 }, failed: [] });
    expect([...cancelled]).toEqual([1]);
    // 对服务身份调用什么也不做
    expect(await egress.cancelUserJobs("service:plan-worker")).toEqual({ byName: {}, failed: [] });
    expect([...cancelled]).toEqual([1]);
    const [ev] = await auditRows("egress.jobs_cancelled");
    expect(ev).toMatchObject({ reasonCode: "job_cancelled_on_revoke", actor: "service:access-worker", targetId: "5", outcome: "succeeded" });
  });

  it("部分 canceller 失败：其余照常、告警 + 审计，不抛", async () => {
    egress.registerJobCanceller("export", async () => 2);
    egress.registerJobCanceller("sync", async () => {
      throw new Error("boom");
    });
    egress.registerJobCanceller("ai", async () => 1);
    const r = await egress.cancelUserJobs("user:5");
    expect(r).toEqual({ byName: { export: 2, ai: 1 }, failed: ["sync"] });
    expect(alerts).toEqual([{ code: "job_canceller_failed", name: "sync", userActor: "user:5" }]);
    const [ev] = await auditRows("egress.jobs_cancelled");
    expect(ev).toMatchObject({ outcome: "failed", reasonCode: "job_cancelled_on_revoke" });
    expect(() => egress.registerJobCanceller("sync", async () => 0)).toThrow(); // 不允许重复注册
  });

  it("接入用户管理：停用与『收窄』的变更在提交后取消任务，晋升不取消；取消失败不回滚停用", async () => {
    const cancel = vi.fn(async (_a: string) => {});
    const admin = createUserAdmin({ db: t.db, clock: env.clock, audit: env.audit, dir: createOrgDirectory(t.db), authorizer: createAuthorizer(), onRevoked: cancel });
    await insertAccessUser(env, { role: "platform_admin", phone: "13000000001" });
    const r = await authn.authenticate(await loginAs(env, "13000000001"));
    if (!r.ok) throw new Error(r.reason);
    const target = await insertAccessUser(env, { role: "branch_manager", phone: "13000000003", brandIds: [org.hisense, org.hitachi], branchIds: [org.bj] });

    await admin.changeAccess(r.ctx, target, { displayName: "改名" });
    await admin.changeAccess(r.ctx, target, { role: "hq_manager", brandIds: [org.hisense, org.hitachi] }); // 晋升
    expect(cancel).not.toHaveBeenCalled();
    await admin.changeAccess(r.ctx, target, { role: "hq_manager", brandIds: [org.hisense] }); // 拿掉一个品牌
    expect(cancel).toHaveBeenCalledWith(`user:${target}`);
    cancel.mockClear();
    await admin.changeAccess(r.ctx, target, { role: "branch_manager", brandIds: [org.hisense], branchIds: [org.bj] }); // 降级
    expect(cancel).toHaveBeenCalledTimes(1);
    cancel.mockClear();
    await admin.disable(r.ctx, target);
    expect(cancel).toHaveBeenCalledTimes(1);

    const failing = createUserAdmin({ db: t.db, clock: env.clock, audit: env.audit, dir: createOrgDirectory(t.db), authorizer: createAuthorizer(), onRevoked: async (a) => void (await egress.cancelUserJobs(a)) });
    egress.registerJobCanceller("x", async () => {
      throw new Error("boom");
    });
    const t2 = await insertAccessUser(env, { role: "branch_manager", phone: "13000000004", brandIds: [org.hisense], branchIds: [org.bj] });
    await failing.disable(r.ctx, t2);
    expect((await t.db.select().from(accessUsers).where(eq(accessUsers.userId, t2)))[0]!.status).toBe("disabled");
    expect(alerts).toHaveLength(1);
  });
});

describe("签名链接（I10）", () => {
  const resource = { key: "media", ref: { storeId: 0n } };
  it("短期有效（有上限）；每次签发都重新守卫，撤权后不能续签", async () => {
    const sign = vi.fn(async (ttl: number) => `https://oss.example/x?ttl=${ttl}`);
    const good = { capability: "data.media.read" as const, resource: { ...resource, ref: { storeId: org.storeA } } };
    const a = await egress.issueSignedLink(userCtx(), good, sign, 300, env.clock.now());
    expect(a).toMatchObject({ ok: true, url: "https://oss.example/x?ttl=300" });
    if (a.ok) expect(a.expiresAt.getTime()).toBe(env.clock.now().getTime() + 300_000);
    // 有效期上限
    expect(await egress.issueSignedLink(userCtx(), good, sign, MAX_SIGNED_LINK_TTL_SECONDS + 1, env.clock.now())).toEqual({ ok: false, reason: "ttl_invalid" });
    expect(await egress.issueSignedLink(userCtx(), good, sign, 0, env.clock.now())).toEqual({ ok: false, reason: "ttl_invalid" });
    // 撤权（范围变了）后续签被拒，签发器没有再被调用
    const calls = sign.mock.calls.length;
    const revokedCtx = userCtx({ scope: scopeOf([org.hisense], [org.sh]) });
    expect(await egress.issueSignedLink(revokedCtx, good, sign, 300, env.clock.now())).toMatchObject({ ok: false, reason: "out_of_scope" });
    expect(await egress.issueSignedLink(userCtx({ capabilities: new Set() }), good, sign, 300, env.clock.now())).toMatchObject({ ok: false });
    expect(sign.mock.calls.length).toBe(calls);
  });
});
