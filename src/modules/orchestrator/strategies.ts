// 平台策略：同一条流程里平台之间真正不同的部分。tracer 的流程本身与平台无关。
import type { IdentifierRef } from "../identity";
import type { ListData, Platform } from "../provider-adapter";

export interface ListBindingIssue {
  code: "identity_conflict" | "field_contract_anomaly";
  severity: "warning";
  discriminator: string;
  detail: Record<string, unknown>;
}

export interface PlatformStrategy {
  platform: Platform;
  /**
   * 完整页解码之后，计算要绑定到目标账号的第二标识（同一 payload 明确关联的官方标识），
   * 以及需要留下的质量问题。不猜测：证据不足就不绑定。
   */
  listBindings(ctx: { primary: IdentifierRef; page: ListData }): { bindings: IdentifierRef[]; issues: ListBindingIssue[] };
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
    return { bindings: [{ namespace: "douyin.sec_uid", value: [...values][0]! }], issues: [] };
  },
};

export const DEFAULT_STRATEGIES: Readonly<Record<string, PlatformStrategy>> = Object.freeze({ douyin: douyinStrategy });
