// 任务 9：真实 smoke 的启动前门槛（R17.1–R17.3、R17.6）。全部是纯逻辑：没有网络、没有数据库、没有 secret。
// 核心不变量：任何一条门槛不满足，都在**任何**网络调用与 secret 读取之前失败，且失败码稳定。
import { describe, expect, it } from "vitest";
import { jcsSha256Hex } from "../canonical-json";
import { SMOKE_SWITCH_ENV, SMOKE_SWITCH_VALUE, SmokeRefused, preflight, type SmokeRefusalCode } from "./index";

const NOW = new Date("2026-11-04T12:00:00.000Z");
const LOCATOR = "https://v.douyin.com/MPOAlEqWpec/";

const plan = (over: Record<string, unknown> = {}) => ({
  schema_version: "data-foundation-smoke-plan.v1",
  environment: "production",
  allowlist: [
    { platform: "douyin", action: "media_user_info", mode: "synchronous", locator: LOCATOR },
    { platform: "douyin", action: "user_video_list", mode: "synchronous", locator: LOCATOR },
  ],
  budget: { max_calls: 2, max_polls: 0, max_points: 20 },
  deadline_ms: 120_000,
  ...over,
});
/** 非法计划（Infinity / undefined 等）JCS 本来就拒绝：此时用占位摘要，门槛应在比对摘要之前就以 plan_invalid 拒绝。 */
const hashOf = (p: unknown): string => {
  try {
    return jcsSha256Hex(p as never);
  } catch {
    return "0".repeat(64);
  }
};
const approvalFor = (p: unknown, over: Record<string, unknown> = {}) => ({
  schema_version: "data-foundation-smoke-approval.v1",
  approved_by: "liuxuekui",
  approved_at: "2026-11-04T11:30:00.000Z",
  expires_at: "2026-11-04T18:00:00.000Z",
  plan_sha256: hashOf(p),
  reason: "首次批准式 smoke：抖音主页 + 列表各 1 次",
  ...over,
});
const ENV_ON = { [SMOKE_SWITCH_ENV]: SMOKE_SWITCH_VALUE };

function refusal(input: Parameters<typeof preflight>[0]): SmokeRefusalCode | null {
  try {
    preflight(input);
  } catch (e) {
    if (e instanceof SmokeRefused) return e.code;
    throw e;
  }
  return null;
}

describe("preflight：全部满足才放行，并给出预算预览", () => {
  it("放行：预览含逐项点数、合计点数与金额（0.01 元/点），不含 locator 原文", () => {
    const p = plan();
    const ok = preflight({ plan: p, approval: approvalFor(p), env: ENV_ON, now: NOW });
    expect(ok.preview).toMatchObject({
      entries: [
        { platform: "douyin", action: "media_user_info", mode: "synchronous", points: 10 },
        { platform: "douyin", action: "user_video_list", mode: "synchronous", points: 10 },
      ],
      nominalCalls: 2,
      nominalPoints: 20,
      nominalYuan: 0.2,
      budget: { maxCalls: 2, maxPolls: 0, maxPoints: 20 },
      deadlineMs: 120_000,
    });
    expect(JSON.stringify(ok.preview)).not.toContain("MPOAlEqWpec");
    expect(ok.approvedBy).toBe("liuxuekui");
  });

  it("小红书点数 15/15：主页 + 列表 = 30 点 = 0.6 元", () => {
    const p = plan({
      allowlist: [
        { platform: "xiaohongshu", action: "media_user_info", mode: "synchronous", locator: "https://xhslink.cn/o/E2W9yK1ctR" },
        { platform: "xiaohongshu", action: "user_video_list", mode: "synchronous", locator: "https://xhslink.cn/o/E2W9yK1ctR" },
      ],
      budget: { max_calls: 2, max_polls: 0, max_points: 30 },
    });
    const ok = preflight({ plan: p, approval: approvalFor(p), env: ENV_ON, now: NOW });
    expect([ok.preview.nominalPoints, ok.preview.nominalYuan]).toEqual([30, 0.3]);
  });

  it("异步主页是独立的一条 allowlist：提交计点，轮询不计点但受 max_polls 约束", () => {
    const p = plan({
      allowlist: [{ platform: "douyin", action: "media_user_info", mode: "asynchronous", locator: LOCATOR }],
      budget: { max_calls: 1, max_polls: 5, max_points: 10 },
    });
    const ok = preflight({ plan: p, approval: approvalFor(p), env: ENV_ON, now: NOW });
    expect(ok.preview).toMatchObject({ nominalCalls: 1, nominalPoints: 10, budget: { maxPolls: 5 } });
  });
});

