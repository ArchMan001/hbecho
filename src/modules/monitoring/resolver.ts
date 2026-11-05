// 有效监控目标集（FS-2、design §7.3）。targets 与 explain 共用同一套条件：
// targets 用一条 SQL 分块取，explain 取同样的事实交给纯函数 firstExclusionReason；两者的一致性由 resolver.db.test 的矩阵测试守护。
import { and, asc, eq, gt, inArray, or } from "drizzle-orm";
import type { Db } from "../../db/client";
import { branches, brands, dealers, externalAccounts, mediaStaff, platforms, regions, sectors, staffAccountAssignments as aa, stores } from "../../db/schema";
import { firstExclusionReason, type ExclusionReason, type MonitoringFacts } from "./reasons";

export interface TargetRow {
  assignmentId: bigint;
  accountId: bigint;
  platformId: bigint;
  platformCode: string;
  watchType: string;
}
export interface TargetChunk {
  rows: TargetRow[];
  /** 下一块的 afterAccountId；null 表示已取完。 */
  next: bigint | null;
}
export interface TargetQuery {
  afterAccountId: bigint | null;
  /** 每块上限（规划按 ≤500 分块，FS-2.7）。 */
  limit: number;
  /** 只在这些账号里取（补抓）。 */
  accountIds?: readonly bigint[] | undefined;
}
export interface Explanation {
  effective: boolean;
  reason: ExclusionReason | null;
}

export function createMonitoringResolver(db: Db) {
  async function targets(q: TargetQuery): Promise<TargetChunk> {
    const rows = await db
      .select({ assignmentId: aa.assignmentId, accountId: aa.accountId, platformId: aa.platformId, platformCode: platforms.platformCode, watchType: aa.watchType })
      .from(aa)
      .innerJoin(externalAccounts, eq(externalAccounts.accountId, aa.accountId))
      .innerJoin(platforms, eq(platforms.platformId, aa.platformId))
      .leftJoin(mediaStaff, eq(mediaStaff.staffId, aa.staffId))
      .leftJoin(stores, eq(stores.storeId, mediaStaff.storeId))
      .leftJoin(brands, eq(brands.brandId, stores.brandId))
      .leftJoin(dealers, eq(dealers.dealerId, stores.dealerId))
      .leftJoin(sectors, eq(sectors.sectorId, stores.sectorId))
      .leftJoin(branches, eq(branches.branchId, sectors.branchId))
      .leftJoin(regions, eq(regions.regionId, branches.regionId))
      .where(
        and(
          inArray(externalAccounts.status, ["active", "unavailable"]),
          eq(aa.monitoringEnabled, true),
          eq(aa.intakeStatus, "normal"),
          or(
            eq(aa.watchType, "external"),
            and(
              eq(mediaStaff.status, "active"),
              eq(mediaStaff.monitoringEnabled, true),
              eq(stores.status, "active"),
              eq(stores.monitoringEnabled, true),
              eq(brands.status, "active"),
              eq(dealers.status, "active"),
              eq(dealers.monitoringEnabled, true),
              eq(branches.status, "active"),
              eq(branches.monitoringEnabled, true),
              eq(regions.status, "active"),
            ),
          ),
          q.afterAccountId === null ? undefined : gt(aa.accountId, q.afterAccountId),
          q.accountIds === undefined ? undefined : inArray(aa.accountId, [...q.accountIds]),
        ),
      )
      .orderBy(asc(aa.accountId))
      .limit(q.limit);
    return { rows, next: rows.length === q.limit ? rows[rows.length - 1]!.accountId : null };
  }

  async function explain(accountId: bigint): Promise<Explanation> {
    const [r] = await db
      .select({
        accountStatus: externalAccounts.status,
        intakeStatus: aa.intakeStatus,
        watchType: aa.watchType,
        assignmentEnabled: aa.monitoringEnabled,
        brandStatus: brands.status,
        regionStatus: regions.status,
        branchStatus: branches.status,
        branchEnabled: branches.monitoringEnabled,
        dealerStatus: dealers.status,
        dealerEnabled: dealers.monitoringEnabled,
        storeStatus: stores.status,
        storeEnabled: stores.monitoringEnabled,
        staffStatus: mediaStaff.status,
        staffEnabled: mediaStaff.monitoringEnabled,
      })
      .from(aa)
      .innerJoin(externalAccounts, eq(externalAccounts.accountId, aa.accountId))
      .leftJoin(mediaStaff, eq(mediaStaff.staffId, aa.staffId))
      .leftJoin(stores, eq(stores.storeId, mediaStaff.storeId))
      .leftJoin(brands, eq(brands.brandId, stores.brandId))
      .leftJoin(dealers, eq(dealers.dealerId, stores.dealerId))
      .leftJoin(sectors, eq(sectors.sectorId, stores.sectorId))
      .leftJoin(branches, eq(branches.branchId, sectors.branchId))
      .leftJoin(regions, eq(regions.regionId, branches.regionId))
      .where(eq(aa.accountId, accountId));
    if (!r) return { effective: false, reason: "no_assignment" };
    const facts: MonitoringFacts = {
      accountStatus: r.accountStatus,
      intakeStatus: r.intakeStatus,
      watchType: r.watchType,
      assignmentEnabled: r.assignmentEnabled,
      brandStatus: r.brandStatus,
      regionStatus: r.regionStatus,
      branch: { status: r.branchStatus, enabled: r.branchEnabled },
      dealer: { status: r.dealerStatus, enabled: r.dealerEnabled },
      store: { status: r.storeStatus, enabled: r.storeEnabled },
      staff: { status: r.staffStatus, enabled: r.staffEnabled },
    };
    const reason = firstExclusionReason(facts);
    return { effective: reason === null, reason };
  }

  return { targets, explain };
}
export type MonitoringResolver = ReturnType<typeof createMonitoringResolver>;
