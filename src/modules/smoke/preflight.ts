// 真实 smoke 的启动前门槛（R17.1–R17.3、R17.6）：运行期开关、人工审批记录、locator/action/mode allowlist、
// 固定 call / poll / 点数预算、deadline。任何一条不满足都抛 SmokeRefused——这发生在读取 secret 与发出网络调用**之前**。
// 本模块是纯逻辑：不读文件、不碰数据库、不碰网络、不读 secret。
import { z } from "zod";
import { jcsSha256Hex, type JcsValue } from "../canonical-json";
import { YUAN_PER_POINT, pointsOf } from "../cost-guard";
import { CAPABILITY_PROFILES } from "../provider-adapter";

export const SMOKE_SWITCH_ENV = "HBECHO_SMOKE";
/** 约定值：故意写成不会被随手设成 1 / true 的字符串。 */
export const SMOKE_SWITCH_VALUE = "approved-paid-calls";
const MAX_APPROVAL_WINDOW_MS = 24 * 3600 * 1000;

export type SmokeRefusalCode =
  | "switch_off"
  | "approval_missing"
  | "approval_invalid"
  | "approval_expired"
  | "approval_not_yet_valid"
  | "approval_window_too_long"
  | "plan_invalid"
  | "approval_plan_mismatch"
  | "allowlist_tuple_unavailable"
  | "allowlist_duplicate"
  | "budget_too_small";

/** 稳定拒绝码 + 不回显 locator、审批细节的消息。 */
export class SmokeRefused extends Error {
  constructor(
    readonly code: SmokeRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = "SmokeRefused";
  }
}

const planSchema = z.strictObject({
  schema_version: z.literal("data-foundation-smoke-plan.v1"),
  environment: z.enum(["staging", "production"]),
  allowlist: z
    .array(
      z.strictObject({
        platform: z.enum(["douyin", "xiaohongshu"]),
        action: z.enum(["media_user_info", "user_video_list"]),
        mode: z.enum(["synchronous", "asynchronous"]),
        locator: z.string().min(1).max(2048),
      }),
    )
    .min(1)
    .max(10),
  budget: z.strictObject({
    max_calls: z.number().int().min(1).max(50),
    max_polls: z.number().int().min(0).max(100),
    max_points: z.number().int().min(1).max(1000),
  }),
  deadline_ms: z.number().int().min(1_000).max(3_600_000),
  poll_interval_ms: z.number().int().min(100).max(60_000).optional(),
});
export type SmokePlan = z.infer<typeof planSchema>;

const approvalSchema = z.strictObject({
  schema_version: z.literal("data-foundation-smoke-approval.v1"),
  approved_by: z.string().trim().min(1).max(128),
  approved_at: z.iso.datetime(),
  expires_at: z.iso.datetime(),
  plan_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  reason: z.string().trim().min(1).max(500),
});

export interface SmokePreview {
  entries: Array<{ platform: string; action: string; mode: string; points: number }>;
  nominalCalls: number;
  nominalPoints: number;
  nominalYuan: number;
  budget: { maxCalls: number; maxPolls: number; maxPoints: number };
  deadlineMs: number;
  environment: "staging" | "production";
}

/** preflight 通过的凭证：runSmoke 只接受它，所以绕过门槛在类型上就走不通。 */
export interface SmokeAuthorized {
  readonly plan: SmokePlan;
  readonly approvedBy: string;
  readonly approvalExpiresAt: Date;
  readonly planSha256: string;
  readonly preview: SmokePreview;
}

