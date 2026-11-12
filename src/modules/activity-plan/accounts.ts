// 「账号与监控」页面的只读查询（design §15.1）：跨计划的账号列表与账号详情，带综合状态与五级开关链。
// 范围 = 账号所属专员所在门店的品牌 ∩ 分公司（与确认疑似空账号的范围谓词一致）；外部监控账号没有分公司，不在这里。
// 越范围 / 不存在 → 稳定的「未找到」。查询不写任何表。
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import {
  activityPlanRoster,
  activityPlans,
  accountProfileSnapshots,
  branches,
  brands,
  dealers,
  externalAccounts,
  mediaStaff,
  platforms,
  regions,
  sectors,
  staffAccountAssignments as aa,
  stores,
} from "../../db/schema";
import { firstExclusionReason, type MonitoringFacts } from "../monitoring";
import { assert, brandInScope, branchInScope, CAP_ACCOUNT_MANAGE, type PlanActor } from "./authz";
import { PlanError } from "./errors";
import { composeStatus, type CompositeCode, type CompositeStatus } from "./status";

export type SwitchLevelKey = "branch" | "dealer" | "store" | "staff" | "account";
export interface SwitchNode {
  level: SwitchLevelKey;
  /** 十进制 ID（节点本身；经销商是全局表）。 */
  id: string;
  name: string;
  enabled: boolean;
  /** 业务状态无效（已停用 / 已撤店）：开关值再打开也不会生效。 */
  active: boolean;
}
export interface AccountItem {
  accountId: string;
  platform: string;
  nickname: string | null;
  /** 粉丝 / 作品数：只有「有效值」才给数字；缺失 / 显式 null / 非法都是 null（页面显示 —），不把它们当 0。 */
  followers: number | null;
  posts: number | null;
  lastSyncAt: string | null;
  staff: { id: string; name: string; phone: string };
  store: { code: string; name: string };
  branch: { id: string; name: string };
  brand: string;
  intake: string;
  enabled: boolean;
  status: CompositeStatus;
}
export interface AccountDetail extends AccountItem {
  homeLocator: string;
  /** 五级开关链，自上而下：分公司 → 经销商 → 门店 → 专员 → 账号。 */
  chain: SwitchNode[];
  closedReason: string | null;
  /** 账号当前在哪些计划的名单里（仅操作者可见的、采集中的计划；用于「移出名单」）。 */
  plans: Array<{ planId: string; name: string; status: string }>;
}

const STATUS_CODES: readonly CompositeCode[] = ["normal", "suspected_empty", "upstream_closed", "monitoring_stopped", "removed_from_plan", "invalid_link"];
const MAX_ACCOUNTS = 50_000;

