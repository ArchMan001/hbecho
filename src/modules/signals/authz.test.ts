import { describe, expect, it } from "vitest";
import { CAP_SEGMENT_MANAGE, CAP_SEGMENT_READ, actorFromEnv, assert, type SignalActor } from "./authz";
import { SignalError } from "./errors";

const actor = (over: Partial<SignalActor> = {}): SignalActor => ({ actor: "user:1", capabilities: new Set([CAP_SEGMENT_MANAGE]), brandScope: new Set(["HITACHI"]), ...over });
const code = (f: () => unknown): string | undefined => {
  try {
    f();
  } catch (e) {
    return e instanceof SignalError ? `${e.category}/${e.code}` : String(e);
  }
  return undefined;
};

describe("assert", () => {
  it("无 Capability：forbidden；有则通过", () => {
    expect(code(() => assert(actor({ capabilities: new Set() }), CAP_SEGMENT_MANAGE))).toBe("authorization/forbidden");
    expect(code(() => assert(actor(), CAP_SEGMENT_READ))).toBe("authorization/forbidden"); // 有 manage 不等于有 read
    expect(code(() => assert(actor(), CAP_SEGMENT_MANAGE))).toBeUndefined();
  });
  it("越品牌：默认拒绝，hide 表现为未找到（不泄露存在性）；all 通过", () => {
    expect(code(() => assert(actor(), CAP_SEGMENT_MANAGE, { brandCode: "HISENSE" }))).toBe("authorization/brand_out_of_scope");
    expect(code(() => assert(actor(), CAP_SEGMENT_MANAGE, { brandCode: "HISENSE", outOfScope: "hide" }))).toBe("not_found/not_found");
    expect(code(() => assert(actor(), CAP_SEGMENT_MANAGE, { brandCode: "HITACHI" }))).toBeUndefined();
    expect(code(() => assert(actor({ brandScope: "all" }), CAP_SEGMENT_MANAGE, { brandCode: "HISENSE" }))).toBeUndefined();
  });
  it("Capability 先于范围：无 Capability 时不会因范围信息泄露存在性", () => {
    expect(code(() => assert(actor({ capabilities: new Set() }), CAP_SEGMENT_MANAGE, { brandCode: "HISENSE", outOfScope: "hide" }))).toBe("authorization/forbidden");
  });
});

describe("actorFromEnv", () => {
  const full = { HBECHO_SIG_ACTOR: "service:signals-cli", HBECHO_SIG_CAPABILITIES: "rule.definition.manage, data.content.read", HBECHO_SIG_BRAND_SCOPE: "HITACHI,HISENSE" };
  it("完整声明", () => {
    const a = actorFromEnv(full);
    expect(a.actor).toBe("service:signals-cli");
    expect([...a.capabilities]).toEqual(["rule.definition.manage", "data.content.read"]);
    expect(a.brandScope).toEqual(new Set(["HITACHI", "HISENSE"]));
    expect(actorFromEnv({ ...full, HBECHO_SIG_BRAND_SCOPE: "all" }).brandScope).toBe("all");
  });
  for (const [key, expected] of [
    ["HBECHO_SIG_ACTOR", "actor_missing"],
    ["HBECHO_SIG_CAPABILITIES", "capabilities_missing"],
    ["HBECHO_SIG_BRAND_SCOPE", "brand_scope_missing"],
  ] as const) {
    it(`缺 ${key} 启动失败，不退化成全部范围`, () => {
      const env: Record<string, string | undefined> = { ...full };
      delete env[key];
      expect(code(() => actorFromEnv(env))).toBe(`configuration/${expected}`);
      expect(code(() => actorFromEnv({ ...env, [key]: "  " }))).toBe(`configuration/${expected}`);
    });
  }
});
