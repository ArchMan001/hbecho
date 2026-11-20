// A 侧只读取数（requirements EL-3 / EL-5 / EL-7 / EL-10）：名称、冻结的内容快照、数据截止时点前的主页快照与采集状态、图片签名。
// 不写任何表；一类数据一条查询（一页行里出现的 ID 集合，≤ 500 一块），不逐行查。
import { and, asc, eq, inArray, isNotNull, lte, or, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import {
  accountProfileSnapshots, branches, brands, contents, contentSnapshots, dealers, externalAccountIdentifiers, mediaAssets, mediaReferences, mediaStaff, ossObjects, platforms, regions,
  sectors, staffAccountAssignments, stores, syncBatches, syncTasks,
} from "../../db/schema";
import type { MediaObjectStore } from "../raw-capture/ports";

const CHUNK = 500;
async function inChunks<T, R>(ids: readonly T[], fn: (chunk: T[]) => Promise<R[]>): Promise<R[]> {
  const out: R[] = [];
  const uniq = [...new Set(ids)];
  for (let i = 0; i < uniq.length; i += CHUNK) out.push(...(await fn(uniq.slice(i, i + CHUNK))));
  return out;
}
export interface Value {
  state: string;
  value: bigint | null;
}
export interface OrgIds {
  brandIds: bigint[]; regionIds: bigint[]; branchIds: bigint[]; sectorIds: bigint[]; dealerIds: bigint[]; storeIds: bigint[]; staffIds: bigint[];
}
export interface OrgNames {
  brand: Map<bigint, string>; region: Map<bigint, string>; branch: Map<bigint, string>; sector: Map<bigint, string>; dealer: Map<bigint, string>;
  store: Map<bigint, { name: string; code: string }>; staff: Map<bigint, string>;
}
export interface SnapshotFact {
  contentId: bigint;
  kind: string;
  platformContentId: string;
  title: string | null;
  publishedAt: Date | null;
  shareUrl: string | null;
  like: Value; comment: Value; share: Value; collect: Value;
  snapshotAt: Date;
}
export interface ProfileFact {
  profileSnapshotId: bigint;
  nickname: string | null;
  followers: Value; likes: Value; posts: Value;
}
export type SyncOk = "是" | "部分（有缺口）" | "否" | "无记录";
export interface SyncFact {
  ok: SyncOk;
  at: Date | null;
}
export interface FactsDeps {
  db: Db;
  /** 正式媒资桶签名器；null = 未配置，所有图片用占位 */
  media: Pick<MediaObjectStore, "signedGetUrl"> | null;
  mediaTtlSeconds: number;
  alert?: (e: { code: "image_sign_failed"; failed: number } | { code: "media_unconfigured" }) => void;
}
/**
 * 标题为空时用话题文本顶上：抖音列表接口把「正文」放 title、把「#话题」放 tag_text，只有话题的作品 title 是空串
 * （测试机 9,845 条里 2,109 条标题为空，其中只有 141 条话题也为空；2026-11-20 起 Excel / 页面不再留空）。
 */
const titleOf = (title: string | null, tagText: string | null): string | null => (title ?? "").trim() !== "" ? title : (tagText ?? "").trim() !== "" ? tagText : title;
const TERMINAL = ["succeeded", "succeeded_with_gap", "failed", "dead", "cancelled"];
const OK_BY_STATUS: Record<string, SyncOk> = { succeeded: "是", succeeded_with_gap: "部分（有缺口）", failed: "否", dead: "否", cancelled: "否" };
/** LIKE 的转义：% _ \ 当作普通字符。 */
export const likeEscape = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export function createReportFacts(deps: FactsDeps) {
  const { db } = deps;

  async function platformName(code: string): Promise<string> {
    const [r] = await db.select({ n: platforms.platformName }).from(platforms).where(eq(platforms.platformCode, code));
    return r?.n ?? code;
  }

  async function orgNames(ids: Partial<OrgIds>): Promise<OrgNames> {
    const names: OrgNames = { brand: new Map(), region: new Map(), branch: new Map(), sector: new Map(), dealer: new Map(), store: new Map(), staff: new Map() };
    const [b, r, br, se, d, st, sf] = await Promise.all([
      inChunks(ids.brandIds ?? [], (c) => db.select({ id: brands.brandId, n: brands.brandName }).from(brands).where(inArray(brands.brandId, c))),
      inChunks(ids.regionIds ?? [], (c) => db.select({ id: regions.regionId, n: regions.regionName }).from(regions).where(inArray(regions.regionId, c))),
      inChunks(ids.branchIds ?? [], (c) => db.select({ id: branches.branchId, n: branches.branchName }).from(branches).where(inArray(branches.branchId, c))),
      inChunks(ids.sectorIds ?? [], (c) => db.select({ id: sectors.sectorId, n: sectors.sectorName }).from(sectors).where(inArray(sectors.sectorId, c))),
      inChunks(ids.dealerIds ?? [], (c) => db.select({ id: dealers.dealerId, n: dealers.dealerName }).from(dealers).where(inArray(dealers.dealerId, c))),
      inChunks(ids.storeIds ?? [], (c) => db.select({ id: stores.storeId, n: stores.storeName, code: stores.storeCode }).from(stores).where(inArray(stores.storeId, c))),
      inChunks(ids.staffIds ?? [], (c) => db.select({ id: mediaStaff.staffId, n: mediaStaff.staffName }).from(mediaStaff).where(inArray(mediaStaff.staffId, c))),
    ]);
    b.forEach((x) => names.brand.set(x.id, x.n)); r.forEach((x) => names.region.set(x.id, x.n)); br.forEach((x) => names.branch.set(x.id, x.n));
    se.forEach((x) => names.sector.set(x.id, x.n)); d.forEach((x) => names.dealer.set(x.id, x.n)); st.forEach((x) => names.store.set(x.id, { name: x.n, code: String(x.code) }));
    sf.forEach((x) => names.staff.set(x.id, x.n));
    return names;
  }

  /** 冻结的内容快照（D 的 run_contents.content_snapshot_id）：不读 contents.current_snapshot_id。 */
  async function snapshots(snapshotIds: readonly bigint[]): Promise<Map<bigint, SnapshotFact>> {
    const rows = await inChunks(snapshotIds, (c) =>
      db
        .select({
          id: contentSnapshots.contentSnapshotId, contentId: contentSnapshots.contentId, kind: contents.contentKind, pcid: contents.platformContentId,
          title: contentSnapshots.title, tagText: contentSnapshots.tagText, publishedAt: contentSnapshots.publishedAt, shareUrl: contentSnapshots.shareUrl, snapshotAt: contentSnapshots.snapshotAt,
          likeV: contentSnapshots.likeValue, likeS: contentSnapshots.likeState, comV: contentSnapshots.commentValue, comS: contentSnapshots.commentState,
          shV: contentSnapshots.shareValue, shS: contentSnapshots.shareState, coV: contentSnapshots.collectValue, coS: contentSnapshots.collectState,
        })
        .from(contentSnapshots)
        .innerJoin(contents, eq(contents.contentId, contentSnapshots.contentId))
        .where(inArray(contentSnapshots.contentSnapshotId, c)),
    );
    return new Map(
      rows.map((r) => [
        r.id,
        { contentId: r.contentId, kind: r.kind, platformContentId: String(r.pcid), title: titleOf(r.title, r.tagText), publishedAt: r.publishedAt, shareUrl: r.shareUrl, snapshotAt: r.snapshotAt,
          like: { state: r.likeS, value: r.likeV }, comment: { state: r.comS, value: r.comV }, share: { state: r.shS, value: r.shV }, collect: { state: r.coS, value: r.coV } },
      ]),
    );
  }

  /** 数据截止时点前最新的主页快照：批次在 cutoff 前已终态（finished_at ≤ cutoff），按 (logical_at, batch_id) 取最新；之后到达的批次不影响已有执行的展示。 */
  async function profiles(accountIds: readonly bigint[], cutoff: Date): Promise<Map<bigint, ProfileFact>> {
    const out = new Map<bigint, ProfileFact>();
    await inChunks(accountIds, async (c) => {
      const ranked = db
        .select({
          id: accountProfileSnapshots.profileSnapshotId, accountId: accountProfileSnapshots.accountId, nickname: accountProfileSnapshots.nickname,
          fV: accountProfileSnapshots.followerValue, fS: accountProfileSnapshots.followerState, lV: accountProfileSnapshots.likeValue, lS: accountProfileSnapshots.likeState,
          pV: accountProfileSnapshots.postValue, pS: accountProfileSnapshots.postState,
          rn: sql<number>`ROW_NUMBER() OVER (PARTITION BY ${accountProfileSnapshots.accountId} ORDER BY ${syncBatches.logicalAt} DESC, ${syncBatches.batchId} DESC)`.as("rn"),
        })
        .from(accountProfileSnapshots)
        .innerJoin(syncBatches, eq(syncBatches.batchId, accountProfileSnapshots.batchId))
        .where(and(inArray(accountProfileSnapshots.accountId, c), isNotNull(syncBatches.finishedAt), lte(syncBatches.finishedAt, cutoff)))
        .as("ranked");
      const rows = await db.select().from(ranked).where(eq(ranked.rn, 1));
      for (const r of rows) out.set(r.accountId, { profileSnapshotId: r.id, nickname: r.nickname, followers: { state: r.fS, value: r.fV }, likes: { state: r.lS, value: r.lV }, posts: { state: r.pS, value: r.pV } });
      return [];
    });
    return out;
  }

  /**
   * 主页链接。供应商的主页接口和列表接口都不返回主页 URL，所以：
   *  1) 有规范标识时拼规范地址：抖音 `douyin.sec_uid`（列表条目的作者 sec_uid，成功采集列表后登记）→ https://www.douyin.com/user/<sec_uid>；小红书主页 user_id → https://www.xiaohongshu.com/user/profile/<user_id>；
   *  2) 否则用提交时的入口（resolved_home_url），它常是整段分享文案，由单元格规则取出其中的网址。
   */
  async function homeUrls(accountIds: readonly bigint[]): Promise<Map<bigint, string>> {
    const rows = await inChunks(accountIds, (c) => db.select({ a: staffAccountAssignments.accountId, u: staffAccountAssignments.resolvedHomeUrl }).from(staffAccountAssignments).where(inArray(staffAccountAssignments.accountId, c)));
    const out = new Map(rows.map((r) => [r.a, r.u]));
    const ids = await inChunks(accountIds, (c) =>
      db
        .select({ a: externalAccountIdentifiers.accountId, ns: externalAccountIdentifiers.namespaceCode, v: externalAccountIdentifiers.identifierValue })
        .from(externalAccountIdentifiers)
        .where(and(inArray(externalAccountIdentifiers.accountId, c), inArray(externalAccountIdentifiers.namespaceCode, ["douyin.sec_uid", "xiaohongshu.profile.user_id"]))),
    );
    for (const i of ids) {
      const v = i.v.trim();
      if (!/^[A-Za-z0-9_-]+$/.test(v)) continue; // 不合规的标识值不拼进地址
      out.set(i.a, i.ns === "douyin.sec_uid" ? `https://www.douyin.com/user/${v}` : `https://www.xiaohongshu.com/user/profile/${v}`);
    }
    return out;
  }

  /** 主页 / 视频列表采集状态：数据截止时点前最近一次**终态**的任务；没有记录（含已过一年保留期）= 无记录，不是失败。 */
  async function syncStates(accountIds: readonly bigint[], cutoff: Date): Promise<Map<bigint, { profile: SyncFact; list: SyncFact }>> {
    const none: SyncFact = { ok: "无记录", at: null };
    const out = new Map<bigint, { profile: SyncFact; list: SyncFact }>();
    for (const a of accountIds) out.set(a, { profile: none, list: none });
    await inChunks(accountIds, async (c) => {
      const ranked = db
        .select({
          accountId: syncTasks.accountId, action: syncTasks.requestedAction, status: syncTasks.status, finishedAt: syncTasks.finishedAt,
          rn: sql<number>`ROW_NUMBER() OVER (PARTITION BY ${syncTasks.accountId}, ${syncTasks.requestedAction} ORDER BY ${syncTasks.finishedAt} DESC, ${syncTasks.taskId} DESC)`.as("rn"),
        })
        .from(syncTasks)
        .where(and(inArray(syncTasks.accountId, c), inArray(syncTasks.requestedAction, ["fetch_profile", "resolve_account", "fetch_content_list"]), inArray(syncTasks.status, TERMINAL), isNotNull(syncTasks.finishedAt), lte(syncTasks.finishedAt, cutoff)))
        .as("ranked");
      for (const r of await db.select().from(ranked).where(eq(ranked.rn, 1))) {
        if (r.accountId === null) continue;
        const cur = out.get(r.accountId)!;
        const f: SyncFact = { ok: OK_BY_STATUS[r.status] ?? "否", at: r.finishedAt };
        out.set(r.accountId, r.action === "fetch_content_list" ? { ...cur, list: f } : { ...cur, profile: f });
      }
      return [];
    });
    return out;
  }

  /** 已采集作品数（U2：含图文）：账号下 active 且在数据截止时点前已有 finalized 快照的内容。状态取当前值（A 没有保存内容的历史状态，已知上限）。 */
  async function collectedCounts(accountIds: readonly bigint[], cutoff: Date): Promise<Map<bigint, number>> {
    const rows = await inChunks(accountIds, (c) =>
      db
        .select({ a: contents.accountId, n: sql<number>`COUNT(*)`.mapWith(Number) })
        .from(contents)
        .where(and(inArray(contents.accountId, c), eq(contents.status, "active"), sql`EXISTS (SELECT 1 FROM ${contentSnapshots} s WHERE s.content_id = ${contents.contentId} AND s.snapshot_status = 'finalized' AND s.finalized_at <= ${cutoff})`))
        .groupBy(contents.accountId),
    );
    return new Map(rows.map((r) => [r.a, r.n]));
  }

  /** 专员姓名 / 门店编码的搜索，解析成专员 ID（上限 limit+1 条，调用方判断是否超出）。 */
  async function staffIdsByQuery(q: string, limit: number): Promise<bigint[]> {
    const p = `%${likeEscape(q.trim())}%`;
    const rows = await db
      .select({ id: mediaStaff.staffId })
      .from(mediaStaff)
      .innerJoin(stores, eq(stores.storeId, mediaStaff.storeId))
      .where(or(sql`${mediaStaff.staffName} LIKE ${p} ESCAPE '\\\\'`, sql`${stores.storeCode} LIKE ${p} ESCAPE '\\\\'`))
      .orderBy(asc(mediaStaff.staffId))
      .limit(limit + 1);
    return rows.map((r) => r.id);
  }

  /** 图片：按引用类型取已归档、已验证的对象，逐个签名；单个失败只影响该图（占位）。 */
  async function signedImages(by: "content" | "profile", ids: readonly bigint[], role: string): Promise<Map<bigint, string>> {
    const out = new Map<bigint, string>();
    if (!ids.length) return out;
    if (!deps.media) {
      deps.alert?.({ code: "media_unconfigured" });
      return out;
    }
    const signer = deps.media;
    const col = by === "content" ? mediaReferences.contentSnapshotId : mediaReferences.profileSnapshotId;
    const refs = await inChunks(ids, (c) =>
      db
        .select({ id: col, objectKey: ossObjects.objectKey })
        .from(mediaReferences)
        .innerJoin(mediaAssets, eq(mediaAssets.mediaAssetId, mediaReferences.mediaAssetId))
        .innerJoin(ossObjects, eq(ossObjects.ossObjectId, mediaAssets.ossObjectId))
        .where(and(inArray(col, c), eq(mediaReferences.role, role), eq(mediaReferences.slotIndex, 0), inArray(mediaReferences.archiveStatus, ["archived", "carried_forward"]), eq(mediaAssets.verificationStatus, "verified"), eq(ossObjects.status, "available"))),
    );
    let failed = 0;
    await Promise.all(
      refs.map(async (r) => {
        if (r.id === null) return;
        try {
          out.set(r.id, await signer.signedGetUrl(r.objectKey, deps.mediaTtlSeconds));
        } catch {
          failed += 1;
        }
      }),
    );
    if (failed) deps.alert?.({ code: "image_sign_failed", failed });
    return out;
  }
  const coverUrls = (snapshotIds: readonly bigint[]) => signedImages("content", snapshotIds, "cover_normalized");
  const avatarUrls = (profileIds: readonly bigint[]) => signedImages("profile", profileIds, "avatar_normalized");
  const backgroundUrls = (profileIds: readonly bigint[]) => signedImages("profile", profileIds, "background_normalized");

  return { platformName, orgNames, snapshots, profiles, homeUrls, syncStates, collectedCounts, staffIdsByQuery, coverUrls, avatarUrls, backgroundUrls };
}
export type ReportFacts = ReturnType<typeof createReportFacts>;
