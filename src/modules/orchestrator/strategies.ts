// 平台策略：同一条流程里平台之间真正不同的部分。tracer 的流程本身与平台无关。
import {
  XHS_DOMINANT_AUTHOR_V1,
  buildEvidence,
  decideDominantAuthor,
  type DominantListAuthorEvidence,
  type IdentifierRef,
} from "../identity";
import type { ListData, Platform } from "../provider-adapter";

export type ListBinding =
  | { method: "same_payload"; ref: IdentifierRef }
  | { method: "dominant_list_author"; evidence: DominantListAuthorEvidence };

export interface ListBindingIssue {
  code: "identity_conflict" | "field_contract_anomaly" | "dominant_author_rejected";
  severity: "warning";
  discriminator: string;
  detail: Record<string, unknown>;
}

export interface PlatformStrategy {
  platform: Platform;
  /**
   * 完整页解码之后，计算要绑定到目标账号的第二标识，以及需要留下的质量问题。不猜测：证据不足就不绑定。
   * batchId 是长期保留的 SyncBatch，主导作者 evidence 引用它。
   */
  listBindings(ctx: { primary: IdentifierRef; page: ListData; batchId: bigint }): { bindings: ListBinding[]; issues: ListBindingIssue[] };
}

/**
 * 抖音：列表条目同时带 user_id 与 sec_uid（同一 payload 里同一作者实体的两个官方标识）。
 * 目标账号自己的条目里 sec_uid 唯一 → 绑定 douyin.sec_uid；出现多个不同值 → 不绑定并记 identity_conflict。
 * 异作者（例如共创的 HITACHI2023）的 sec_uid 不属于目标账号，不绑定也不建账号。
 */
export const douyinStrategy: PlatformStrategy = {
  platform: "douyin",
  listBindings({ primary, page }) {
    const values = new Set<string>();
    for (const e of page.entries) {
      if (e.author.id.state !== "value" || e.author.id.value !== primary.value) continue;
      if (e.authorSecUid?.state === "value") values.add(e.authorSecUid.value);
    }
    if (values.size === 0) return { bindings: [], issues: [] };
    if (values.size > 1) {
      return {
        bindings: [],
        issues: [
          {
            code: "identity_conflict",
            severity: "warning",
            discriminator: "douyin.sec_uid.multiple_values",
            detail: { namespace: "douyin.sec_uid", distinct_value_count: values.size, reason: "target_author_entries_disagree" },
          },
        ],
      };
    }
    return { bindings: [{ method: "same_payload", ref: { namespace: "douyin.sec_uid", value: [...values][0]! } }], issues: [] };
  },
};

/**
 * 小红书：profile 的 user_id 与列表作者 ID 是不同命名空间。只有版本化主导作者策略通过，才以 dominant_list_author
 * 证据把列表作者 ID 绑定到同一账号；tie / 空 / 低占比 / 样本不足一律不绑定，拒绝决定用同一份 evidence schema 留下问题。
 * 少数作者只进内容事实。不做字符串、昵称相似度猜测。
 */
export const xiaohongshuStrategy: PlatformStrategy = {
  platform: "xiaohongshu",
  listBindings({ page, batchId }) {
    const authors = page.entries.map((e) => (e.author.id.state === "value" ? e.author.id.value : null));
    const decision = decideDominantAuthor(authors, XHS_DOMINANT_AUTHOR_V1);
    const evidence = buildEvidence(decision, { batchId, namespace: "xiaohongshu.content.user_id" });
    if (evidence.decision === "accepted") return { bindings: [{ method: "dominant_list_author", evidence }], issues: [] };
    return {
      bindings: [],
      issues: [
        {
          code: "dominant_author_rejected",
          severity: "warning",
          discriminator: `${evidence.policy_version}:${evidence.reason}`,
          detail: evidence,
        },
      ],
    };
  },
};

/**
 * 快手：主页与列表作者同一命名空间（kuaishou.user_id），没有第二官方标识，昵称与主页链接不是绑定证据 → 不绑定任何第二标识。
 * 列表里的异作者内容保留，不建账号。
 */
export const kuaishouStrategy: PlatformStrategy = {
  platform: "kuaishou",
  listBindings: () => ({ bindings: [], issues: [] }),
};
export const DEFAULT_STRATEGIES: Readonly<Record<string, PlatformStrategy>> = Object.freeze({
  douyin: douyinStrategy,
  xiaohongshu: xiaohongshuStrategy,
  kuaishou: kuaishouStrategy,
});