/** 计划校验（形状、allowlist、预算）。预览与正式放行共用，所以预览看到的就是放行时会校验的。 */
export function validatePlan(input: unknown): { plan: SmokePlan; planSha256: string; preview: SmokePreview } {
  const p = planSchema.safeParse(input);
  if (!p.success) throw new SmokeRefused("plan_invalid", `计划不合法：${p.error.issues.map((i) => i.path.join(".") || "$").slice(0, 5).join(", ")}`);
  const plan = p.data;
  const planSha256 = jcsSha256Hex(JSON.parse(JSON.stringify(plan)) as JcsValue); // 去掉 undefined 的可选字段

  // allowlist：只允许有实测证据且没有已知供应商失败的 tuple；不允许重复
  const seen = new Set<string>();
  for (const e of plan.allowlist) {
    const key = `${e.platform}/${e.action}/${e.mode}/${e.locator}`;
    if (seen.has(key)) throw new SmokeRefused("allowlist_duplicate", "allowlist 有重复项");
    seen.add(key);
    const profile = CAPABILITY_PROFILES.find((c) => c.environment === "production" && c.platform === e.platform && c.action === e.action && c.mode === e.mode);
    if (!profile || profile.observedOutcome !== "succeeded") {
      throw new SmokeRefused("allowlist_tuple_unavailable", `${e.platform}/${e.action}/${e.mode} 没有可 smoke 的已观察 tuple（未登记或供应商侧已知失败）`);
    }
  }

  // 预算：名义用量（不含重试）必须放得下；运行时的硬上限由 createBudgetPolicy 在每次调用前强制
  const entries = plan.allowlist.map((e) => ({ platform: e.platform, action: e.action, mode: e.mode, points: pointsOf(e.platform, e.action) }));
  const nominalCalls = entries.length;
  const nominalPoints = entries.reduce((n, e) => n + e.points, 0);
  if (nominalCalls > plan.budget.max_calls || nominalPoints > plan.budget.max_points) throw new SmokeRefused("budget_too_small", "预算放不下名义用量");
  return {
    plan,
    planSha256,
    preview: {
      entries,
      nominalCalls,
      nominalPoints,
      nominalYuan: Math.round(nominalPoints * YUAN_PER_POINT * 1e6) / 1e6,
      budget: { maxCalls: plan.budget.max_calls, maxPolls: plan.budget.max_polls, maxPoints: plan.budget.max_points },
      deadlineMs: plan.deadline_ms,
      environment: plan.environment,
    },
  };
}

export function preflight(input: { plan: unknown; approval: unknown | null; env: Record<string, string | undefined>; now: Date }): SmokeAuthorized {
  // 1) 运行期开关
  if (input.env[SMOKE_SWITCH_ENV] !== SMOKE_SWITCH_VALUE) throw new SmokeRefused("switch_off", `运行期开关 ${SMOKE_SWITCH_ENV} 未设置为约定值`);

  // 2) 人工审批记录（形状、批准人、有效期）
  if (input.approval === null || input.approval === undefined) throw new SmokeRefused("approval_missing", "没有审批记录");
  const a = approvalSchema.safeParse(input.approval);
  if (!a.success) throw new SmokeRefused("approval_invalid", "审批记录不合法（缺批准人 / 原因 / 摘要，或有未知字段）");
  const approvedAt = new Date(a.data.approved_at);
  const expiresAt = new Date(a.data.expires_at);
  if (approvedAt.getTime() > input.now.getTime()) throw new SmokeRefused("approval_not_yet_valid", "审批的批准时间在未来");
  if (expiresAt.getTime() <= input.now.getTime()) throw new SmokeRefused("approval_expired", "审批已过期");
  if (expiresAt.getTime() - approvedAt.getTime() > MAX_APPROVAL_WINDOW_MS) throw new SmokeRefused("approval_window_too_long", "审批有效期超过 24 小时");

  // 3) 计划本身 + allowlist + 预算
  const v = validatePlan(input.plan);

  // 4) 审批绑定到这份计划的 JCS 摘要：改任何一处都需要重新审批
  if (v.planSha256 !== a.data.plan_sha256) throw new SmokeRefused("approval_plan_mismatch", "审批对应的不是这份计划");

  return {
    plan: v.plan,
    approvedBy: a.data.approved_by,
    approvalExpiresAt: expiresAt,
    planSha256: v.planSha256,
    preview: v.preview,
  };
}
