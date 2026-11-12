// 五态合成（design §7.6）：纯函数，输入是已经取好的事实，输出 SignalValue。判断顺序固定，表驱动测试逐分支覆盖。
// 存储态只有 valid / failed；missing / stale / not_applicable 是读取时由「没有行」「版本落后」「输入不存在」推出来的（SG-2）。
import type { CatalogEntry } from "./catalog";
import type { Material } from "./facts";

export type SignalState = "valid" | "stale" | "failed" | "missing" | "not_applicable";
export type StalePolicy = "use_stale" | "as_unknown";
export type PendingHint = "queued" | "running" | "dead";

export type NotApplicableReason = "platform_unsupported" | "field_absent_on_platform" | "no_reference";
export type MissingReason =
  | "not_computed"
  | "no_profile_snapshot"
  | "media_pending"
  | "media_failed"
  | "media_carried_forward"
  | "audio_not_archived"
  | "capability_disabled"
  | "compute_dead"
  | "failed_under_old_version";

export interface SignalValue {
  state: SignalState;
  /** valid 为真；stale 由 stalePolicy 决定；其余为假。不可用时不带 value。 */
  usable: boolean;
  /** 仅文本类信号：写入该值时所用的 text.normalize 版本（D 用它归一化关键词）。 */
  normalizerVersion?: number;
  value?: unknown;
  score?: number;
  evidence?: unknown;
  capability?: { id: string; version: number };
  producedAt?: Date;
  /** missing / failed / not_applicable 的稳定原因码（failed 为失败码）。 */
  reason?: string;
  pending?: PendingHint;
  /** 派生信号的结果行 ID，D 保存证据时用它调用 retainUntil。 */
  resultId?: bigint;
}

/** 已存储的最高版本一行（特征行信封条目 + 列值，或结果行）。 */
export interface StoredSignal {
  state: "valid" | "failed";
  capabilityId: string;
  version: number;
  nv?: number | undefined;
  producedAt: Date;
  value?: unknown;
  score?: number | undefined;
  evidence?: unknown;
  failureCode?: string | undefined;
  resultId?: bigint | undefined;
}

export interface ComposeInput {
  entry: CatalogEntry;
  /** 对象所在平台；不在 entry.platforms 里 → not_applicable(platform_unsupported)。 */
  platform: string;
  /** 平台的列表 / 详情根本没有这个文本字段（PLATFORM_TEXT_FIELDS）。 */
  fieldAbsent?: boolean;
  /** 结果行类信号的输入素材（封面 / 头像 / 背景 / 音频）；特征行类不传。 */
  material?: Material;
  stored?: StoredSignal | undefined;
  /** 目录当前的能力标识与版本；文本类还要 currentNv（text.normalize 的当前版本）。 */
  current: { capabilityId: string; version: number; nv?: number };
  /** 该能力已启用（含网关 activeModel 非空）。 */
  enabled: boolean;
  /** 活动任务 / dead 任务的提示。 */
  pending?: PendingHint | undefined;
  stalePolicy: StalePolicy;
}

const na = (reason: NotApplicableReason): SignalValue => ({ state: "not_applicable", usable: false, reason });
const missing = (reason: MissingReason, pending?: PendingHint): SignalValue => ({ state: "missing", usable: false, reason, ...(pending ? { pending } : {}) });

export function composeState(i: ComposeInput): SignalValue {
  // 2. 平台：文本字段缺失优先于「平台不在可得集合」，让 body / 快手得到 field_absent_on_platform
  if (i.fieldAbsent) return na("field_absent_on_platform");
  if (!(i.entry.platforms as readonly string[]).includes(i.platform)) return na("platform_unsupported");
  // 3. 输入适用性（结果行类）
  if (i.material?.state === "not_applicable") return na(i.material.reason);
  if (i.material?.state === "missing" && i.material.reason === "no_profile_snapshot") return missing("no_profile_snapshot");

  const s = i.stored;
  if (s) {
    // 4. 已存储的最高版本行决定；读取已存储的值不受启用开关影响
    const isText = i.entry.storage === "feature_row";
    const isCurrent = s.version === i.current.version && (!isText || s.nv === i.current.nv);
    const common = { capability: { id: s.capabilityId, version: s.version }, producedAt: s.producedAt, ...(s.nv === undefined ? {} : { normalizerVersion: s.nv }), ...(s.resultId === undefined ? {} : { resultId: s.resultId }) };
    if (s.state === "valid" && isCurrent) return { state: "valid", usable: true, ...common, value: s.value, ...(s.score === undefined ? {} : { score: s.score }), evidence: s.evidence };
    if (s.state === "valid") {
      const usable = i.stalePolicy === "use_stale";
      return { state: "stale", usable, ...common, ...(usable ? { value: s.value, ...(s.score === undefined ? {} : { score: s.score }), evidence: s.evidence } : {}) };
    }
    // failed：当前版本下的确定性失败 → failed；旧版本的 failed 不是新代码的证据 → missing
    if (isCurrent) return { state: "failed", usable: false, ...common, reason: s.failureCode ?? "unknown", evidence: s.evidence };
    return missing("failed_under_old_version");
  }

  // 5. 没有行：素材缺口 → 能力未启用 → 任务状态 → 尚未计算
  if (i.material?.state === "missing") return missing(i.material.reason);
  if (!i.enabled) return missing("capability_disabled");
  if (i.pending === "queued" || i.pending === "running") return missing("not_computed", i.pending);
  if (i.pending === "dead") return missing("compute_dead", "dead");
  return missing("not_computed");
}
