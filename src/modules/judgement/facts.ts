// D 读 A 事实的唯一入口（design §4）：批量只读，不写。其余文件不 import A 的 schema（静态护栏守）。
// 名单经 A 的 PlanReader（函数，不是表）；其余是 D 自己的批量查询。
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import {
  activityPlanBranches,
  activityPlans,
  branches,
  brands,
  contents,
  contentSnapshots,
  externalAccounts,
  mediaStaff,
  platforms,
  sectors,
  staffAccountAssignments,
  stores,
  syncBatches,
  syncCheckpoints,
  syncTasks,
} from "../../db/schema";
import type { PlanReader, RosterSnapshot } from "../activity-plan/reader";
import { syncCompleteness, type SyncResult } from "./engine/pure/sync";

const CHUNK = 1000;
async function inChunks<T, R>(items: readonly T[], fn: (chunk: T[]) => Promise<R[]>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(...(await fn(items.slice(i, i + CHUNK))));
  return out;
}

export interface ActivityPlanFact {
  planId: bigint;
  brandId: bigint;
  platformId: bigint;
  platformCode: string;
  status: string;
  startsOn: string;
  endsOn: string | null;
  createdByActor: string;
}
export interface AssignmentFact {
  accountId: bigint;
  staffId: bigint | null;
  watchType: string;
  platformId: bigint;
  slotReleasedAt: Date | null;
}
export interface OrgChain {
  staffId: bigint;
  storeId: bigint;
  dealerId: bigint;
  brandId: bigint;
  sectorId: bigint;
  branchId: bigint;
  regionId: bigint;
  staffStatus: string;
}
export interface ContentFact {
  contentId: bigint;
  accountId: bigint;
  contentKind: string;
  snapshotId: bigint;
  publishedAt: Date | null;
  durationState: string;
  durationValue: string | null;
  durationUnit: string;
  likeState: string;
  likeValue: bigint | null;
}
export interface ContentsRead {
  rows: ContentFact[];
  /** 不入 T 但可见：状态非 active、没有 finalized 当前快照的内容条数（按账号） */
  excluded: Map<bigint, { status: number; noSnapshot: number }>;
}

