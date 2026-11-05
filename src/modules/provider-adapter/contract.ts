// 版本化 Adapter 的输入/输出合同。decode 只吃已捕获的字节（任务 3 起由 RawCaptureGateway 保证先落 ODS）。
import type { CountState, ValueState } from "./value-state";

export const ADAPTER_VERSION = "aimaster-adapter.v1";

export type Platform = "douyin" | "xiaohongshu" | "kuaishou";
/** 请求动作（capability 的键）。media_stats_number 的响应动作是 media_stats，见 envelope.ts。 */
export type AiMasterAction = "media_user_info" | "user_video_list" | "media_stats_number" | "post_comments_list";
export type ExecutionMode = "synchronous" | "asynchronous";

/** 代码枚举（D-25）：新增 namespace 必须先改 CONTEXT 与此处，Adapter 不得临时造名。 */
export type IdentifierNamespace =
  | "douyin.user_id"
  | "douyin.sec_uid"
  | "xiaohongshu.profile.user_id"
  | "xiaohongshu.content.user_id"
  | "kuaishou.user_id";

/** requested / expected / actual 分列；不一致时三者都保留，不要求相等（v2 §2.2）。 */
export interface ActionExchange {
  requested: AiMasterAction;
  expectedResponse: string;
  actualResponse: ValueState<string>;
}

export type ContentKind = "video" | "image" | "text" | "unknown"; // 不输出 mixed

/** 类型保真游标（v2 §9.4 cursor_envelope）；absent / invalid 只在解码结果里出现，不会被持久化或回发。 */
export type TypedCursor =
  | { kind: "integer"; lexeme: string }
  | { kind: "string"; value: string }
  | { kind: "null" }
  /** 快手列表结束的哨兵字符串 "no_more"（D-53）：不是游标，绝不回发；与 has_more=true 同时出现是游标异常。 */
  | { kind: "no_more" }
  | { kind: "absent" }
  | { kind: "invalid"; raw: string };

/** 可以放进请求的游标：只有整数和字符串，二者不互转。 */
export type RequestCursor = Extract<TypedCursor, { kind: "integer" | "string" }>;

interface DecodeBase {
  adapterVersion: string;
  platform: Platform;
  exchange: ActionExchange;
}

export type DecodeOutcome<T> =
  | (DecodeBase & { outcome: "decoded"; taskId: ValueState<string>; data: T })
  | (DecodeBase & {
      outcome: "not_succeeded";
      taskStatus: string;
      error: { code: string | null; message: string | null } | null;
    })
  | (DecodeBase & { outcome: "invalid_response"; reason: "action_mismatch" })
  | { outcome: "schema_drift"; adapterVersion: string; platform: Platform; issues: string[] };

export interface ProfileData {
  account: { namespace: IdentifierNamespace; id: ValueState<string> };
  nickname: ValueState<string>;
  signature: ValueState<string>;
  /** 抖音有；小红书主页没有该字段 → missing。 */
  location: ValueState<string>;
  followerCount: CountState;
  followingCount: CountState;
  likeCount: CountState;
  postCount: CountState;
  providerUpdatedAtMs: CountState;
  /** 只含非空 URL；URL 是临时地址，不是媒资身份。 */
  mediaCandidates: Array<{ role: "avatar" | "background"; url: string; jsonPath: string }>;
}

export interface CoverCandidates {
  candidates: string[];
  selected: string | null;
  /** 选中候选在响应里的 JSON 路径（media_references.source_json_path）；未选中为 null。 */
  selectedJsonPath: string | null;
  selection: "second_of_array" | "single_string" | "unavailable";
}

export interface ListEntry {
  /** 在返回数组中的 0 基位置。 */
  position: number;
  postId: ValueState<string>;
  author: { namespace: IdentifierNamespace; id: ValueState<string> };
  /** 仅抖音有第二官方标识；小红书为 null。 */
  authorSecUid: ValueState<string> | null;
  authorName: ValueState<string>;
  title: ValueState<string>;
  text: ValueState<string>;
  /** 发布地（抖音）、话题文本、分享页地址（抖音）、搜索词（抖音）：快照长期保留这些字段，ODS 一年后消失。 */
  publishLocation: ValueState<string>;
  tagText: ValueState<string>;
  shareUrl: ValueState<string>;
  relatedSearchTerms: ValueState<string[]>;
  /**
   * 时长（秒，十进制小数原文）。只在有视频素材时读取：没有视频的条目 video.duration 是 0 占位，
   * 不当作真实时长，记 missing。
   */
  durationSeconds: ValueState<string>;
  publishedAtMs: CountState;
  metrics: { like: CountState; comment: CountState; collect: CountState; share: CountState; play: CountState };
  contentKind: ContentKind;
  cover: CoverCandidates;
}

export interface ListData {
  /** 返回页里的全部条目，不按任何本地 limit 截断。 */
  entries: ListEntry[];
  hasMore: ValueState<boolean>;
  maxCursor: TypedCursor;
}

/** 详情（请求 media_stats_number，响应 media_stats）。`*_number` 优先，`*_count` 回退；两者不并列为独立指标。 */
export interface DetailData {
  postId: ValueState<string>;
  /** 响应里的 platform 回显，仅用于核对；详情里的 user_id 是作者，不一定是被采集账号（共创）。 */
  platformEcho: ValueState<string>;
  author: { namespace: IdentifierNamespace; id: ValueState<string> };
  authorName: ValueState<string>;
  authorHomepage: ValueState<string>;
  title: ValueState<string>;
  tagText: ValueState<string>;
  publishLocation: ValueState<string>;
  relatedSearchTerms: ValueState<string[]>;
  publishedAtMs: CountState;
  /** 小红书图文笔记 play_number=null → explicit_null，不是 0。 */
  metrics: { play: CountState; like: CountState; comment: CountState; collect: CountState; share: CountState };
  /** 十进制小数原文；单位按平台（秒），不换算。 */
  durationSeconds: ValueState<string>;
  /** 详情里 cover / download_urls 是字符串（可能换行分隔），展开为候选集；全部保留，临时地址不是媒资身份。 */
  coverCandidates: string[];
  downloadCandidates: string[];
  providerUpdatedAtMs: CountState;
}
export interface CommentEntry {
  /** 在返回数组中的 0 基位置（含被忽略的回复，便于对照原始响应）。 */
  position: number;
  id: ValueState<string>;
  postId: ValueState<string>;
  content: ValueState<string>;
  authorId: ValueState<string>;
  authorName: ValueState<string>;
  likeCount: CountState;
  replyCount: CountState;
  createdAtMs: CountState;
  updatedAtMs: CountState;
}
export interface CommentsData {
  /** 一级评论。带 parent_id 的回复不进入这里（只保存一级评论最新态）。 */
  entries: CommentEntry[];
  /** 本页被忽略的回复数（带非空 parent_id 的条目）。 */
  ignoredReplyCount: number;
  /** 本页返回的条目总数（一级 + 回复）。 */
  returnedCount: number;
  hasMore: ValueState<boolean>;
  maxCursor: TypedCursor;
  /** 平台报告的总评论数，含回复，不等于可获取条数（D-50）。 */
  total: CountState;
  postId: ValueState<string>;
}
