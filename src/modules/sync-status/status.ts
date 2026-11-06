// 同步状态查询（FS-15）：只读本地事实，不调用供应商，不依赖任何 transport。
// 脱敏靠构造：输出只从白名单字段拼出（稳定码、计数、ID 字符串、时间、主页入口），不透传 JSON 详情、响应体、对象 key、临时 URL。
// 三态身份校验（verified / unverifiable / mismatch）分开计数，无法判定不并入一致（旧系统教训，FS-15.7）。
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import {
  accountProfileSnapshots,
  contentSnapshots,
  contents,
  dataQualityIssues,
  externalAccountIdentifiers,
  externalAccounts,
  mediaReferences,
  odsProviderCalls,
  platforms,
  staffAccountAssignments as aa,
  syncBatches,
  syncCheckpoints,
  syncTasks,
} from "../../db/schema";
import { YUAN_PER_POINT, pointsOf } from "../cost-guard";
import type { MonitoringResolver } from "../monitoring";
import type { Clock } from "../raw-capture";
import { SyncError } from "../sync-schedule";

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const decimal = (s: string, what: string): bigint => {
  if (!/^[1-9]\d*$/.test(s)) throw new SyncError("invalid_input", `${what} 必须是十进制整数`);
  return BigInt(s);
};
const ID_STATE = "JSON_UNQUOTE(JSON_EXTRACT(result_summary, '$.identity_check.state'))";

