// platform × action × mode × environment 的能力门控（R13.5–R13.8；design §8.2）。
// 枚举里存在的平台/action 不等于支持；fixture 证据不能启用 production。
// production 放行只按显式批准名单（PRODUCTION_APPROVAL，刘学奎 2026-11-12）：抖音与小红书的全部 action；
// 快手、以及任何 provider_failed 的 tuple 仍然被拒。更新证据需要人工，没有自动路径。
import type { AiMasterAction, ExecutionMode, Platform } from "./contract";

export type Environment = "test" | "staging" | "production";
export type EvidenceLevel = "unknown" | "supplier_declared" | "fixture_observed" | "smoke_verified";

export interface CapabilityKey {
  platform: Platform;
  action: AiMasterAction;
  mode: ExecutionMode;
  environment: Environment;
}

export interface CapabilityProfile extends CapabilityKey {
  requestSchemaVersion: string;
  responseSchemaVersion: string;
  evidenceLevel: EvidenceLevel;
  /** smoke 实际观察到的结果；provider_failed 的 tuple 在任何环境都不放行。 */
  observedOutcome: "succeeded" | "provider_failed";
  activation: "disabled" | "approved";
  /** tests/fixtures/aimaster/manifest.json 中的 entry id。 */
  evidenceRef: string[];
  /** 已知但尚未关闭的证据缺口；不能被实现默认值静默填平。 */
  knownGaps: string[];
  /** production 放行的批准记录；只有 production 且 activation=approved 时有值。 */
  approval?: { by: string; at: string; ref: string };
}

export type UnsupportedReason = "unregistered" | "provider_failed" | "disabled" | "evidence_insufficient";

export class UnsupportedCapabilityError extends Error {
  constructor(
    readonly reason: UnsupportedReason,
    readonly key: CapabilityKey,
  ) {
    super(`capability 不可用（${reason}）：${keyOf(key)}`);
    this.name = "UnsupportedCapabilityError";
  }
}

const keyOf = (k: CapabilityKey) => `${k.platform}/${k.action}/${k.mode}/${k.environment}`;

export function createCapabilityGate(profiles: readonly CapabilityProfile[]) {
  const table = new Map<string, CapabilityProfile>();
  for (const p of profiles) {
    const k = keyOf(p);
    if (table.has(k)) throw new Error(`capability 重复登记：${k}`);
    table.set(k, p);
  }

  return {
    /** 付费请求之前调用。通过返回登记项，否则抛 UnsupportedCapabilityError，不尝试近似项。 */
    require(key: CapabilityKey): CapabilityProfile {
      const p = table.get(keyOf(key));
      if (!p) throw new UnsupportedCapabilityError("unregistered", key);
      if (p.observedOutcome === "provider_failed") throw new UnsupportedCapabilityError("provider_failed", key);
      if (p.activation !== "approved") throw new UnsupportedCapabilityError("disabled", key);
      // test 环境（fake transport）接受 fixture_observed 及以上；staging / production 必须 smoke_verified
      const enough =
        key.environment === "test"
          ? p.evidenceLevel === "fixture_observed" || p.evidenceLevel === "smoke_verified"
          : p.evidenceLevel === "smoke_verified";
      if (!enough) throw new UnsupportedCapabilityError("evidence_insufficient", key);
      return p;
    },
  };
}

// ── 默认登记表：按 raw4 / raw5 / raw8 固化 ──────────────────────────────
interface Tuple {
  platform: Platform;
  action: AiMasterAction;
  mode: ExecutionMode;
  outcome: CapabilityProfile["observedOutcome"];
  evidenceRef: string[];
  /** 额外的已知缺口。 */
  gaps?: string[];
}

