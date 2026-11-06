import { describe, expect, it } from "vitest";
import { loadManifest } from "../../../tests/harness/fixtures";
import {
  CAPABILITY_PROFILES,
  UnsupportedCapabilityError,
  capabilityGate,
  createCapabilityGate,
  type CapabilityKey,
  type CapabilityProfile,
} from "./capability";

const PLATFORMS = ["douyin", "xiaohongshu"] as const;
const ACTIONS = ["media_user_info", "user_video_list"] as const;
const MODES = ["synchronous", "asynchronous"] as const;

const reasonOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof UnsupportedCapabilityError) return e.reason;
    throw e;
  }
  return null;
};

describe("默认 capability 表（R13.7：按 raw4/raw5/raw8 固化）", () => {
  it("production 环境：抖音 / 小红书 × 主页 / 列表 的 8 个 tuple 全部拒绝（R13.5/R13.6）", () => {
    for (const platform of PLATFORMS)
      for (const action of ACTIONS)
        for (const mode of MODES) {
          const isAsyncList = action === "user_video_list" && mode === "asynchronous";
          expect(reasonOf(() => capabilityGate.require({ platform, action, mode, environment: "production" }))).toBe(
            isAsyncList ? "provider_failed" : "disabled",
          );
        }
    expect(CAPABILITY_PROFILES.filter((p) => p.environment === "production").every((p) => p.activation === "disabled")).toBe(true);
  });

  it("test 环境：同步主页/列表、异步主页可用", () => {
    for (const platform of PLATFORMS) {
      for (const [action, mode] of [
        ["media_user_info", "synchronous"],
        ["user_video_list", "synchronous"],
        ["media_user_info", "asynchronous"],
      ] as const) {
        const p = capabilityGate.require({ platform, action, mode, environment: "test" });
        expect(p.evidenceLevel).toBe("smoke_verified");
        expect(p.observedOutcome).toBe("succeeded");
      }
    }
  });

  it("异步列表在两个平台的所有环境都被拒绝，原因是 provider_failed（G1）", () => {
    for (const platform of PLATFORMS)
      for (const environment of ["test", "production"] as const)
        expect(
          reasonOf(() =>
            capabilityGate.require({ platform, action: "user_video_list", mode: "asynchronous", environment }),
          ),
        ).toBe("provider_failed");
  });

  it("未注册的 platform / action / mode / environment 立即失败，且不会回退到近似项", () => {
    const bad = (k: Record<string, string>) => reasonOf(() => capabilityGate.require(k as unknown as CapabilityKey));
    expect(bad({ platform: "kuaishou", action: "post_comments_list", mode: "synchronous", environment: "test" })).toBe("unregistered");
    expect(bad({ platform: "kuaishou", action: "post_comments_list", mode: "asynchronous", environment: "production" })).toBe("unregistered");
    expect(bad({ platform: "douyin", action: "media_comments", mode: "synchronous", environment: "test" })).toBe("unregistered");
    expect(bad({ platform: "douyin", action: "media_user_info", mode: "batch", environment: "test" })).toBe("unregistered");
    expect(bad({ platform: "douyin", action: "media_user_info", mode: "synchronous", environment: "staging" })).toBe("unregistered");
  });

  it("每个 tuple 的证据引用都指向 manifest，且与文件里的实际观察一致", () => {
    const byId = new Map(loadManifest().entries.map((e) => [e.id, e]));
    for (const p of CAPABILITY_PROFILES) {
      expect(p.evidenceRef.length).toBeGreaterThan(0);
      for (const ref of p.evidenceRef) {
        const e = byId.get(ref);
        expect(e, `${ref} 不在 manifest`).toBeDefined();
        expect([e!.platform, e!.action, e!.mode]).toEqual([
          p.platform,
          p.action,
          p.mode === "synchronous" ? "sync" : "async",
        ]);
        if (p.observedOutcome === "provider_failed") {
          expect(e!.evidenceLabel).toBe("provider_failed");
          expect(e!.observed.taskStatus).toBe("failed");
        } else {
          expect(e!.evidenceLabel).toBe("smoke_verified");
          expect(["succeeded", "running"]).toContain(e!.observed.taskStatus);
        }
      }
    }
  });

  it("test 与 production 对同一 tuple 引用相同证据，每个已登记 tuple 在两个环境各一条", () => {
    const tuples = new Set(CAPABILITY_PROFILES.map((p) => `${p.platform}/${p.action}/${p.mode}`));
    for (const key of tuples) {
      const rows = CAPABILITY_PROFILES.filter((p) => `${p.platform}/${p.action}/${p.mode}` === key);
      expect(rows.map((r) => r.environment).sort(), key).toEqual(["production", "test"]);
      expect(rows[0]!.evidenceRef, key).toEqual(rows[1]!.evidenceRef);
    }
  });

  it("已知缺口显式记入证据：非主页链接的供应商响应未观察到；认证头文档与实测矛盾（R13.8）", () => {
    const profile = CAPABILITY_PROFILES.filter((p) => p.action === "media_user_info");
    expect(profile.every((p) => p.knownGaps.includes("non_home_locator_response_unobserved"))).toBe(true);
    expect(profile.every((p) => p.knownGaps.includes("response_platform_unobservable"))).toBe(true);
    expect(CAPABILITY_PROFILES.every((p) => p.knownGaps.includes("auth_header_doc_contradiction"))).toBe(true);
  });
});

