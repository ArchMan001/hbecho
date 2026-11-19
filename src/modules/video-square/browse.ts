// 广场读口（design §5）：list / options / get。可见品牌只来自 policy.resolveVisible；恒定条件写在 baseWhere 一处。
// 返回类型里没有专员、门店、账号内部 ID、平台账号标识（R7）。
import { and, desc, eq, gt, gte, inArray, isNull, like, lte, sql, type SQL } from "drizzle-orm";
import {
  accountProfileSnapshots,
  branches,
  brands,
  contents,
  contentSnapshots,
  externalAccounts,
  mediaAssets,
  mediaReferences,
  mediaStaff,
  ossObjects,
  platforms,
  sectors,
  staffAccountAssignments,
  stores,
} from "../../db/schema";
import type { AuthContext } from "../access-control";
import type { SquareDeps } from "./deps";
import { SquareError } from "./errors";
import { escapeLike, kindsOf, LIKE_BANDS, LIKE_FLOOR, PAGE_SIZE, watchUrlOf, type SquareFilter } from "./filter";
import { resolveVisible, type VisibleBrands } from "./policy";

export interface SquareCard {
  contentId: string;
  title: string;
  /** 十进制字符串，总是 state=value 的值。 */
  likeCount: string;
  /** 评论值状态不是 value 时为 null，页面显示「—」，不显示 0。 */
  commentCount: string | null;
  brand: { id: string; name: string };
  accountName: string | null;
  platform: { code: string; name: string };
  /** text 并入 image。 */
  kind: "video" | "image";
  /** 签名 URL；缺失或签名失败为 null。 */
  coverUrl: string | null;
  /** 仅 http / https；否则 null。 */
  watchUrl: string | null;
  publishedAt: string | null;
}
export interface SquareDetail extends SquareCard {
  branchName: string;
}
export interface SquarePage {
  items: SquareCard[];
  total: number;
  page: number;
  pageCount: number;
}
export interface SquareOptions {
  brands: Array<{ id: string; name: string }>;
  platforms: Array<{ code: string; name: string }>;
  branches: Array<{ id: string; name: string }>;
}

/** 恒定条件（R3）+ 可见品牌；列表、选项、详情共用，保证「共 N 条」与分页一致。 */
function baseWhere(visible: VisibleBrands): SQL[] {
  const conds: SQL[] = [
    eq(contents.status, "active"),
    eq(contentSnapshots.snapshotStatus, "finalized"),
    inArray(contents.contentKind, ["video", "image", "text"]),
    // 五态约定：like_state='value' 与数值条件同时写，不依赖 NULL 语义（R3.3）
    eq(contentSnapshots.likeState, "value"),
    gt(contentSnapshots.likeValue, LIKE_FLOOR),
  ];
  if (visible !== "all") conds.push(inArray(stores.brandId, [...visible]));
  return conds;
}

function filterWhere(f: SquareFilter, now: Date): SQL[] {
  const conds: SQL[] = [inArray(contents.contentKind, [...kindsOf(f.kind)])];
  if (f.brandId !== undefined) conds.push(eq(stores.brandId, f.brandId));
  if (f.platformCode) conds.push(eq(platforms.platformCode, f.platformCode));
  if (f.branchId !== undefined) conds.push(eq(sectors.branchId, f.branchId));
  if (f.withinDays !== undefined) conds.push(gte(contentSnapshots.publishedAt, new Date(now.getTime() - f.withinDays * 86_400_000)));
  if (f.likeBand) {
    const [lo, hi] = LIKE_BANDS[f.likeBand];
    conds.push(gte(contentSnapshots.likeValue, lo));
    if (hi !== null) conds.push(lte(contentSnapshots.likeValue, hi));
  }
  // ponytail: LIKE '%…%' 只能扫描已被其他条件缩小的集合；可见作品数到数十万、搜索明显变慢时改 FULLTEXT ngram（需要迁移与 ADR，design §9）
  if (f.q) conds.push(like(contentSnapshots.title, `%${escapeLike(f.q)}%`));
  return conds;
}

const columns = {
  contentId: contents.contentId,
  title: contentSnapshots.title,
  likeValue: contentSnapshots.likeValue,
  commentValue: contentSnapshots.commentValue,
  commentState: contentSnapshots.commentState,
  shareUrl: contentSnapshots.shareUrl,
  publishedAt: contentSnapshots.publishedAt,
  snapshotId: contentSnapshots.contentSnapshotId,
  kind: contents.contentKind,
  platformCode: platforms.platformCode,
  platformName: platforms.platformName,
  brandId: brands.brandId,
  brandName: brands.brandName,
  branchName: branches.branchName,
  nickname: accountProfileSnapshots.nickname,
};

