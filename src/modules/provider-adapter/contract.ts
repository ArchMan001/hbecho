// 版本化 Adapter 的输入/输出合同。decode 只吃已捕获的字节（任务 3 起由 RawCaptureGateway 保证先落 ODS）。
import type { CountState, ValueState } from "./value-state";

export const ADAPTER_VERSION = "aimaster-adapter.v1";

export type Platform = "douyin" | "xiaohongshu";
export type AiMasterAction = "media_user_info" | "user_video_list";
export type ExecutionMode = "synchronous" | "asynchronous";

/** 代码枚举（D-25）：新增 namespace 必须先改 CONTEXT 与此处，Adapter 不得临时造名。 */
export type IdentifierNamespace =
  | "douyin.user_id"
  | "douyin.sec_uid"
  | "xiaohongshu.profile.user_id"
  | "xiaohongshu.content.user_id";

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
  followerCount: CountState;
  followingCount: CountState;
  likeCount: CountState;
  postCount: CountState;
  providerUpdatedAtMs: CountState;
  /** 只含非空 URL；URL 是临时地址，不是媒资身份。 */
  mediaCandidates: Array<{ role: "avatar" | "background"; url: string }>;
}

export interface CoverCandidates {
  candidates: string[];
  selected: string | null;
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
