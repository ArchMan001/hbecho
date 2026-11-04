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
  it("production 环境 8 个 tuple 全部拒绝：没有任何 production activation（R13.5/R13.6）", () => {
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
    expect(bad({ platform: "kuaishou", action: "media_user_info", mode: "synchronous", environment: "test" })).toBe("unregistered");
    expect(bad({ platform: "douyin", action: "media_stats_number", mode: "synchronous", environment: "test" })).toBe("unregistered");
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

  it("test 与 production 对同一 tuple 引用相同证据，8 个 tuple 在两个环境各一条", () => {
    for (const platform of PLATFORMS)
      for (const action of ACTIONS)
        for (const mode of MODES) {
          const rows = CAPABILITY_PROFILES.filter((p) => p.platform === platform && p.action === action && p.mode === mode);
          expect(rows.map((r) => r.environment).sort()).toEqual(["production", "test"]);
          expect(rows[0]!.evidenceRef).toEqual(rows[1]!.evidenceRef);
        }
  });

  it("已知缺口显式记入证据：非主页链接的供应商响应未观察到；认证头文档与实测矛盾（R13.8）", () => {
    const profile = CAPABILITY_PROFILES.filter((p) => p.action === "media_user_info");
    expect(profile.every((p) => p.knownGaps.includes("non_home_locator_response_unobserved"))).toBe(true);
    expect(CAPABILITY_PROFILES.every((p) => p.knownGaps.includes("auth_header_doc_contradiction"))).toBe(true);
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