export function createFacts(deps: { db: Db; reader: Pick<PlanReader, "rosterSnapshot"> }) {
  const { db } = deps;

  const rosterOf = (activityPlanId: bigint): Promise<RosterSnapshot | null> => deps.reader.rosterSnapshot(activityPlanId);

  async function planOf(activityPlanId: bigint): Promise<ActivityPlanFact | null> {
    const [r] = await db
      .select({
        planId: activityPlans.planId,
        brandId: activityPlans.brandId,
        platformId: activityPlans.platformId,
        platformCode: platforms.platformCode,
        status: activityPlans.status,
        startsOn: activityPlans.startsOn,
        endsOn: activityPlans.endsOn,
        createdByActor: activityPlans.createdByActor,
      })
      .from(activityPlans)
      .innerJoin(platforms, eq(platforms.platformId, activityPlans.platformId))
      .where(eq(activityPlans.planId, activityPlanId));
    return r ?? null;
  }

  /** 一批活动计划的状态与品牌（判定计划列表过滤回收站、构造授权引用用）。 */
  async function activityPlansOf(ids: readonly bigint[]): Promise<Map<bigint, ActivityPlanFact>> {
    const rows = await inChunks(ids, (c) =>
      db
        .select({ planId: activityPlans.planId, brandId: activityPlans.brandId, platformId: activityPlans.platformId, platformCode: platforms.platformCode, status: activityPlans.status, startsOn: activityPlans.startsOn, endsOn: activityPlans.endsOn, createdByActor: activityPlans.createdByActor })
        .from(activityPlans)
        .innerJoin(platforms, eq(platforms.platformId, activityPlans.platformId))
        .where(inArray(activityPlans.planId, c)),
    );
    return new Map(rows.map((r) => [r.planId, r]));
  }

  /** 品牌 ID → 品牌编码（SignalActor 的品牌范围用）；调用方核对条数，找不到的不返回。 */
  async function brandCodesOf(ids: readonly bigint[]): Promise<string[]> {
    const rows = await inChunks(ids, (c) => db.select({ code: brands.brandCode }).from(brands).where(inArray(brands.brandId, c)));
    return rows.map((r) => r.code);
  }

  /** 活动计划已加入（joined）的分公司：判定计划授权范围用。 */
  async function joinedBranchIds(activityPlanId: bigint): Promise<bigint[]> {
    const rows = await db.select({ b: activityPlanBranches.branchId }).from(activityPlanBranches).where(and(eq(activityPlanBranches.planId, activityPlanId), eq(activityPlanBranches.status, "joined")));
    return rows.map((r) => r.b);
  }

  /** 账号当前归属：改绑只改它，不回写名单项。 */
  async function assignmentsOf(accountIds: readonly bigint[]): Promise<Map<bigint, AssignmentFact>> {
    const rows = await inChunks(accountIds, (c) =>
      db
        .select({ accountId: staffAccountAssignments.accountId, staffId: staffAccountAssignments.staffId, watchType: staffAccountAssignments.watchType, platformId: staffAccountAssignments.platformId, slotReleasedAt: staffAccountAssignments.slotReleasedAt })
        .from(staffAccountAssignments)
        .where(inArray(staffAccountAssignments.accountId, c)),
    );
    return new Map(rows.map((r) => [r.accountId, r]));
  }

  /** 专员 → 门店 → 经销商 / 品牌 / 板块 → 分公司 → 大区，取当前值（执行冻结时一次性取，之后不再读）。 */
  async function orgChainOf(staffIds: readonly bigint[]): Promise<Map<bigint, OrgChain>> {
    const rows = await inChunks(staffIds, (c) =>
      db
        .select({
          staffId: mediaStaff.staffId,
          staffStatus: mediaStaff.status,
          storeId: stores.storeId,
          dealerId: stores.dealerId,
          brandId: stores.brandId,
          sectorId: stores.sectorId,
          branchId: sectors.branchId,
          regionId: branches.regionId,
        })
        .from(mediaStaff)
        .innerJoin(stores, eq(stores.storeId, mediaStaff.storeId))
        .innerJoin(sectors, eq(sectors.sectorId, stores.sectorId))
        .innerJoin(branches, eq(branches.branchId, sectors.branchId))
        .where(inArray(mediaStaff.staffId, c)),
    );
    return new Map(rows.map((r) => [r.staffId, r]));
  }

  /**
   * 账号名下 active 且有 finalized 当前快照的内容（带冻结所需的快照字段）；
   * 非 active、无当前快照的内容不落行，只按账号计数。
   */
  async function contentsOf(accountIds: readonly bigint[]): Promise<ContentsRead> {
    const rows = await inChunks(accountIds, (c) =>
      db
        .select({
          contentId: contents.contentId,
          accountId: contents.accountId,
          status: contents.status,
          contentKind: contents.contentKind,
          snapshotId: contentSnapshots.contentSnapshotId,
          snapshotStatus: contentSnapshots.snapshotStatus,
          publishedAt: contentSnapshots.publishedAt,
          durationState: contentSnapshots.durationState,
          durationValue: contentSnapshots.durationValue,
          durationUnit: contentSnapshots.durationUnit,
          likeState: contentSnapshots.likeState,
          likeValue: contentSnapshots.likeValue,
        })
        .from(contents)
        .leftJoin(contentSnapshots, and(eq(contentSnapshots.contentId, contents.contentId), eq(contentSnapshots.contentSnapshotId, contents.currentSnapshotId)))
        .where(inArray(contents.accountId, c))
        .orderBy(asc(contents.contentId)),
    );
    const out: ContentsRead = { rows: [], excluded: new Map() };
    const bump = (a: bigint, k: "status" | "noSnapshot") => {
      const e = out.excluded.get(a) ?? { status: 0, noSnapshot: 0 };
      e[k]++;
      out.excluded.set(a, e);
    };
    for (const r of rows) {
      if (r.status !== "active") bump(r.accountId, "status");
      else if (r.snapshotId === null || r.snapshotStatus !== "finalized") bump(r.accountId, "noSnapshot");
      else out.rows.push({ contentId: r.contentId, accountId: r.accountId, contentKind: r.contentKind, snapshotId: r.snapshotId, publishedAt: r.publishedAt, durationState: r.durationState ?? "missing", durationValue: r.durationValue, durationUnit: r.durationUnit ?? "unknown", likeState: r.likeState ?? "missing", likeValue: r.likeValue });
    }
    return out;
  }

  /** 账号当前 finalized 主页快照（账号要求用；没有为 null）。 */
  async function profileOf(accountIds: readonly bigint[]): Promise<Map<bigint, bigint | null>> {
    const rows = await inChunks(accountIds, (c) => db.select({ a: externalAccounts.accountId, p: externalAccounts.currentProfileSnapshotId }).from(externalAccounts).where(inArray(externalAccounts.accountId, c)));
    return new Map(rows.map((r) => [r.a, r.p]));
  }

  /** 每位账号在窗口内的列表同步是否完整（§7.5）。一批账号一次批量取数，不逐账号往返。 */
  async function syncCompletenessOf(accountIds: readonly bigint[], fromUtc: Date): Promise<Map<bigint, SyncResult>> {
    const TERMINAL = ["succeeded", "succeeded_with_gap", "failed", "dead", "cancelled"];
    const out = new Map<bigint, SyncResult>();
    for (let i = 0; i < accountIds.length; i += CHUNK) {
      const chunk = accountIds.slice(i, i + CHUNK);
      // 每账号最近一条已终态列表任务
      const latestRows = await db.execute(sql`
        SELECT account_id AS accountId, status FROM (
          SELECT t.account_id, t.status, ROW_NUMBER() OVER (PARTITION BY t.account_id ORDER BY COALESCE(t.finished_at, t.created_at) DESC, t.task_id DESC) AS rn
          FROM sync_tasks t WHERE t.requested_action = 'fetch_content_list' AND t.status IN (${sql.join(TERMINAL.map((s) => sql`${s}`), sql`, `)}) AND t.account_id IN (${sql.join(chunk.map((a) => sql`${a}`), sql`, `)})
        ) x WHERE rn = 1`);
      const latest = new Map<bigint, string>();
      for (const r of (latestRows as unknown as [Array<{ accountId: string | bigint; status: string }>])[0]) latest.set(BigInt(r.accountId), r.status);
      const since = await db
        .select({ accountId: syncTasks.accountId, status: syncTasks.status, gap: syncTasks.continuityGapDetected })
        .from(syncTasks)
        .innerJoin(syncBatches, eq(syncBatches.batchId, syncTasks.batchId))
        .where(and(eq(syncTasks.requestedAction, "fetch_content_list"), inArray(syncTasks.status, TERMINAL), inArray(syncTasks.accountId, chunk), sql`${syncBatches.logicalAt} >= ${fromUtc}`));
      const cps = await db
        .select({ accountId: syncCheckpoints.accountId, continuityStatus: syncCheckpoints.continuityStatus, lastGapAt: syncCheckpoints.lastGapAt })
        .from(syncCheckpoints)
        .where(and(eq(syncCheckpoints.action, "fetch_content_list"), eq(syncCheckpoints.checkpointScope, "default"), inArray(syncCheckpoints.accountId, chunk)));
      for (const a of chunk) {
        const l = latest.get(a);
        const cp = cps.find((c) => c.accountId === a);
        out.set(
          a,
          syncCompleteness({
            latest: l === undefined ? null : { status: l },
            sinceWindow: since.filter((s) => s.accountId === a).map((s) => ({ status: s.status, continuityGapDetected: s.gap })),
            checkpoint: cp ? { continuityStatus: cp.continuityStatus, lastGapAt: cp.lastGapAt } : null,
            fromUtc,
          }),
        );
      }
    }
    return out;
  }

  return { rosterOf, planOf, activityPlansOf, brandCodesOf, joinedBranchIds, assignmentsOf, orgChainOf, contentsOf, profileOf, syncCompletenessOf };
}
export type Facts = ReturnType<typeof createFacts>;