// requirements FS-16.1 逐行：platform × action × mode → 结果。production 一律 disabled / provider_failed，没有任何放行。
describe("a-full-sync 扩展后的 capability 表（FS-16.1、FS-7.1、FS-7.7）", () => {
  type Expect = "approved" | "provider_failed" | "disabled" | "unregistered";
  const table: Array<[string, string, string, Expect]> = [
    // 快手主页 / 列表 / 详情 同步；主页 / 详情 异步；列表异步 provider-failed
    ["kuaishou", "media_user_info", "synchronous", "approved"],
    ["kuaishou", "user_video_list", "synchronous", "approved"],
    ["kuaishou", "media_user_info", "asynchronous", "approved"],
    ["kuaishou", "user_video_list", "asynchronous", "provider_failed"],
    // 快手详情：同步已由 2026-11-06 真实 smoke 验证内容 URL 构造；异步未用规范 URL 验证，保持 disabled
    ["kuaishou", "media_stats_number", "synchronous", "approved"],
    ["kuaishou", "media_stats_number", "asynchronous", "approved"],
    // 快手评论不登记（D-51）
    ["kuaishou", "post_comments_list", "synchronous", "unregistered"],
    ["kuaishou", "post_comments_list", "asynchronous", "unregistered"],
    // 抖音 / 小红书详情同步与异步
    ["douyin", "media_stats_number", "synchronous", "approved"],
    ["douyin", "media_stats_number", "asynchronous", "approved"],
    ["xiaohongshu", "media_stats_number", "synchronous", "approved"],
    ["xiaohongshu", "media_stats_number", "asynchronous", "approved"],
    // 评论：抖音异步 provider-failed；小红书异步可用
    ["douyin", "post_comments_list", "synchronous", "approved"],
    ["douyin", "post_comments_list", "asynchronous", "provider_failed"],
    ["xiaohongshu", "post_comments_list", "synchronous", "approved"],
    ["xiaohongshu", "post_comments_list", "asynchronous", "approved"],
  ];
  it.each(table)("test 环境 %s / %s / %s → %s", (platform, action, mode, expected) => {
    const key = { platform, action, mode, environment: "test" } as CapabilityKey;
    const reason = reasonOf(() => capabilityGate.require(key));
    if (expected === "approved") expect(reason).toBeNull();
    else expect(reason).toBe(expected);
  });
  it("production 环境：所有已登记 tuple 都拒绝（disabled 或 provider_failed），FS-16.2", () => {
    for (const [platform, action, mode, expected] of table) {
      const key = { platform, action, mode, environment: "production" } as CapabilityKey;
      const reason = reasonOf(() => capabilityGate.require(key));
      expect(reason, `${platform}/${action}/${mode}`).toBe(expected === "unregistered" ? "unregistered" : expected === "provider_failed" ? "provider_failed" : "disabled");
    }
  });
  it("快手详情：同步、异步都已用规范 URL 经真实 smoke 验证（test 环境放行）", () => {
    const ks = CAPABILITY_PROFILES.filter((p) => p.platform === "kuaishou" && p.action === "media_stats_number");
    expect(ks).toHaveLength(4);
    for (const p of ks) expect(p.knownGaps).not.toContain("content_url_construction_unverified");
    expect(ks.filter((x) => x.environment === "test").every((x) => x.activation === "approved")).toBe(true);
  });
  it("三平台列表异步都是 provider-failed 且 disabled；抖音评论异步同样", () => {
    for (const p of CAPABILITY_PROFILES.filter((x) => x.mode === "asynchronous" && (x.action === "user_video_list" || (x.platform === "douyin" && x.action === "post_comments_list")))) {
      expect(p.observedOutcome).toBe("provider_failed");
      expect(p.activation).toBe("disabled");
    }
  });
});

