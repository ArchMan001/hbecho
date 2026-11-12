// composeState 表驱动：design §7.6 的每个分支至少一例。
import { describe, expect, it } from "vitest";
import { requireSignal } from "./catalog";
import { composeState, type ComposeInput, type StoredSignal } from "./compose";

const AT = new Date("2026-11-12T02:00:00.000Z");
const text = requireSignal("text.hashtags");
const cover = requireSignal("content.cover_template_score");
const stored = (over: Partial<StoredSignal> = {}): StoredSignal => ({ state: "valid", capabilityId: "text.hashtags.douyin", version: 1, nv: 1, producedAt: AT, value: ["618"], ...over });
const textIn = (over: Partial<ComposeInput> = {}): ComposeInput => ({ entry: text, platform: "douyin", current: { capabilityId: "text.hashtags.douyin", version: 1, nv: 1 }, enabled: true, stalePolicy: "use_stale", ...over });
const coverIn = (over: Partial<ComposeInput> = {}): ComposeInput => ({ entry: cover, platform: "douyin", current: { capabilityId: "image.template", version: 1 }, enabled: true, stalePolicy: "use_stale", ...over });
const READY = { state: "ready", assetId: 1n, sha256: Buffer.alloc(32, 1) } as const;

describe("composeState：文本类（特征行）", () => {
  it("当前版本的 valid → valid，带值、能力、产出时间、nv", () => {
    expect(composeState(textIn({ stored: stored() }))).toEqual({ state: "valid", usable: true, value: ["618"], evidence: undefined, capability: { id: "text.hashtags.douyin", version: 1 }, producedAt: AT, normalizerVersion: 1 });
  });
  it("话题解析器版本落后 → stale；use_stale 带旧值，as_unknown 不可用且不带值", () => {
    const old = stored({ version: 0 });
    expect(composeState(textIn({ stored: old }))).toMatchObject({ state: "stale", usable: true, value: ["618"] });
    const hidden = composeState(textIn({ stored: old, stalePolicy: "as_unknown" }));
    expect(hidden).toMatchObject({ state: "stale", usable: false, capability: { version: 0 } });
    expect("value" in hidden).toBe(false);
  });
  it("只升 text.normalize、话题解析器版本不变：话题读作 stale，normalizerVersion 为写入时的旧值", () => {
    const v = composeState(textIn({ stored: stored({ nv: 1 }), current: { capabilityId: "text.hashtags.douyin", version: 1, nv: 2 } }));
    expect(v).toMatchObject({ state: "stale", usable: true, normalizerVersion: 1 });
  });
  it("nv 缺失（正常写入不会出现）按 stale 处理", () => {
    expect(composeState(textIn({ stored: stored({ nv: undefined }) })).state).toBe("stale");
  });
  it("当前版本的 failed → failed，带失败码与证据，不是 0 / 空值", () => {
    const v = composeState(textIn({ stored: stored({ state: "failed", value: undefined, failureCode: "text_parse_error", evidence: { detail: "sha256:ab;len=3" } }) }));
    expect(v).toMatchObject({ state: "failed", usable: false, reason: "text_parse_error", evidence: { detail: "sha256:ab;len=3" } });
    expect("value" in v).toBe(false);
  });
  it("最高版本的 failed 是旧版本的 → missing(failed_under_old_version)，不是 failed", () => {
    expect(composeState(textIn({ stored: stored({ state: "failed", version: 0, failureCode: "text_parse_error" }) }))).toMatchObject({ state: "missing", reason: "failed_under_old_version" });
  });
  it("平台没有该字段 → not_applicable(field_absent_on_platform)；平台不在目录里 → platform_unsupported", () => {
    expect(composeState(textIn({ fieldAbsent: true }))).toMatchObject({ state: "not_applicable", reason: "field_absent_on_platform" });
    expect(composeState(textIn({ platform: "weibo", stored: stored() }))).toMatchObject({ state: "not_applicable", reason: "platform_unsupported" });
    expect(composeState({ ...coverIn(), entry: requireSignal("account.bg_template_score"), platform: "kuaishou" })).toMatchObject({ state: "not_applicable", reason: "platform_unsupported" });
  });
  it("没有行：未启用 → capability_disabled；启用 → not_computed", () => {
    expect(composeState(textIn({ enabled: false }))).toMatchObject({ state: "missing", reason: "capability_disabled" });
    expect(composeState(textIn())).toMatchObject({ state: "missing", reason: "not_computed", usable: false });
  });
  it("已存储的值不受启用开关影响：关掉能力后旧值照常读出", () => {
    expect(composeState(textIn({ stored: stored(), enabled: false })).state).toBe("valid");
    expect(composeState(textIn({ stored: stored({ version: 0 }), enabled: false })).state).toBe("stale");
  });
});