/** 内容 → 当前快照 → 账号 → 当前归属（专员、名额未释放）→ 门店 → 品牌 / 分公司。外部账号没有专员归属，自然不在其中（R3.2）。 */
function select(deps: SquareDeps) {
  return deps.db
    .select({ ...columns, total: sql<string>`count(*) over ()` })
    .from(contents)
    .innerJoin(contentSnapshots, and(eq(contentSnapshots.contentId, contents.contentId), eq(contentSnapshots.contentSnapshotId, contents.currentSnapshotId)))
    .innerJoin(externalAccounts, eq(externalAccounts.accountId, contents.accountId))
    .leftJoin(accountProfileSnapshots, eq(accountProfileSnapshots.profileSnapshotId, externalAccounts.currentProfileSnapshotId))
    .innerJoin(staffAccountAssignments, and(eq(staffAccountAssignments.accountId, contents.accountId), eq(staffAccountAssignments.watchType, "staff"), isNull(staffAccountAssignments.slotReleasedAt)))
    .innerJoin(mediaStaff, eq(mediaStaff.staffId, staffAccountAssignments.staffId))
    .innerJoin(stores, eq(stores.storeId, mediaStaff.storeId))
    .innerJoin(brands, eq(brands.brandId, stores.brandId))
    .innerJoin(sectors, eq(sectors.sectorId, stores.sectorId))
    .innerJoin(branches, eq(branches.branchId, sectors.branchId))
    .innerJoin(platforms, eq(platforms.platformId, contents.platformId));
}

type Row = Awaited<ReturnType<ReturnType<typeof select>["limit"]>>[number];

/** 封面：当前快照的 cover_normalized 第 0 张、已归档且已验证；批量查一次，逐个签名，单卡失败只影响该卡。 */
async function coverUrls(deps: SquareDeps, snapshotIds: bigint[]): Promise<Map<bigint, string>> {
  const out = new Map<bigint, string>();
  if (!snapshotIds.length) return out;
  if (!deps.covers) {
    deps.alert?.({ code: "covers_unconfigured" });
    return out;
  }
  const signer = deps.covers;
  const refs = await deps.db
    .select({ snapshotId: mediaReferences.contentSnapshotId, objectKey: ossObjects.objectKey })
    .from(mediaReferences)
    .innerJoin(mediaAssets, eq(mediaAssets.mediaAssetId, mediaReferences.mediaAssetId))
    .innerJoin(ossObjects, eq(ossObjects.ossObjectId, mediaAssets.ossObjectId))
    .where(
      and(
        inArray(mediaReferences.contentSnapshotId, snapshotIds),
        eq(mediaReferences.role, "cover_normalized"),
        eq(mediaReferences.slotIndex, 0),
        inArray(mediaReferences.archiveStatus, ["archived", "carried_forward"]),
        eq(mediaAssets.verificationStatus, "verified"),
        eq(ossObjects.status, "available"),
      ),
    );
  let failed = 0;
  await Promise.all(
    refs.map(async (r) => {
      if (r.snapshotId === null) return;
      try {
        out.set(r.snapshotId, await signer.signedGetUrl(r.objectKey, deps.coverTtlSeconds));
      } catch {
        failed += 1;
      }
    }),
  );
  if (failed) deps.alert?.({ code: "cover_sign_failed", failed });
  return out;
}

const toCard = (r: Row, cover: string | undefined): SquareCard => ({
  contentId: r.contentId.toString(),
  title: r.title ?? "",
  likeCount: String(r.likeValue ?? 0n),
  commentCount: r.commentState === "value" && r.commentValue !== null ? String(r.commentValue) : null,
  brand: { id: r.brandId.toString(), name: r.brandName },
  accountName: r.nickname ?? null,
  platform: { code: r.platformCode, name: r.platformName },
  kind: r.kind === "video" ? "video" : "image",
  coverUrl: cover ?? null,
  watchUrl: watchUrlOf(r.shareUrl),
  publishedAt: r.publishedAt?.toISOString() ?? null,
});

/** 校验 brandId / branchId 落在可见集合内；不在 → invalid_filter（不静默放宽，R2.4、R4.1）。 */
async function assertVisibleChoices(deps: SquareDeps, f: SquareFilter, visible: VisibleBrands): Promise<void> {
  if (f.brandId !== undefined) {
    if (visible !== "all" && !visible.has(f.brandId)) throw new SquareError("input", "invalid_filter", "筛选条件无效：品牌");
    const [b] = await deps.db.select({ id: brands.brandId }).from(brands).where(eq(brands.brandId, f.brandId));
    if (!b) throw new SquareError("input", "invalid_filter", "筛选条件无效：品牌");
  }
  if (f.branchId !== undefined) {
    const [b] = await deps.db.select({ id: branches.branchId }).from(branches).where(eq(branches.branchId, f.branchId));
    if (!b) throw new SquareError("input", "invalid_filter", "筛选条件无效：分公司");
  }
}

