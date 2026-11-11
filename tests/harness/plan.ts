// a-activity-plan 的测试挂具：行工厂、操作者、内存审计。只填 NOT NULL 字段，其余由各测试按需覆盖。
import type { Db } from "../../src/db/client";
import {
  activityPlanBranches,
  activityPlanRoster,
  activityPlanSectors,
  activityPlans,
  mediaStaff,
  stores,
} from "../../src/db/schema";
import type { PlanAuditEvent, PlanAuditEventType } from "../../src/modules/activity-plan/audit";
import { CAP_ACCOUNT_MANAGE, CAP_PLAN_CREATE, CAP_PLAN_JOIN, type PlanActor } from "../../src/modules/activity-plan/authz";
import type { OrgSeed } from "./seed";
import { platformIdOf } from "./seed";

export const T0 = new Date("2026-11-11T02:00:00.000000Z");

/** hq：总部（授权品牌内、分公司 all）；branch：只属于给定分公司；admin：超管；none：没有任何 Capability。 */
export function planActor(kind: "hq" | "branch" | "admin" | "none", over: Partial<PlanActor> & { branches?: bigint[] } = {}): PlanActor {
  const { branches = [], ...rest } = over;
  const base: Record<typeof kind, PlanActor> = {
    hq: { actor: "user:hq", capabilities: new Set([CAP_PLAN_CREATE, CAP_PLAN_JOIN]), brandScope: new Set(["HITACHI"]), branchScope: "all", platformAdmin: false },
    branch: { actor: "user:branch", capabilities: new Set([CAP_PLAN_JOIN, CAP_ACCOUNT_MANAGE]), brandScope: new Set(["HITACHI"]), branchScope: new Set(branches), platformAdmin: false },
    admin: { actor: "user:admin", capabilities: new Set([CAP_PLAN_CREATE, CAP_PLAN_JOIN, CAP_ACCOUNT_MANAGE]), brandScope: "all", branchScope: "all", platformAdmin: true },
    none: { actor: "user:nobody", capabilities: new Set(), brandScope: new Set(), branchScope: new Set(), platformAdmin: false },
  };
  return { ...base[kind], ...rest };
}

export class MemoryPlanAudit {
  readonly events: PlanAuditEvent[] = [];
  readonly sink = (e: PlanAuditEvent): void => void this.events.push(e);
  of(type: PlanAuditEventType): PlanAuditEvent[] {
    return this.events.filter((e) => e.event_type === type);
  }
}

export async function insertStore(
  db: Db,
  org: Pick<OrgSeed, "dealerId" | "sectorId" | "hitachiBrandId">,
  s: { code: string; name?: string; brandId?: bigint; sectorId?: bigint; status?: "active" | "closed"; now?: Date },
): Promise<bigint> {
  const now = s.now ?? T0;
  const [r] = await db.insert(stores).values({
    storeCode: s.code,
    storeName: s.name ?? `门店${s.code}`,
    dealerId: org.dealerId,
    brandId: s.brandId ?? org.hitachiBrandId,
    sectorId: s.sectorId ?? org.sectorId,
    status: s.status ?? "active",
    createdAt: now,
    updatedAt: now,
  });
  return BigInt(r.insertId);
}

export async function insertStaff(db: Db, s: { storeId: bigint; name?: string; phone: string; status?: "active" | "inactive"; now?: Date }): Promise<bigint> {
  const now = s.now ?? T0;
  const [r] = await db.insert(mediaStaff).values({ storeId: s.storeId, staffName: s.name ?? `专员${s.phone.slice(-4)}`, phone: s.phone, status: s.status ?? "active", createdAt: now, updatedAt: now });
  return BigInt(r.insertId);
}

export interface PlanSpec {
  name?: string;
  platform?: string;
  brandId?: bigint;
  status?: "collecting" | "paused" | "archived" | "deleted";
  startsOn?: string;
  endsOn?: string | null;
  sectors?: Array<"water" | "home">;
  createdBy?: string;
  /** 已参加的分公司。 */
  joined?: bigint[];
  /** status='deleted' 时的删除时间；purge_after = deletedAt + 30 天。 */
  deletedAt?: Date;
  statusChangedAt?: Date;
  now?: Date;
}
export async function insertPlan(db: Db, org: Pick<OrgSeed, "hitachiBrandId">, p: PlanSpec = {}): Promise<bigint> {
  const now = p.now ?? T0;
  const status = p.status ?? "collecting";
  const deleted = status === "deleted";
  const deletedAt = p.deletedAt ?? now;
  const [r] = await db.insert(activityPlans).values({
    planName: p.name ?? "测试活动",
    brandId: p.brandId ?? org.hitachiBrandId,
    platformId: await platformIdOf(db, p.platform ?? "douyin"),
    startsOn: p.startsOn ?? "2026-11-01",
    endsOn: p.endsOn === undefined ? null : p.endsOn,
    status,
    statusChangedAt: p.statusChangedAt ?? now,
    ...(deleted ? { statusBeforeDelete: "collecting", deletedAt, deletedByActor: "user:creator", purgeAfter: new Date(deletedAt.getTime() + 30 * 86_400_000) } : {}),
    createdByActor: p.createdBy ?? "user:creator",
    createdAt: now,
    updatedAt: now,
  });
  const planId = BigInt(r.insertId);
  for (const sectorKey of p.sectors ?? ["water", "home"]) await db.insert(activityPlanSectors).values({ planId, sectorKey });
  for (const branchId of p.joined ?? []) {
    await db.insert(activityPlanBranches).values({ planId, branchId, status: "joined", joinedAt: now, joinedByActor: "user:branch", updatedAt: now });
  }
  return planId;
}

export async function insertRosterEntry(
  db: Db,
  e: { planId: bigint; accountId: bigint; staffId: bigint; storeId: bigint; branchId: bigint; platform?: string; state?: "in_roster" | "removed"; now?: Date; removedReason?: "manual_remove" | "branch_exit" },
): Promise<bigint> {
  const now = e.now ?? T0;
  const removed = e.state === "removed";
  const [r] = await db.insert(activityPlanRoster).values({
    planId: e.planId,
    platformId: await platformIdOf(db, e.platform ?? "douyin"),
    accountId: e.accountId,
    branchId: e.branchId,
    storeId: e.storeId,
    staffId: e.staffId,
    entryState: e.state ?? "in_roster",
    addedAt: now,
    addedByActor: "user:branch",
    ...(removed ? { removedAt: now, removedByActor: "user:branch", removedReason: e.removedReason ?? "manual_remove" } : {}),
    updatedAt: now,
  });
  return BigInt(r.insertId);
}