export function createSyncStatus(deps: { db: Db; clock: Clock; resolver: Pick<MonitoringResolver, "targets" | "explain"> }) {
  const { db, clock, resolver } = deps;

  async function batchRow(batchId: bigint) {
    const [b] = await db.select().from(syncBatches).where(eq(syncBatches.batchId, batchId));
    if (!b) throw new SyncError("not_found", "批次不存在");
    return b;
  }

  /** 某批次的调用数与点数（只数确实发出的调用；轮询单独计数且不计点；ambiguous 单独给点数上界）。 */
  async function cost(batchId: bigint) {
    const rows = await db
      .select({ action: odsProviderCalls.requestedAction, outcome: odsProviderCalls.outcome, platform: platforms.platformCode, n: sql<number>`COUNT(*)`.mapWith(Number) })
      .from(odsProviderCalls)
      .innerJoin(syncTasks, eq(syncTasks.taskId, odsProviderCalls.syncTaskId))
      .leftJoin(platforms, eq(platforms.platformId, odsProviderCalls.platformId))
      .where(and(eq(syncTasks.batchId, batchId), sql`${odsProviderCalls.callStatus} <> 'prepared'`, sql`${odsProviderCalls.outcome} <> 'not_sent'`))
      .groupBy(odsProviderCalls.requestedAction, odsProviderCalls.outcome, platforms.platformCode);
    let calls = 0;
    let polls = 0;
    let points = 0;
    let ambiguousCalls = 0;
    let ambiguousPoints = 0;
    for (const r of rows) {
      if (r.action === "task_lookup") {
        polls += r.n;
        continue;
      }
      calls += r.n;
      const p = pointsOf(r.platform ?? "", r.action) * r.n;
      if (r.outcome === "succeeded" || r.outcome === "reconciled_succeeded") points += p;
      else if (r.outcome === "ambiguous") (ambiguousCalls += r.n), (ambiguousPoints += p);
    }
    return {
      calls,
      polls,
      // 已计点（成功）与可能已计费但未知（ambiguous）分开：后者的上界由调用数硬上限兜底
      points,
      estimatedYuan: round2(points * YUAN_PER_POINT),
      ambiguous: { calls: ambiguousCalls, pointsUpperBound: ambiguousPoints, yuanUpperBound: round2(ambiguousPoints * YUAN_PER_POINT) },
    };
  }
  const round2 = (n: number) => Math.round(n * 100) / 100;

  /** 某批次的媒资进度。no_audio_track 是事实不是故障，单独计，不并入 failed。 */
  async function media(batchId: bigint) {
    const fromProfile = await db
      .select({ status: mediaReferences.archiveStatus, code: mediaReferences.lastErrorCode, n: sql<number>`COUNT(*)`.mapWith(Number) })
      .from(mediaReferences)
      .innerJoin(accountProfileSnapshots, eq(accountProfileSnapshots.profileSnapshotId, mediaReferences.profileSnapshotId))
      .where(eq(accountProfileSnapshots.batchId, batchId))
      .groupBy(mediaReferences.archiveStatus, mediaReferences.lastErrorCode);
    const fromContent = await db
      .select({ status: mediaReferences.archiveStatus, code: mediaReferences.lastErrorCode, n: sql<number>`COUNT(*)`.mapWith(Number) })
      .from(mediaReferences)
      .innerJoin(contentSnapshots, eq(contentSnapshots.contentSnapshotId, mediaReferences.contentSnapshotId))
      .where(eq(contentSnapshots.batchId, batchId))
      .groupBy(mediaReferences.archiveStatus, mediaReferences.lastErrorCode);
    const out = { total: 0, pending: 0, archived: 0, carriedForward: 0, failed: 0, noAudioTrack: 0 };
    for (const r of [...fromProfile, ...fromContent]) {
      out.total += r.n;
      if (r.status === "pending") out.pending += r.n;
      else if (r.status === "archived") out.archived += r.n;
      else if (r.status === "carried_forward") out.carriedForward += r.n;
      else if (r.code === "no_audio_track") out.noAudioTrack += r.n;
      else out.failed += r.n;
    }
    return out;
  }

  async function batch(rawId: string) {
    const batchId = decimal(rawId, "batch_id");
    const b = await batchRow(batchId);
    const byAction = await db
      .select({ action: syncTasks.requestedAction, status: syncTasks.status, n: sql<number>`COUNT(*)`.mapWith(Number) })
      .from(syncTasks)
      .where(eq(syncTasks.batchId, batchId))
      .groupBy(syncTasks.requestedAction, syncTasks.status);
    const tasks: Record<string, Record<string, number>> = {};
    for (const r of byAction) (tasks[r.action] ??= {})[r.status] = r.n;
    const [gap] = await db.select({ n: sql<number>`COUNT(*)`.mapWith(Number) }).from(syncTasks).where(and(eq(syncTasks.batchId, batchId), eq(syncTasks.continuityGapDetected, true)));
    const reasons = await db
      .select({ code: syncTasks.lastErrorCode, n: sql<number>`COUNT(*)`.mapWith(Number) })
      .from(syncTasks)
      .where(and(eq(syncTasks.batchId, batchId), inArray(syncTasks.status, ["failed", "dead"])))
      .groupBy(syncTasks.lastErrorCode)
      .orderBy(desc(sql`COUNT(*)`));
    // 身份校验三态：列表任务的 result_summary.identity_check.state；主页身份不一致不会写快照，体现为 profile_uid_mismatch 失败
    const listStates = await db
      .select({ state: sql<string | null>`${sql.raw(ID_STATE)}`, n: sql<number>`COUNT(*)`.mapWith(Number) })
      .from(syncTasks)
      .where(and(eq(syncTasks.batchId, batchId), eq(syncTasks.requestedAction, "fetch_content_list"), inArray(syncTasks.status, ["succeeded", "succeeded_with_gap", "failed", "dead"])))
      .groupBy(sql.raw(ID_STATE));
    const identity = { list: { verified: 0, unverifiable: 0, mismatch: 0, unknown: 0 }, profile: { verified: 0, mismatch: 0 } };
    for (const r of listStates) {
      if (r.state === "verified" || r.state === "unverifiable" || r.state === "mismatch") identity.list[r.state] += r.n;
      else identity.list.unknown += r.n; // pending / 缺失（任务没走到判定）：不并入任何一类
    }
    const profStates = await db
      .select({ state: sql<string | null>`${sql.raw(ID_STATE)}`, code: syncTasks.lastErrorCode, n: sql<number>`COUNT(*)`.mapWith(Number) })
      .from(syncTasks)
      .where(and(eq(syncTasks.batchId, batchId), eq(syncTasks.requestedAction, "fetch_profile")))
      .groupBy(sql.raw(ID_STATE), syncTasks.lastErrorCode);
    for (const r of profStates) {
      if (r.state === "verified") identity.profile.verified += r.n;
      if (r.code === "profile_uid_mismatch") identity.profile.mismatch += r.n;
    }
    return {
      batchId: batchId.toString(),
      purpose: b.purpose,
      triggerType: b.triggerType,
      status: b.status,
      skipReason: b.skipReason,
      logicalAt: b.logicalAt.toISOString(),
      startedAt: iso(b.startedAt),
      finishedAt: iso(b.finishedAt),
      mediaFinishedAt: iso(b.mediaFinishedAt),
      tasks,
      gapTasks: gap?.n ?? 0,
      failureReasons: reasons.map((r) => ({ code: r.code ?? "unknown", count: r.n })),
      identityCheck: identity,
      media: await media(batchId),
      cost: await cost(batchId),
    };
  }

  /** 总览：最近的批次摘要 + 最新全量批次的完整报告。 */
  async function status(opts: { limit?: number } = {}) {
    const rows = await db.select().from(syncBatches).orderBy(desc(syncBatches.logicalAt), desc(syncBatches.batchId)).limit(Math.min(Math.max(opts.limit ?? 5, 1), 50));
    const [latestFull] = await db.select({ id: syncBatches.batchId }).from(syncBatches).where(eq(syncBatches.purpose, "full")).orderBy(desc(syncBatches.logicalAt), desc(syncBatches.batchId)).limit(1);
    return {
      recent: rows.map((b) => ({ batchId: b.batchId.toString(), purpose: b.purpose, status: b.status, logicalAt: b.logicalAt.toISOString(), planned: b.plannedTaskCount, succeeded: b.succeededTaskCount, failed: b.failedTaskCount, mediaFinishedAt: iso(b.mediaFinishedAt) })),
      latestFull: latestFull ? await batch(latestFull.id.toString()) : null,
    };
  }

  async function account(rawId: string, opts: { batches?: number } = {}) {
    const accountId = decimal(rawId, "account_id");
    const [a] = await db
      .select({ watchType: aa.watchType, staffId: aa.staffId, enabled: aa.monitoringEnabled, closedReason: aa.monitoringClosedReason, intake: aa.intakeStatus, locator: aa.currentHomeLocator, slotReleasedAt: aa.slotReleasedAt, platform: platforms.platformCode, status: externalAccounts.status })
      .from(aa)
      .innerJoin(externalAccounts, eq(externalAccounts.accountId, aa.accountId))
      .innerJoin(platforms, eq(platforms.platformId, aa.platformId))
      .where(eq(aa.accountId, accountId));
    if (!a) throw new SyncError("not_found", "账号不存在或没有归属");
    const ex = await resolver.explain(accountId);
    const recent = await db
      .select({ batchId: syncTasks.batchId, action: syncTasks.requestedAction, status: syncTasks.status, code: syncTasks.lastErrorCode, attempts: syncTasks.attemptCount, finishedAt: syncTasks.finishedAt, stopReason: syncTasks.stopReason, gap: syncTasks.continuityGapDetected, state: sql<string | null>`${sql.raw(ID_STATE)}` })
      .from(syncTasks)
      .where(and(eq(syncTasks.accountId, accountId), inArray(syncTasks.requestedAction, ["fetch_profile", "fetch_content_list"])))
      .orderBy(desc(syncTasks.batchId), syncTasks.requestedAction)
      .limit((opts.batches ?? 5) * 2);
    const [cp] = await db.select().from(syncCheckpoints).where(and(eq(syncCheckpoints.accountId, accountId), eq(syncCheckpoints.action, "fetch_content_list")));
    const kind = (cp?.cursorEnvelope as { kind?: unknown } | null | undefined)?.kind;
    const issues = await db
      .select({ issueId: dataQualityIssues.issueId, code: dataQualityIssues.issueCode, severity: dataQualityIssues.severity, status: dataQualityIssues.status, lastSeenAt: dataQualityIssues.lastSeenAt })
      .from(dataQualityIssues)
      .where(and(eq(dataQualityIssues.accountId, accountId), inArray(dataQualityIssues.status, ["open", "acknowledged"])))
      .orderBy(desc(dataQualityIssues.lastSeenAt))
      .limit(20);
    return {
      accountId: accountId.toString(),
      platform: a.platform,
      watchType: a.watchType,
      staffId: a.staffId?.toString() ?? null,
      accountStatus: a.status,
      entry: a.locator,
      monitoring: { enabled: a.enabled, closedReason: a.closedReason, intakeStatus: a.intake, slotReleasedAt: iso(a.slotReleasedAt), effective: ex.effective, excludedBecause: ex.reason },
      recentTasks: recent.map((r) => ({ batchId: r.batchId.toString(), action: r.action, status: r.status, errorCode: r.code, attempts: r.attempts, finishedAt: iso(r.finishedAt), stopReason: r.stopReason, gap: r.gap, identityCheck: r.state })),
      checkpoint: cp
        ? { anchorMode: cp.anchorMode, cursorType: kind === "string" || kind === "integer" || kind === "null" ? kind : null, continuityStatus: cp.continuityStatus, lastGapAt: iso(cp.lastGapAt), lastSuccessfulBatchId: cp.lastSuccessfulBatchId?.toString() ?? null }
        : null,
      openIssues: issues.map((i) => ({ issueId: i.issueId.toString(), code: i.code, severity: i.severity, status: i.status, lastSeenAt: i.lastSeenAt.toISOString() })),
    };
  }

  /** 超过 olderThanHours 没有成功同步的有效监控账号（主页或——自有型——列表任一过期即算；从未成功视为无限久）。 */
  async function freshness(opts: { olderThanHours: number; limit?: number }) {
    if (!(opts.olderThanHours > 0)) throw new SyncError("invalid_input", "olderThanHours 必须为正数");
    const cutoff = clock.now().getTime() - opts.olderThanHours * 3600_000;
    const profile = new Map((await db.select({ id: accountProfileSnapshots.accountId, at: sql<Date>`MAX(${accountProfileSnapshots.responseReceivedAt})` }).from(accountProfileSnapshots).groupBy(accountProfileSnapshots.accountId)).map((r) => [r.id, r.at ? new Date(r.at) : null]));
    const list = new Map(
      (await db.select({ id: syncTasks.accountId, at: sql<Date>`MAX(${syncTasks.finishedAt})` }).from(syncTasks).where(and(eq(syncTasks.requestedAction, "fetch_content_list"), inArray(syncTasks.status, ["succeeded", "succeeded_with_gap"]), isNotNull(syncTasks.accountId))).groupBy(syncTasks.accountId)).map((r) => [r.id!, r.at ? new Date(r.at) : null]),
    );
    const stale: Array<{ accountId: string; watchType: string; lastProfileAt: string | null; lastListAt: string | null }> = [];
    let total = 0;
    for (let after: bigint | null = null; ; ) {
      const chunk = await resolver.targets({ afterAccountId: after, limit: 500 });
      for (const t of chunk.rows) {
        total++;
        const p = profile.get(t.accountId) ?? null;
        const l = list.get(t.accountId) ?? null;
        const old = (d: Date | null) => d === null || d.getTime() < cutoff;
        if (old(p) || (t.watchType === "staff" && old(l))) stale.push({ accountId: t.accountId.toString(), watchType: t.watchType, lastProfileAt: iso(p), lastListAt: iso(l) });
      }
      if (chunk.next === null) break;
      after = chunk.next;
    }
    return { olderThanHours: opts.olderThanHours, monitoredAccounts: total, staleAccounts: stale.length, stale: stale.slice(0, opts.limit ?? 50) };
  }

  /** 随机抽 N 个本批次成功的自有账号，供人工打开主页对账。只读。 */
  async function sample(opts: { n: number; batchId?: string }) {
    if (!Number.isInteger(opts.n) || opts.n < 1 || opts.n > 200) throw new SyncError("invalid_input", "n 必须是 1..200 的整数");
    let batchId: bigint;
    if (opts.batchId !== undefined) batchId = decimal(opts.batchId, "batch_id");
    else {
      const [latest] = await db.select({ id: syncBatches.batchId }).from(syncBatches).where(eq(syncBatches.purpose, "full")).orderBy(desc(syncBatches.logicalAt)).limit(1);
      if (!latest) throw new SyncError("not_found", "还没有全量批次");
      batchId = latest.id;
    }
    await batchRow(batchId);
    const picked = await db
      .select({ accountId: syncTasks.accountId })
      .from(syncTasks)
      .where(and(eq(syncTasks.batchId, batchId), eq(syncTasks.requestedAction, "fetch_content_list"), inArray(syncTasks.status, ["succeeded", "succeeded_with_gap"]), isNotNull(syncTasks.accountId)))
      .orderBy(sql`RAND()`)
      .limit(opts.n);
    const out = [];
    for (const { accountId } of picked) {
      const id = accountId!;
      const [asg] = await db.select({ locator: aa.currentHomeLocator, platform: platforms.platformCode }).from(aa).innerJoin(platforms, eq(platforms.platformId, aa.platformId)).where(eq(aa.accountId, id));
      const ids = await db.select({ ns: externalAccountIdentifiers.namespaceCode, value: externalAccountIdentifiers.identifierValue }).from(externalAccountIdentifiers).where(eq(externalAccountIdentifiers.accountId, id)).orderBy(externalAccountIdentifiers.accountIdentifierId);
      const [snap] = await db.select().from(accountProfileSnapshots).where(and(eq(accountProfileSnapshots.accountId, id), eq(accountProfileSnapshots.batchId, batchId)));
      const [cs] = await db
        .select({ n: sql<number>`COUNT(*)`.mapWith(Number), newest: sql<Date | null>`MAX(${contentSnapshots.publishedAt})` })
        .from(contentSnapshots)
        .innerJoin(contents, eq(contents.contentId, contentSnapshots.contentId))
        .where(and(eq(contentSnapshots.batchId, batchId), eq(contents.accountId, id)));
      out.push({
        accountId: id.toString(),
        platform: asg?.platform ?? null,
        entry: asg?.locator ?? null,
        identifiers: ids.map((i) => ({ namespace: i.ns, value: i.value })),
        profile: snap
          ? { nickname: snap.nickname, followers: { state: snap.followerState, value: snap.followerValue?.toString() ?? null }, posts: { state: snap.postState, value: snap.postValue?.toString() ?? null }, receivedAt: snap.responseReceivedAt.toISOString() }
          : null,
        list: { contentSnapshots: cs?.n ?? 0, newestPublishedAt: cs?.newest ? new Date(cs.newest).toISOString() : null },
      });
    }
    return { batchId: batchId.toString(), requested: opts.n, returned: out.length, accounts: out };
  }

  return { status, batch, account, freshness, sample };
}
export type SyncStatus = ReturnType<typeof createSyncStatus>;
