// 页面入口用的服务装配与读取辅助（b-access-control 页面任务，design §15）。
//   - 装配：认证器、用户管理、批量导入、审计读取，用的就是 CLI 同一批 Module（页面与 CLI 共用同一套授权与审计）；
//   - 读取辅助：把 Module 返回的内部 ID 换成界面要显示的名字（品牌、分公司、门店、操作者），ID 不进界面（ui-foundation §6.6）；
//   - `src/app` 只经这里取数，不自己碰数据库（ADR-0013、B-AX-12）。
import { and, eq, inArray, max } from "drizzle-orm";
import type { Logger } from "pino";
import type { Db } from "../../db/client";
import { accessUsers, auditEvents, branches, brands, importRowResults, stores } from "../../db/schema";
import type { Clock } from "../raw-capture/ports";
import { createAuditWriter, purgeOlderThan, type AuditRow } from "./audit";
import { createAuditReader } from "./audit-read";
import { createAuthenticator } from "./authenticate";
import type { AccessAuth } from "./auth-instance";
import { createAuthorizer, type AuthContext } from "./authorize";
import { createStaffLinkage } from "./linkage";
import { ISSUE_SCOPE_NOT_RESOLVABLE, recordAccessIssue } from "./quality";
import { createOrgDirectory } from "./scope";
import { createUserAdmin, createUserImport, type BatchView, type UserView } from "./users";
import { loadStaffPlacements } from "./users/shared";

export interface OrgRef {
  id: string;
  code: string;
  name: string;
  active: boolean;
}
export interface OrgDirectoryView {
  brands: OrgRef[];
  branches: OrgRef[];
}
/** 用户列表 / 详情的一行：Module 的视图 + 界面要显示的名字。 */
export interface UserRow extends UserView {
  brandNames: string[];
  branchNames: string[];
  /** store_staff 的门店（编码 + 名称）。 */
  storeLabel: string | null;
  /** 最近一次登录成功的审计时间；从未登录或超过审计保留期为 null。 */
  lastLoginAt: string | null;
  createdBy: string;
  disabledReason: string | null;
}
export interface AuditView extends AuditRow {
  actorName: string;
  actorKind: "user" | "service";
  targetName: string | null;
}

const SERVICE_NAMES: Record<string, string> = {
  "service:anonymous": "未登录访客",
  "service:access-worker": "访问控制维护任务",
  "service:sync-worker": "同步任务",
  "service:plan-worker": "活动计划任务",
  "cli:bootstrap": "运维引导",
};