async function fetchPage(deps: SquareDeps, where: SQL[], page: number) {
  return select(deps)
    .where(and(...where))
    .orderBy(desc(contentSnapshots.likeValue), desc(contents.contentId))
    .limit(PAGE_SIZE)
    .offset((page - 1) * PAGE_SIZE);
}

export async function list(deps: SquareDeps, ctx: AuthContext, f: SquareFilter): Promise<SquarePage> {
  const visible = await resolveVisible(deps, ctx);
  await assertVisibleChoices(deps, f, visible);
  const where = [...baseWhere(visible), ...filterWhere(f, deps.clock.now())];
  let page = Math.max(1, f.page);
  let rows = await fetchPage(deps, where, page);
  if (rows.length === 0 && page > 1) {
    // 页码越界：夹到最后一页（沿用 pageOf 的做法）。越界时拿不到总数，先取第 1 页得到总数再重取。
    const head = await fetchPage(deps, where, 1);
    const total = head.length ? Number(head[0]!.total) : 0;
    page = Math.min(page, Math.max(1, Math.ceil(total / PAGE_SIZE)));
    rows = page === 1 ? head : await fetchPage(deps, where, page);
  }
  const total = rows.length ? Number(rows[0]!.total) : 0;
  const covers = await coverUrls(deps, rows.map((r) => r.snapshotId));
  return { items: rows.map((r) => toCard(r, covers.get(r.snapshotId))), total, page, pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)) };
}

/** 单个作品（AI分析示意页用）：同一套可见条件；不可见或不存在一律 not_found，不区分原因。 */
export async function get(deps: SquareDeps, ctx: AuthContext, contentId: bigint): Promise<SquareDetail> {
  const visible = await resolveVisible(deps, ctx);
  const rows = await select(deps)
    .where(and(...baseWhere(visible), eq(contents.contentId, contentId)))
    .limit(1);
  const r = rows[0];
  if (!r) throw new SquareError("not_found", "content_not_found", "作品不存在或不在你的可见范围内");
  const covers = await coverUrls(deps, [r.snapshotId]);
  return { ...toCard(r, covers.get(r.snapshotId)), branchName: r.branchName };
}

/** 选项数据驱动：只列可见范围内、恒定条件下真有作品的品牌 / 平台 / 分公司；不随其他筛选联动（SQ-D04）。 */
export async function options(deps: SquareDeps, ctx: AuthContext): Promise<SquareOptions> {
  const visible = await resolveVisible(deps, ctx);
  const rows = await deps.db
    .selectDistinct({ brandId: brands.brandId, brandName: brands.brandName, platformCode: platforms.platformCode, platformName: platforms.platformName, branchId: branches.branchId, branchName: branches.branchName })
    .from(contents)
    .innerJoin(contentSnapshots, and(eq(contentSnapshots.contentId, contents.contentId), eq(contentSnapshots.contentSnapshotId, contents.currentSnapshotId)))
    .innerJoin(staffAccountAssignments, and(eq(staffAccountAssignments.accountId, contents.accountId), eq(staffAccountAssignments.watchType, "staff"), isNull(staffAccountAssignments.slotReleasedAt)))
    .innerJoin(mediaStaff, eq(mediaStaff.staffId, staffAccountAssignments.staffId))
    .innerJoin(stores, eq(stores.storeId, mediaStaff.storeId))
    .innerJoin(brands, eq(brands.brandId, stores.brandId))
    .innerJoin(sectors, eq(sectors.sectorId, stores.sectorId))
    .innerJoin(branches, eq(branches.branchId, sectors.branchId))
    .innerJoin(platforms, eq(platforms.platformId, contents.platformId))
    .where(and(...baseWhere(visible)));
  const uniq = <T extends { id: string }>(xs: T[]): T[] => [...new Map(xs.map((x) => [x.id, x])).values()];
  return {
    brands: uniq(rows.map((r) => ({ id: r.brandId.toString(), name: r.brandName }))).sort((a, b) => Number(BigInt(a.id) - BigInt(b.id))),
    platforms: uniq(rows.map((r) => ({ id: r.platformCode, code: r.platformCode, name: r.platformName }))).map(({ code, name }) => ({ code, name })),
    branches: uniq(rows.map((r) => ({ id: r.branchId.toString(), name: r.branchName }))).sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN")),
  };
}