describe("门控规则（用合成表验证，规则本身与真实表无关）", () => {
  const base: CapabilityProfile = {
    platform: "douyin",
    action: "media_user_info",
    mode: "synchronous",
    requestSchemaVersion: "r1",
    responseSchemaVersion: "s1",
    evidenceLevel: "fixture_observed",
    observedOutcome: "succeeded",
    environment: "production",
    activation: "approved",
    evidenceRef: ["x"],
    knownGaps: [],
  };
  const key: CapabilityKey = { platform: "douyin", action: "media_user_info", mode: "synchronous", environment: "production" };

  it("仅 fixture_observed 不能在 production 激活，即使 activation=approved（G4）", () => {
    expect(reasonOf(() => createCapabilityGate([base]).require(key))).toBe("evidence_insufficient");
  });

  it("supplier_declared / unknown 同样不够", () => {
    for (const evidenceLevel of ["supplier_declared", "unknown"] as const)
      expect(reasonOf(() => createCapabilityGate([{ ...base, evidenceLevel }]).require(key))).toBe("evidence_insufficient");
  });

  it("smoke_verified 但 activation=disabled 仍被拒绝（需要显式批准）", () => {
    expect(
      reasonOf(() => createCapabilityGate([{ ...base, evidenceLevel: "smoke_verified", activation: "disabled" }]).require(key)),
    ).toBe("disabled");
  });

  it("smoke_verified + approved + production 才放行", () => {
    const p = createCapabilityGate([{ ...base, evidenceLevel: "smoke_verified" }]).require(key);
    expect(p.activation).toBe("approved");
  });

  it("test 环境接受 fixture_observed，但不接受 unknown", () => {
    const k = { ...key, environment: "test" } as const;
    expect(createCapabilityGate([{ ...base, environment: "test" }]).require(k).evidenceLevel).toBe("fixture_observed");
    expect(reasonOf(() => createCapabilityGate([{ ...base, environment: "test", evidenceLevel: "unknown" }]).require(k))).toBe(
      "evidence_insufficient",
    );
  });

  it("provider_failed 的 tuple 即使被标 approved 也不放行", () => {
    expect(
      reasonOf(() => createCapabilityGate([{ ...base, evidenceLevel: "smoke_verified", observedOutcome: "provider_failed" }]).require(key)),
    ).toBe("provider_failed");
  });

  it("registry 条目重复（同一 tuple 同一环境）在构造时报错，避免歧义", () => {
    expect(() => createCapabilityGate([base, base])).toThrow();
  });
});