describe("preflight：每一条门槛都在网络与 secret 之前拒绝，且码稳定", () => {
  const p = plan();
  const good = { plan: p, approval: approvalFor(p), env: ENV_ON, now: NOW };

  it("运行期开关缺失 / 不是约定值", () => {
    expect(refusal({ ...good, env: {} })).toBe("switch_off");
    expect(refusal({ ...good, env: { [SMOKE_SWITCH_ENV]: "1" } })).toBe("switch_off");
    expect(refusal({ ...good, env: { [SMOKE_SWITCH_ENV]: "true" } })).toBe("switch_off");
  });

  it("没有审批记录 / 审批记录不合法 / 缺批准人", () => {
    expect(refusal({ ...good, approval: null })).toBe("approval_missing");
    expect(refusal({ ...good, approval: {} })).toBe("approval_invalid");
    expect(refusal({ ...good, approval: approvalFor(p, { approved_by: "" }) })).toBe("approval_invalid");
    expect(refusal({ ...good, approval: approvalFor(p, { reason: "" }) })).toBe("approval_invalid");
    expect(refusal({ ...good, approval: { ...approvalFor(p), extra: 1 } })).toBe("approval_invalid");
  });

  it("审批已过期 / 批准时间在未来 / 有效期超过 24 小时", () => {
    expect(refusal({ ...good, approval: approvalFor(p, { expires_at: "2026-11-04T11:59:59.000Z" }) })).toBe("approval_expired");
    expect(refusal({ ...good, approval: approvalFor(p, { approved_at: "2026-11-04T12:30:00.000Z", expires_at: "2026-11-04T13:00:00.000Z" }) })).toBe("approval_not_yet_valid");
    expect(refusal({ ...good, approval: approvalFor(p, { approved_at: "2026-11-02T00:00:00.000Z", expires_at: "2026-11-05T00:00:00.000Z" }) })).toBe("approval_window_too_long");
  });

  it("审批绑定到具体计划：改任何一处（locator、预算、allowlist）审批都作废", () => {
    const approval = approvalFor(p);
    expect(refusal({ ...good, plan: plan({ budget: { max_calls: 3, max_polls: 0, max_points: 20 } }), approval })).toBe("approval_plan_mismatch");
    expect(refusal({ ...good, plan: plan({ deadline_ms: 120_001 }), approval })).toBe("approval_plan_mismatch");
    expect(
      refusal({ ...good, plan: plan({ allowlist: [{ platform: "douyin", action: "media_user_info", mode: "synchronous", locator: `${LOCATOR}x` }] }), approval }),
    ).toBe("approval_plan_mismatch");
  });

  it("计划本身不合法（未知字段、缺字段、类型错）", () => {
    for (const bad of [{}, { ...plan(), extra: true }, plan({ budget: undefined }), plan({ deadline_ms: "120000" }), "plan"]) {
      expect(refusal({ plan: bad, approval: approvalFor(bad), env: ENV_ON, now: NOW })).toBe("plan_invalid");
    }
  });

  it("allowlist：空、未登记的 platform / action / mode、已知供应商失败的 tuple（异步列表）、重复项、非法环境", () => {
    const check = (allowlist: unknown[], code: SmokeRefusalCode) => {
      const q = plan({ allowlist });
      expect(refusal({ plan: q, approval: approvalFor(q), env: ENV_ON, now: NOW })).toBe(code);
    };
    check([], "plan_invalid");
    check([{ platform: "kuaishou", action: "media_user_info", mode: "synchronous", locator: LOCATOR }], "plan_invalid");
    check([{ platform: "douyin", action: "media_stats_number", mode: "synchronous", locator: LOCATOR }], "plan_invalid");
    check([{ platform: "douyin", action: "user_video_list", mode: "asynchronous", locator: LOCATOR }], "allowlist_tuple_unavailable");
    check([{ platform: "xiaohongshu", action: "user_video_list", mode: "asynchronous", locator: LOCATOR }], "allowlist_tuple_unavailable");
    check(
      [
        { platform: "douyin", action: "media_user_info", mode: "synchronous", locator: LOCATOR },
        { platform: "douyin", action: "media_user_info", mode: "synchronous", locator: LOCATOR },
      ],
      "allowlist_duplicate",
    );
    const q = plan({ environment: "test" });
    expect(refusal({ plan: q, approval: approvalFor(q), env: ENV_ON, now: NOW })).toBe("plan_invalid");
  });

  it("预算：缺失 / 零 / 无穷 / 负数 / 超过硬上限 / 比名义用量还小", () => {
    const check = (budget: unknown, code: SmokeRefusalCode) => {
      const q = plan({ budget });
      expect(refusal({ plan: q, approval: approvalFor(q), env: ENV_ON, now: NOW })).toBe(code);
    };
    check({ max_calls: 0, max_polls: 0, max_points: 20 }, "plan_invalid");
    check({ max_calls: 2, max_polls: 0, max_points: 0 }, "plan_invalid");
    check({ max_calls: 2, max_polls: 0, max_points: Infinity }, "plan_invalid");
    check({ max_calls: -1, max_polls: 0, max_points: 20 }, "plan_invalid");
    check({ max_calls: 2, max_polls: 0 }, "plan_invalid");
    check({ max_calls: 51, max_polls: 0, max_points: 20 }, "plan_invalid");
    check({ max_calls: 2, max_polls: 0, max_points: 19 }, "budget_too_small"); // 抖音 10 + 10
    check({ max_calls: 1, max_polls: 0, max_points: 20 }, "budget_too_small"); // 名义 2 次调用
  });

  it("deadline：缺失 / 太短 / 超过 1 小时", () => {
    for (const d of [undefined, 0, 999, 3_600_001]) {
      const q = plan({ deadline_ms: d });
      expect(refusal({ plan: q, approval: approvalFor(q), env: ENV_ON, now: NOW })).toBe("plan_invalid");
    }
  });

  it("门槛检查顺序固定：开关最先，其次审批，再计划（便于定位）", () => {
    expect(refusal({ plan: {}, approval: null, env: {}, now: NOW })).toBe("switch_off");
    expect(refusal({ plan: {}, approval: null, env: ENV_ON, now: NOW })).toBe("approval_missing");
    expect(refusal({ plan: {}, approval: approvalFor({}), env: ENV_ON, now: NOW })).toBe("plan_invalid");
  });

  it("拒绝信息不回显 locator 原文或审批细节", () => {
    try {
      preflight({ ...good, env: {} });
    } catch (e) {
      expect((e as Error).message).not.toContain("MPOAlEqWpec");
    }
  });
});
