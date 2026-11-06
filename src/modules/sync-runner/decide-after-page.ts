// 列表翻页判定（design §7.6 的 9 行判定表，顺序按 design-task5-account-sync.md §5.2 的 A→G 重排）。
// 纯函数：只回答「这一整页处理完之后，继续还是停、怎么停」，不碰数据库。
// 调用方（ListWalker）先把已返回的整页投影完，再来问；本地 limit 只决定是否请求下一页，绝不截断已返回页（C8）。
import type { RequestCursor, TypedCursor } from "../provider-adapter";
import type { ValueState } from "../provider-adapter";

/** 规划时冻结的旧检查点（任务参数 anchor_snapshot），边界判断只看它。 */
export type AnchorView =
  | { mode: "none" } // 没有旧检查点：首次基线
  | { mode: "empty" }
  | { mode: "time"; highWatermarkMs: bigint; contentIds: ReadonlySet<string> }
  | { mode: "id_window"; contentIds: ReadonlySet<string> };

export interface PageEntryFacts {
  /** 页内 0 基位置。 */
  position: number;
  contentId: string | null;
  /** 已用 validPublishedAtMs 归一：无有效发布时间为 null。 */
  publishedAtMs: bigint | null;
}
export interface PageFacts {
  /** 1 基页号。 */
  pageNo: number;
  entries: readonly PageEntryFacts[];
  hasMore: ValueState<boolean>;
  cursor: TypedCursor;
}
export interface WalkTotals {
  /** 本任务到目前为止**返回的条目总数**（含本页，不是去重后的内容数）。 */
  cumulativeEntries: number;
  /** 第 1 页置顶位置（位置 0–2）里是否有内容 ID 命中旧 ID 集合（进度里保存，第 1 页之后沿用）。 */
  pinnedIdMatch: boolean;
}
export interface DecideConfig {
  safetyPageLimit: number;
  initialContentLimit: number;
  /** 检查点处于 blocked：只抓首页，有效页数上限取 1（design-task5 §13.3）。 */
  blocked: boolean;
}

export type Anomaly = { code: "cursor_no_more_with_has_more"; cursorKind: string } | { code: "has_more_invalid"; state: string };
export type Decision =
  | { action: "continue"; nextCursor: RequestCursor; anomalies: [] }
  | {
      action: "stop";
      outcome: "success" | "gap" | "blocked";
      stopReason: StopReason;
      /** rebuild：用本轮已获取的全部内容重建锚点；keep_old：不动（blocked）；empty：建立 / 保持空锚点。 */
      anchor: "rebuild" | "keep_old" | "empty";
      windowOverflow: boolean;
      anomalies: Anomaly[];
    };

export type StopReason =
  | "boundary_hit"
  | "initial_limit"
  | "baseline"
  | "empty_list"
  | "end_of_list"
  | "safety_limit_rebased"
  | "end_of_list_rebased"
  | "cursor_anomaly_rebased"
  | "empty_window_not_rebased";

/** 第 1 页置顶位置（0–2）：可能是很早以前发布的置顶内容，不作为「已追到旧边界」的证据（FS-5.2）。 */
export const PINNED_POSITIONS = 3;

const usableCursor = (c: TypedCursor): c is RequestCursor => c.kind === "integer" || (c.kind === "string" && c.value !== "");

function hits(anchor: AnchorView, e: PageEntryFacts): boolean {
  if (anchor.mode !== "time" && anchor.mode !== "id_window") return false;
  if (e.contentId !== null && anchor.contentIds.has(e.contentId)) return true;
  // time 模式：严格早于旧高水位；等于高水位时间但 ID 不在集合内不命中（继续翻页）
  return anchor.mode === "time" && e.publishedAtMs !== null && e.publishedAtMs < anchor.highWatermarkMs;
}

/** 第 1 页置顶位置里的内容 ID 是否命中旧集合（只看 ID，不看时间：时间早于高水位不是置顶位置的证据）。 */
export function pinnedIdMatchOf(anchor: AnchorView, page: PageFacts): boolean {
  if (page.pageNo !== 1 || (anchor.mode !== "time" && anchor.mode !== "id_window")) return false;
  return page.entries.some((e) => e.position < PINNED_POSITIONS && e.contentId !== null && anchor.contentIds.has(e.contentId));
}

export function decideAfterPage(anchor: AnchorView, page: PageFacts, totals: WalkTotals, cfg: DecideConfig): Decision {
  const cap = cfg.blocked ? 1 : cfg.safetyPageLimit;
  const stop = (outcome: "success" | "gap" | "blocked", stopReason: StopReason, a: "rebuild" | "keep_old" | "empty", extra: { windowOverflow?: boolean } = {}): Decision => ({
    action: "stop",
    outcome,
    stopReason,
    anchor: a,
    windowOverflow: extra.windowOverflow ?? false,
    anomalies,
  });

  // A：归一 has_more。游标不可用的 has_more=true、has_more 缺失 / null / 非法，都记异常并**当作 false**，不猜测、不回发 no_more。
  const anomalies: Anomaly[] = [];
  let hasMore = false;
  if (page.hasMore.state === "value") {
    hasMore = page.hasMore.value;
    if (hasMore && !usableCursor(page.cursor)) {
      anomalies.push({ code: "cursor_no_more_with_has_more", cursorKind: page.cursor.kind });
      hasMore = false;
    }
  } else {
    anomalies.push({ code: "has_more_invalid", state: page.hasMore.state });
  }
  const total = totals.cumulativeEntries;

  // B：empty 锚点没有边界可命中，只处理首个完整页，无视 has_more
  if (anchor.mode === "empty") return total > 0 ? stop("success", "baseline", "rebuild") : stop("success", "empty_list", "empty");

  // C：到目前为止 0 条，且这是最后一页（没有更多，或已到页数上限）
  if (total === 0 && (!hasMore || page.pageNo >= cap)) {
    // 空窗口不能覆盖已有的非空锚点（CONTEXT HighWatermark）
    return anchor.mode === "none" ? stop("success", "empty_list", "empty") : stop("blocked", "empty_window_not_rebased", "keep_old");
  }

  // D：旧锚点命中（第 1 页置顶位置不参与）
  if (anchor.mode === "time" || anchor.mode === "id_window") {
    const eligible = page.pageNo === 1 ? page.entries.filter((e) => e.position >= PINNED_POSITIONS) : page.entries;
    if (eligible.some((e) => hits(anchor, e))) return stop("success", "boundary_hit", "rebuild");
  }

  // E：首次基线累计够了就停；供应商仍有更多历史不算缺口。注意是「返回的条目数」，已返回的整页已经处理完
  if (anchor.mode === "none" && total >= cfg.initialContentLimit) return stop("success", "initial_limit", "rebuild");

  // F：还有更多
  if (hasMore) {
    if (page.pageNo < cap) return { action: "continue", nextCursor: page.cursor as RequestCursor, anomalies: [] };
    return stop("gap", "safety_limit_rebased", "rebuild", { windowOverflow: true });
  }

  // G：列表自然结束（含被当作结束的游标异常）
  if (anchor.mode === "none") return stop("success", "end_of_list", "rebuild");
  // 整张列表已经读完：置顶位置的内容 ID 命中旧集合也说明旧边界仍在、其后的全部内容都已读到，不是缺口（E19）
  if (totals.pinnedIdMatch || pinnedIdMatchOf(anchor, page)) return stop("success", "boundary_hit", "rebuild");
  return stop("gap", anomalies.length > 0 ? "cursor_anomaly_rebased" : "end_of_list_rebased", "rebuild");
}