export function createWebServices(d: { db: Db; clock: Clock; auth: AccessAuth; logger?: Logger }) {
  const { db, clock } = d;
  const audit = createAuditWriter({ db, clock, ...(d.logger ? { logger: d.logger } : {}) });
  const dir = createOrgDirectory(db);
  const linkage = createStaffLinkage({ db, clock, audit, dir, purgeAudit: () => purgeOlderThan(db, audit, clock) });
  const authorizer = createAuthorizer();
  const admin = createUserAdmin({ db, clock, audit, dir, authorizer });
  const imp = createUserImport({ db, clock, audit, admin });
  const auditReader = createAuditReader({ db, authorizer });
  const authn = createAuthenticator({
    db,
    dir,
    linkage,
    auth: d.auth,
    onUnresolvable: ({ userId, reason }) =>
      recordAccessIssue(db, { code: ISSUE_SCOPE_NOT_RESOLVABLE, severity: "warning", entityType: "user", entityId: userId, discriminator: reason, detail: { reason }, now: clock.now() }),
  });

  /** 同名的人（超管、总部、分公司人员）可能重名，所以操作者带角色以外的信息交给调用方；这里只给姓名。 */
  async function userNames(ids: readonly bigint[]): Promise<Map<string, string>> {
    const uniq = [...new Set(ids)];
    if (uniq.length === 0) return new Map();
    const rows = await db.select({ id: accessUsers.userId, name: accessUsers.displayName }).from(accessUsers).where(inArray(accessUsers.userId, uniq));
    return new Map(rows.map((r) => [r.id.toString(), r.name]));
  }

  return {
    authenticate: authn.authenticate,
    admin,
    imp,
    auditReader,

    /** 侧栏账号卡：姓名与可检索品牌的名称（超管 / 总部之外按授权品牌）。 */
    async profile(ctx: AuthContext): Promise<{ name: string; brandNames: string[] | "all" }> {
      const [u] = ctx.userId === null ? [] : await db.select({ name: accessUsers.displayName }).from(accessUsers).where(eq(accessUsers.userId, ctx.userId));
      if (ctx.scope.brands === "all") return { name: u?.name ?? "", brandNames: "all" };
      const ids = [...ctx.scope.brands];
      const rows = ids.length ? await db.select({ name: brands.brandName }).from(brands).where(inArray(brands.brandId, ids)).orderBy(brands.brandId) : [];
      return { name: u?.name ?? "", brandNames: rows.map((r) => r.name) };
    },

    async directory(): Promise<OrgDirectoryView> {
      const [b, br] = await Promise.all([
        db.select({ id: brands.brandId, code: brands.brandCode, name: brands.brandName, status: brands.status }).from(brands).orderBy(brands.brandId),
        db.select({ id: branches.branchId, code: branches.branchCode, name: branches.branchName, status: branches.status }).from(branches).orderBy(branches.branchId),
      ]);
      const ref = (r: { id: bigint; code: string; name: string; status: string }): OrgRef => ({ id: r.id.toString(), code: r.code, name: r.name, active: r.status === "active" });
      return { brands: b.map(ref), branches: br.map(ref) };
    },

    /** 补上品牌 / 分公司 / 门店名称、创建者姓名、最近登录与停用原因。 */
    async decorateUsers(views: readonly UserView[], org: OrgDirectoryView): Promise<UserRow[]> {
      if (views.length === 0) return [];
      const ids = views.map((v) => BigInt(v.userId));
      const brandName = new Map(org.brands.map((x) => [x.id, x.name]));
      const branchName = new Map(org.branches.map((x) => [x.id, x.name]));
      const [extra, logins, placements] = await Promise.all([
        db
          .select({ id: accessUsers.userId, createdBy: accessUsers.createdByActor, createdByUserId: accessUsers.createdByUserId, disabledReason: accessUsers.disabledReason })
          .from(accessUsers)
          .where(inArray(accessUsers.userId, ids)),
        db
          .select({ id: auditEvents.actorUserId, at: max(auditEvents.occurredAt) })
          .from(auditEvents)
          .where(and(eq(auditEvents.eventType, "login_succeeded"), eq(auditEvents.outcome, "succeeded"), inArray(auditEvents.actorUserId, ids)))
          .groupBy(auditEvents.actorUserId),
        loadStaffPlacements(db, views.flatMap((v) => (v.mediaStaffId ? [BigInt(v.mediaStaffId)] : []))),
      ]);
      const storeIds = [...new Set([...placements.values()].map((p) => p.storeId))];
      const storeRows = storeIds.length ? await db.select({ id: stores.storeId, name: stores.storeName }).from(stores).where(inArray(stores.storeId, storeIds)) : [];
      const storeName = new Map(storeRows.map((s) => [s.id, s.name]));
      const creators = await userNames(extra.flatMap((e) => (e.createdByUserId ? [e.createdByUserId] : [])));
      const extraBy = new Map(extra.map((e) => [e.id.toString(), e]));
      const loginBy = new Map(logins.flatMap((l) => (l.id && l.at ? [[l.id.toString(), l.at.toISOString()] as const] : [])));
      return views.map((v) => {
        const e = extraBy.get(v.userId);
        const p = v.mediaStaffId ? placements.get(BigInt(v.mediaStaffId)) : undefined;
        return {
          ...v,
          brandNames: v.brandIds.map((x) => brandName.get(x) ?? "（已删除的品牌）"),
          branchNames: v.branchIds.map((x) => branchName.get(x) ?? "（已删除的分公司）"),
          storeLabel: p ? `${p.storeCode} · ${storeName.get(p.storeId) ?? ""}`.trim() : null,
          lastLoginAt: loginBy.get(v.userId) ?? null,
          createdBy: e?.createdByUserId ? (creators.get(e.createdByUserId.toString()) ?? "（已不可见）") : (SERVICE_NAMES[e?.createdBy ?? ""] ?? "系统"),
          disabledReason: e?.disabledReason ?? null,
        };
      });
    },

    /** 导入批次的原始行（提交人本人才读得到：先过 imp.get 的归属检查）。 */
    async importRows(ctx: AuthContext, batchId: bigint): Promise<{ batch: BatchView; raw: Map<number, Record<string, string>> }> {
      const batch = await imp.get(ctx, batchId);
      const rows = await db.select({ rowNo: importRowResults.rowNo, raw: importRowResults.rawRow }).from(importRowResults).where(eq(importRowResults.importBatchId, batchId));
      return { batch, raw: new Map(rows.map((r) => [r.rowNo, r.raw as Record<string, string>])) };
    },

    /** 审计行补上操作者与对象的姓名（服务身份显示为系统任务）。 */
    async decorateAudit(rows: readonly AuditRow[]): Promise<AuditView[]> {
      const ids = rows.flatMap((r) => [r.actorUserId, r.targetType === "user" ? r.targetId : null]).flatMap((x) => (x && /^\d{1,19}$/.test(x) ? [BigInt(x)] : []));
      const names = await userNames(ids);
      return rows.map((r) => ({
        ...r,
        actorName: r.actorUserId ? (names.get(r.actorUserId) ?? "（用户已不可见）") : (SERVICE_NAMES[r.actor] ?? "系统任务"),
        actorKind: r.actorUserId ? "user" : "service",
        targetName: r.targetType === "user" && r.targetId ? (names.get(r.targetId) ?? null) : null,
      }));
    },
  };
}
export type WebServices = ReturnType<typeof createWebServices>;
