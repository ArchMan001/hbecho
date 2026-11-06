// 按需采集（Demand）的输入、处置与查询视图（FS-8、design §5.4、§7.8）。A 只执行不决定：这里没有阈值、没有圈定条件。
import { z } from "zod";

export const WANTS = ["detail", "comments", "video", "audio"] as const;
export type Want = (typeof WANTS)[number];
export const DISPOSITIONS = ["queued", "reused", "already_pending", "unsupported_platform", "capability_disabled", "content_not_found", "out_of_scope"] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

const decimalId = z.string().regex(/^[1-9]\d*$/, "必须是不带前导零的正十进制整数 string");
export const MAX_DEMAND_ITEMS = 5000;
export const submitSchema = z.strictObject({
  demandKey: z.string().min(1).max(200),
  requester: z.strictObject({ kind: z.string().min(1).max(64), ref: z.string().min(1).max(256), version: z.string().min(1).max(128) }),
  ruleDecisionId: z.string().min(1).max(256),
  ruleVersion: z.string().min(1).max(128),
  items: z.array(z.strictObject({ contentId: decimalId, wants: z.array(z.enum(WANTS)).min(1).max(WANTS.length) })).min(1).max(MAX_DEMAND_ITEMS),
});
export type SubmitDemand = z.input<typeof submitSchema>;

export interface DispositionRow {
  contentId: string;
  want: Want;
  disposition: Disposition;
  /** already_pending：复用的活动任务（可能属于别的批次）。 */
  taskId?: string;
}
export type SubmitResult = { kind: "created" | "deduplicated"; batchId: string; status: string; dispositions: DispositionRow[]; taskCount: number };

export type WantState = "pending" | "running" | "ready" | "failed" | "unsupported" | "reused_ready";
export interface WantView {
  contentId: string;
  want: Want;
  state: WantState;
  disposition: Disposition;
  /** 稳定失败原因（failed）或拒绝原因（unsupported）。 */
  reason?: string;
  pointers?: {
    contentSnapshotId?: string;
    comments?: { fetchedAt: string; coverage: "complete" | "partial" | "unknown"; fetchedCount: number; reportedTotal: string | null };
    mediaAssetId?: string;
  };
}
export interface DemandView {
  batchId: string;
  status: string;
  items: WantView[];
}

/** 提交时需要的运行时配置：环境，以及详情 / 评论各自的执行模式（按已验证 capability 配置，不写死同步或异步）。 */
export interface DemandRuntime {
  environment: "test" | "staging" | "production";
  modes: { media_stats_number: "synchronous" | "asynchronous"; post_comments_list: "synchronous" | "asynchronous" };
}

/** 规划好的一个任务（存进批次快照，重放时按它补齐缺失任务）。 */
export interface PlannedTask {
  contentId: string;
  accountId: string;
  assignmentId: string;
  platformId: string;
  action: "fetch_content_detail" | "fetch_comments" | "download_media";
  params: Record<string, unknown>;
  sourceSnapshotId: string | null;
}