describe("composeState：结果行类（素材 → 状态）", () => {
  it("无封面引用 → not_applicable(no_reference)", () => {
    expect(composeState(coverIn({ material: { state: "not_applicable", reason: "no_reference" } }))).toMatchObject({ state: "not_applicable", reason: "no_reference" });
  });
  it("账号尚无当前主页快照 → missing(no_profile_snapshot)，不是 not_applicable", () => {
    expect(composeState(coverIn({ material: { state: "missing", reason: "no_profile_snapshot" } }))).toMatchObject({ state: "missing", reason: "no_profile_snapshot" });
  });
  it("素材 pending / failed / carried_forward / 音频未归档 → missing 且原因码各不相同", () => {
    const reasons = (["media_pending", "media_failed", "media_carried_forward", "audio_not_archived"] as const).map((reason) => composeState(coverIn({ material: { state: "missing", reason } })).reason);
    expect(reasons).toEqual(["media_pending", "media_failed", "media_carried_forward", "audio_not_archived"]);
  });
  it("素材缺口优先于 capability_disabled 与任务提示", () => {
    expect(composeState(coverIn({ material: { state: "missing", reason: "media_pending" }, enabled: false, pending: "dead" })).reason).toBe("media_pending");
  });
  it("素材就绪、没有结果行：未启用 → capability_disabled；排队 / 运行中 → not_computed + pending；dead → compute_dead + pending=dead；否则 not_computed", () => {
    const base = coverIn({ material: READY });
    expect(composeState({ ...base, enabled: false })).toMatchObject({ reason: "capability_disabled" });
    expect(composeState({ ...base, enabled: false, pending: "queued" })).toMatchObject({ reason: "capability_disabled" }); // 未启用时不会有任务；以开关为准
    expect(composeState({ ...base, pending: "queued" })).toMatchObject({ state: "missing", reason: "not_computed", pending: "queued" });
    expect(composeState({ ...base, pending: "running" })).toMatchObject({ reason: "not_computed", pending: "running" });
    expect(composeState({ ...base, pending: "dead" })).toMatchObject({ reason: "compute_dead", pending: "dead" });
    const none = composeState(base);
    expect(none).toMatchObject({ reason: "not_computed" });
    expect("pending" in none).toBe(false);
  });
  it("素材就绪、有结果行：valid 带分数与 resultId；版本落后 → stale；匹配分 0 仍是 valid，不是缺失", () => {
    const row: StoredSignal = { state: "valid", capabilityId: "image.template", version: 1, producedAt: AT, score: 0, evidence: { inliers: 0 }, resultId: 7n };
    expect(composeState(coverIn({ material: READY, stored: row }))).toMatchObject({ state: "valid", usable: true, score: 0, resultId: 7n });
    expect(composeState(coverIn({ material: READY, stored: { ...row, version: 0, score: 6.5 }, stalePolicy: "as_unknown" }))).toMatchObject({ state: "stale", usable: false, resultId: 7n });
  });
  it("非文本类不看 nv", () => {
    const row: StoredSignal = { state: "valid", capabilityId: "image.template", version: 1, nv: 99, producedAt: AT, score: 5 };
    expect(composeState(coverIn({ material: READY, stored: row })).state).toBe("valid");
  });
});