export function createAccountQuery(deps: { db: Db }) {
  const { db } = deps;
  const base = () =>
    db
      .select({
        accountId: aa.accountId,
        platform: platforms.platformCode,
        accountStatus: externalAccounts.status,
        intake: aa.intakeStatus,
        enabled: aa.monitoringEnabled,
        closedReason: aa.monitoringClosedReason,
        locator: aa.currentHomeLocator,
        staffId: mediaStaff.staffId,
        staffName: mediaStaff.staffName,
        phone: mediaStaff.phone,
        staffStatus: mediaStaff.status,
        staffEnabled: mediaStaff.monitoringEnabled,
        storeId: stores.storeId,
        storeCode: stores.storeCode,
        storeName: stores.storeName,
        storeStatus: stores.status,
        storeEnabled: stores.monitoringEnabled,
        dealerId: dealers.dealerId,
        dealerName: dealers.dealerName,
        dealerStatus: dealers.status,
        dealerEnabled: dealers.monitoringEnabled,
        branchId: branches.branchId,
        branchName: branches.branchName,
        branchStatus: branches.status,
        branchEnabled: branches.monitoringEnabled,
        regionStatus: regions.status,
        brandCode: brands.brandCode,
        brandStatus: brands.status,
        nickname: accountProfileSnapshots.nickname,
        followerValue: accountProfileSnapshots.followerValue,
        followerState: accountProfileSnapshots.followerState,
        postValue: accountProfileSnapshots.postValue,
        postState: accountProfileSnapshots.postState,
        lastSyncAt: externalAccounts.currentProfileSelectedAt,
      })
      .from(aa)
      .innerJoin(externalAccounts, eq(externalAccounts.accountId, aa.accountId))
      .innerJoin(platforms, eq(platforms.platformId, aa.platformId))
      .innerJoin(mediaStaff, eq(mediaStaff.staffId, aa.staffId))
      .innerJoin(stores, eq(stores.storeId, mediaStaff.storeId))
      .innerJoin(brands, eq(brands.brandId, stores.brandId))
      .innerJoin(dealers, eq(dealers.dealerId, stores.dealerId))
      .innerJoin(sectors, eq(sectors.sectorId, stores.sectorId))
      .innerJoin(branches, eq(branches.branchId, sectors.branchId))
      .innerJoin(regions, eq(regions.regionId, branches.regionId))
      .leftJoin(accountProfileSnapshots, eq(accountProfileSnapshots.profileSnapshotId, externalAccounts.currentProfileSnapshotId));
  type Row = Awaited<ReturnType<typeof base>>[number];

  /** 范围条件：品牌编码集合 ∩ 分公司 ID 集合；空集合表示什么都看不到。 */
  function scopeConds(actor: PlanActor) {
    const conds = [eq(aa.watchType, "staff"), sql`${aa.slotReleasedAt} IS NULL`];
    if (actor.brandScope !== "all") conds.push(actor.brandScope.size === 0 ? sql`1=0` : inArray(brands.brandCode, [...actor.brandScope]));
    if (actor.branchScope !== "all") conds.push(actor.branchScope.size === 0 ? sql`1=0` : inArray(branches.branchId, [...actor.branchScope]));
    return conds;
  }

  const num = (v: bigint | number | null, state: string | null): number | null => (state === "valid" && v !== null ? Number(v) : null);
  const factsOf = (r: Row): MonitoringFacts => ({
    accountStatus: r.accountStatus,
    intakeStatus: r.intake,
    watchType: "staff",
    assignmentEnabled: r.enabled,
    brandStatus: r.brandStatus,
    regionStatus: r.regionStatus,
    branch: { status: r.branchStatus, enabled: r.branchEnabled },
    dealer: { status: r.dealerStatus, enabled: r.dealerEnabled },
    store: { status: r.storeStatus, enabled: r.storeEnabled },
    staff: { status: r.staffStatus, enabled: r.staffEnabled },
  });
  /** 名单维度：有「在名单」项 → in_roster；有项但都已移出 → removed；从没进过名单 → null（不触发「已移出活动计划」）。 */
  async function entryStates(accountIds: readonly bigint[]): Promise<Map<string, "in_roster" | "removed">> {
    if (accountIds.length === 0) return new Map();
    const rows = await db
      .select({ accountId: activityPlanRoster.accountId, inRoster: sql<number>`MAX(${activityPlanRoster.entryState} = 'in_roster')`.mapWith(Number) })
      .from(activityPlanRoster)
      .where(inArray(activityPlanRoster.accountId, [...accountIds]))
      .groupBy(activityPlanRoster.accountId);
    return new Map(rows.map((r) => [r.accountId.toString(), r.inRoster ? ("in_roster" as const) : ("removed" as const)]));
  }
  const item = (r: Row, entry: "in_roster" | "removed" | undefined): AccountItem => ({
    accountId: r.accountId.toString(),
    platform: r.platform,
    nickname: r.nickname,
    followers: num(r.followerValue, r.followerState),
    posts: num(r.postValue, r.postState),
    lastSyncAt: r.lastSyncAt?.toISOString() ?? null,
    staff: { id: r.staffId.toString(), name: r.staffName, phone: r.phone },
    store: { code: r.storeCode, name: r.storeName },
    branch: { id: r.branchId.toString(), name: r.branchName },
    brand: r.brandCode,
    intake: r.intake,
    enabled: r.enabled,
    status: composeStatus({ intakeStatus: r.intake, exclusion: firstExclusionReason(factsOf(r)), assignmentEnabled: r.enabled, closedReason: r.closedReason, entryState: entry ?? null }),
  });

  /**
   * 账号列表：范围内的自有型账号，按综合状态 / 平台筛选，按账号倒序分页。
   * 综合状态由多级事实推出，所以筛选在内存里做：取范围内全部账号的事实（一次查询）再过滤，计数与分页用同一个集合。
   * ponytail: 上限 50,000 个账号（当前全库约一万量级）；超过时报错而不是静默截断，升级路径是把排除原因下推成 SQL 条件。
   */
  async function list(actor: PlanActor, f: { status?: string; platform?: string; offset?: number; limit?: number } = {}) {
    assert(actor, CAP_ACCOUNT_MANAGE);
    if (f.status && f.status !== "all" && !(STATUS_CODES as readonly string[]).includes(f.status)) throw new PlanError("input", "status_invalid", "不认识的综合状态");
    const rows = await base()
      .where(and(...scopeConds(actor), ...(f.platform && f.platform !== "all" ? [eq(platforms.platformCode, f.platform)] : [])))
      .orderBy(desc(aa.accountId))
      .limit(MAX_ACCOUNTS + 1);
    if (rows.length > MAX_ACCOUNTS) throw new PlanError("limit", "too_many_accounts", `范围内账号超过 ${MAX_ACCOUNTS} 个，请先按平台筛选`);
    const entries = await entryStates(rows.map((r) => r.accountId));
    const all = rows.map((r) => item(r, entries.get(r.accountId.toString())));
    const filtered = f.status && f.status !== "all" ? all.filter((a) => a.status.code === f.status) : all;
    const counts: Record<string, number> = {};
    for (const a of all) counts[a.status.code] = (counts[a.status.code] ?? 0) + 1;
    const offset = Math.max(0, f.offset ?? 0);
    const limit = Math.min(200, Math.max(1, f.limit ?? 20));
    return { total: filtered.length, scopeTotal: all.length, counts, offset, limit, items: filtered.slice(offset, offset + limit) };
  }

  /** 账号详情：含五级开关链与所在计划。越范围 / 不存在 / 外部监控账号 → 未找到。 */
  async function detail(actor: PlanActor, accountId: bigint): Promise<AccountDetail> {
    assert(actor, CAP_ACCOUNT_MANAGE);
    const [r] = await base().where(and(eq(aa.accountId, accountId), eq(aa.watchType, "staff")));
    if (!r || !brandInScope(actor, r.brandCode) || !branchInScope(actor, r.branchId)) throw new PlanError("not_found", "not_found", "未找到");
    const entries = await entryStates([accountId]);
    const plans = await db
      .select({ planId: activityPlans.planId, name: activityPlans.planName, status: activityPlans.status })
      .from(activityPlanRoster)
      .innerJoin(activityPlans, eq(activityPlans.planId, activityPlanRoster.planId))
      .where(and(eq(activityPlanRoster.accountId, accountId), eq(activityPlanRoster.entryState, "in_roster"), eq(activityPlans.status, "collecting")))
      .orderBy(asc(activityPlans.planId));
    const on = (s: string) => s === "active";
    const chain: SwitchNode[] = [
      { level: "branch", id: r.branchId.toString(), name: r.branchName, enabled: r.branchEnabled, active: on(r.branchStatus) },
      { level: "dealer", id: r.dealerId.toString(), name: r.dealerName, enabled: r.dealerEnabled, active: on(r.dealerStatus) },
      { level: "store", id: r.storeId.toString(), name: r.storeName, enabled: r.storeEnabled, active: on(r.storeStatus) },
      { level: "staff", id: r.staffId.toString(), name: r.staffName, enabled: r.staffEnabled, active: on(r.staffStatus) },
      { level: "account", id: r.accountId.toString(), name: r.nickname ?? `账号 ${r.accountId}`, enabled: r.enabled, active: r.accountStatus !== "deleted" },
    ];
    return { ...item(r, entries.get(accountId.toString())), homeLocator: r.locator, chain, closedReason: r.closedReason, plans: plans.map((p) => ({ planId: p.planId.toString(), name: p.name, status: p.status })) };
  }

  return { list, detail };
}
export type AccountQuery = ReturnType<typeof createAccountQuery>;