const TUPLES: Tuple[] = [
  // ── 主页 / 列表（tracer）──
  // 同步主页 / 列表：抖音、小红书 smoke_verified（raw4）
  { platform: "douyin", action: "media_user_info", mode: "synchronous", outcome: "succeeded", evidenceRef: ["raw4.C01"] },
  { platform: "xiaohongshu", action: "media_user_info", mode: "synchronous", outcome: "succeeded", evidenceRef: ["raw4.C02"] },
  { platform: "douyin", action: "user_video_list", mode: "synchronous", outcome: "succeeded", evidenceRef: ["raw4.C03"] },
  { platform: "xiaohongshu", action: "user_video_list", mode: "synchronous", outcome: "succeeded", evidenceRef: ["raw4.C04"] },
  // 异步主页：抖音 raw4 C09，小红书 raw5 C02
  { platform: "douyin", action: "media_user_info", mode: "asynchronous", outcome: "succeeded", evidenceRef: ["raw4.C09.submit", "raw4.C09.poll1"] },
  { platform: "xiaohongshu", action: "media_user_info", mode: "asynchronous", outcome: "succeeded", evidenceRef: ["raw5.C02.submit", "raw5.C02.poll1"] },
  // 异步列表：抖音、小红书 provider-failed（RESULT_VALIDATION_FAILED），保持 disabled
  { platform: "douyin", action: "user_video_list", mode: "asynchronous", outcome: "provider_failed", evidenceRef: ["raw8.A2.poll1"] },
  { platform: "xiaohongshu", action: "user_video_list", mode: "asynchronous", outcome: "provider_failed", evidenceRef: ["raw4.C10.poll1", "raw5.C04.poll1"] },
  // ── 快手主页 / 列表（a-full-sync；raw12 / raw13 / raw14）──
  { platform: "kuaishou", action: "media_user_info", mode: "synchronous", outcome: "succeeded", evidenceRef: ["raw12.K1", "raw12.K2"] },
  { platform: "kuaishou", action: "user_video_list", mode: "synchronous", outcome: "succeeded", evidenceRef: ["raw12.K3", "raw13.L3"] },
  { platform: "kuaishou", action: "media_user_info", mode: "asynchronous", outcome: "succeeded", evidenceRef: ["raw14.A1.submit", "raw14.A1.poll1", "raw14.A1.poll2"] },
  { platform: "kuaishou", action: "user_video_list", mode: "asynchronous", outcome: "provider_failed", evidenceRef: ["raw14.A2.poll1"] },
  // ── 详情 media_stats_number（响应动作 media_stats）──
  { platform: "douyin", action: "media_stats_number", mode: "synchronous", outcome: "succeeded", evidenceRef: ["raw4.C05"] },
  { platform: "xiaohongshu", action: "media_stats_number", mode: "synchronous", outcome: "succeeded", evidenceRef: ["raw4.C06"] },
  { platform: "kuaishou", action: "media_stats_number", mode: "synchronous", outcome: "succeeded", evidenceRef: ["raw13.V1", "raw12.K4"] },
  { platform: "douyin", action: "media_stats_number", mode: "asynchronous", outcome: "succeeded", evidenceRef: ["raw9.A5.submit", "raw9.A5.poll1"] },
  { platform: "xiaohongshu", action: "media_stats_number", mode: "asynchronous", outcome: "succeeded", evidenceRef: ["raw5.C06.submit", "raw5.C06.poll1"] },
  { platform: "kuaishou", action: "media_stats_number", mode: "asynchronous", outcome: "succeeded", evidenceRef: ["raw14.A3.submit", "raw14.A3.poll1", "raw14.A3.poll2"] },
  // ── 评论 post_comments_list：快手不登记（D-51）；抖音异步 provider-failed ──
  { platform: "douyin", action: "post_comments_list", mode: "synchronous", outcome: "succeeded", evidenceRef: ["raw4.C07"] },
  { platform: "xiaohongshu", action: "post_comments_list", mode: "synchronous", outcome: "succeeded", evidenceRef: ["raw4.C08.attempt2", "raw6.C02"], gaps: ["intermittent_result_validation_failed"] },
  { platform: "xiaohongshu", action: "post_comments_list", mode: "asynchronous", outcome: "succeeded", evidenceRef: ["raw9.A4.submit", "raw9.A4.poll1"] },
  { platform: "douyin", action: "post_comments_list", mode: "asynchronous", outcome: "provider_failed", evidenceRef: ["raw8.A3.poll1"] },
];

/** 生产放行批准（刘学奎 2026-11-12）：批准范围是**抖音与小红书的全部 action**，预算上限原为 1 万元、有效期一年（2026-11-19 刘学奎调整为年度 3 万元、单批 20000 点；2026-11-20 再调整为年度 5 万元、单批 30000 点）；
 *  快手不在名单里。证据来自 2026-11-04 的批准式 smoke（见 a-data-foundation-tracer acceptance ENV-2）。
 *  更新证据与放行范围都需要人工，没有自动路径；provider_failed 的 tuple 即使在此名单里也被 gate 拒绝。 */
const PRODUCTION_APPROVAL = Object.freeze({
  by: "刘学奎",
  at: "2026-11-12",
  ref: ".kiro/specs/a-data-foundation-tracer/acceptance.md ENV-2（2026-11-04 批准式 smoke）",
});
const PRODUCTION_APPROVED_PLATFORMS: ReadonlySet<Platform> = new Set<Platform>(["douyin", "xiaohongshu"]);

function rowsFor(t: Tuple): CapabilityProfile[] {
  const knownGaps = [
    "auth_header_doc_contradiction", // 文档写 Bearer，raw4 实测 X-Api-Key；保存的样本头里不含认证头，生产前仍需批准式 smoke
    ...(t.gaps ?? []),
    ...(t.action === "media_user_info"
      ? [
          "non_home_locator_response_unobserved", // 没有把视频/笔记链接传给主页接口的样本
          "response_platform_unobservable", // 响应里没有 platform 字段（raw3），平台错配只能在发送前按入口判断
        ]
      : []),
  ];
  const common = {
    platform: t.platform,
    action: t.action,
    mode: t.mode,
    requestSchemaVersion: "aimaster-request.v1",
    responseSchemaVersion: "aimaster-response.v1",
    evidenceLevel: "smoke_verified" as const,
    observedOutcome: t.outcome,
    evidenceRef: t.evidenceRef,
    knownGaps,
  };
  // 只有批准名单里的平台、且 smoke 结果为 succeeded 的 tuple 才放行生产；其余保持 disabled。
  const productionApproved = t.outcome === "succeeded" && PRODUCTION_APPROVED_PLATFORMS.has(t.platform);
  return [
    // test：只用于 fixture transport，不代表可以访问真实供应商
    { ...common, environment: "test", activation: t.outcome === "succeeded" ? "approved" : "disabled" },
    // production：按批准名单放行；provider_failed 的 tuple 由 gate 另行拒绝
    {
      ...common,
      environment: "production",
      activation: productionApproved ? "approved" : "disabled",
      ...(productionApproved ? { approval: PRODUCTION_APPROVAL } : {}),
    },
  ];
}

export const CAPABILITY_PROFILES: readonly CapabilityProfile[] = Object.freeze(TUPLES.flatMap(rowsFor));

export const capabilityGate = createCapabilityGate(CAPABILITY_PROFILES);
