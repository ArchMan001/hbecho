import { describe, expect, it } from "vitest";
import type { ConditionDesc } from "../../config";
import { abilityOutcomes, stateOf, type AbilityRow } from "./ability";
import { contentOutcome, type ZeroContext } from "./aggregate";

const ZERO_OK: ZeroContext = { syncComplete: true, syncReason: null };
const ZERO_GAP: ZeroContext = { syncComplete: false, syncReason: "sync_gap" };
const L1_TEXT: ConditionDesc = { key: "l1.0", layer: 1, kind: "text", target: null, subject: "content", alias: null };
const L1_TAG: ConditionDesc = { key: "l1.1", layer: 1, kind: "hashtags", target: null, subject: "content", alias: null };
const COVER: ConditionDesc = { key: "l2.a1", layer: 2, kind: "whole_image", target: "cover", subject: "content", alias: null };
const AVATAR: ConditionDesc = { key: "l2.a2", layer: 2, kind: "whole_image", target: "avatar", subject: "account", alias: null };
const ASR: ConditionDesc = { key: "l3", layer: 3, kind: "asr", target: null, subject: "content", alias: null };
const COMMENT: ConditionDesc = { key: "comment", layer: "comment", kind: "comment", target: null, subject: "content", alias: null };

type S = "pass" | "fail" | "unobtained";
/** 造一条内容行：l1 是 [文本, 话题] 的状态；l2 / l3 缺省 = 没走到。 */
const row = (final: AbilityRow["final"], o: { l1?: [S, S]; l2?: S; l3?: S } = {}): AbilityRow => ({
  final,
  evidence: {
    ...(o.l1 ? { l1: [{ idx: 0, state: o.l1[0] }, { idx: 1, state: o.l1[1] }] } : {}),
    ...(o.l2 ? { l2: { abilities: [{ id: "a1", state: o.l2 }] } } : {}),
    ...(o.l3 ? { l3: { state: o.l3 } } : {}),
  },
});
const run = (rows: AbilityRow[], over: Partial<Parameters<typeof abilityOutcomes>[0]> = {}) =>
  Object.fromEntries(abilityOutcomes({ conditions: [L1_TEXT, L1_TAG, COVER, ASR], rows, n: 2, zero: ZERO_OK, accountDetail: null, commentResult: null, ...over }).map((r) => [r.key, r]));

describe("stateOf：按稳定 key 取条件状态", () => {
  it("l1.<idx> 对 evidence.l1[].idx；l2.<id> 对 abilities[].id；l3 取 evidence.l3", () => {
    const r = row("pass", { l1: ["pass", "fail"], l2: "pass", l3: "unobtained" });
    expect(stateOf(L1_TEXT, r)).toBe("pass");
    expect(stateOf(L1_TAG, r)).toBe("fail");
    expect(stateOf(COVER, r)).toBe("pass");
    expect(stateOf(ASR, r)).toBe("unobtained");
  });
  it("没有证据 → undefined（没评估到），不是 fail", () => {
    expect(stateOf(COVER, row("skipped", { l1: ["pass", "pass"] }))).toBeUndefined();
    expect(stateOf(L1_TEXT, { final: "unobtained", evidence: null })).toBeUndefined();
  });
});

describe("第 1 层条件：评估集是全部行，规则 = at_least_n N + 零内容规则", () => {
  it("N=2：文本通过 2 条 → 成功；1 条 → 不达标（没有未获取成功可补）", () => {
    expect(run([row("pass", { l1: ["pass", "pass"] }), row("fail", { l1: ["pass", "fail"] })])["l1.0"]!.result).toBe("success");
    expect(run([row("fail", { l1: ["pass", "fail"] }), row("fail", { l1: ["fail", "fail"] })])["l1.0"]!.result).toBe("not_met");
  });
  it("1 条通过 + 1 条未获取成功、N=2 → 未获取成功（P + U ≥ N）", () => {
    expect(run([row("pass", { l1: ["pass", "pass"] }), row("unobtained", { l1: ["unobtained", "pass"] })])["l1.0"]!.result).toBe("unobtained");
  });
  it("没评估到、但最终未获取成功的行（如发布时间缺失）计入 U", () => {
    // 1 条文本通过 + 1 条 l0 未获取成功（没有证据）：P=1, U=1, N=2 → 未获取成功，而不是不达标
    expect(run([row("pass", { l1: ["pass", "pass"] }), { final: "unobtained", evidence: null }])["l1.0"]!.result).toBe("unobtained");
  });
  it("被数量要求截掉的行（final = skipped）照常按保留的第 1 层证据计数", () => {
    // N=2：4 条文本都通过，只有前 2 条被选中；文本列按 4 条算 → 成功（不是只算选中的 2 条）
    const rows = [row("pass", { l1: ["pass", "pass"] }), row("pass", { l1: ["pass", "pass"] }), row("skipped", { l1: ["pass", "pass"] }), row("skipped", { l1: ["pass", "pass"] })];
    expect(run(rows, { n: 4 })["l1.0"]!.result).toBe("success");
    // N=6：4 条文本通过 < 6 → 不达标（P + U < N），而选中的行数不影响第 1 层条件的计数口径
    expect(run(rows, { n: 6 })["l1.0"]!.result).toBe("not_met");
  });
  it("被截掉的行有第 1 层证据但没有第 2、3 层证据：第 2、3 层条件不计它们", () => {
    const rows = [row("skipped", { l1: ["pass", "pass"] }), row("skipped", { l1: ["pass", "pass"] })];
    expect(run(rows)["l2.a1"]!.result).toBe("skipped");
    expect(run(rows)["l3"]!.result).toBe("skipped");
  });
  it("零内容账号：同步完整 → 不达标；同步有缺口 → 未获取成功并带同步原因", () => {
    expect(run([])["l1.0"]).toEqual({ key: "l1.0", result: "not_met" });
    expect(run([], { zero: ZERO_GAP })["l1.0"]).toEqual({ key: "l1.0", result: "unobtained", reason: "sync_gap" });
  });
  it("与 contentOutcome 同一个函数：同样的计数得到同样的结果与原因（穷举小范围）", () => {
    for (let p = 0; p <= 3; p++) for (let u = 0; u <= 3; u++) for (let f = 0; f <= 3; f++) for (const n of [1, 2, 3]) {
      const rows: AbilityRow[] = [
        ...Array.from({ length: p }, () => row("pass", { l1: ["pass", "pass"] })),
        ...Array.from({ length: u }, () => row("unobtained", { l1: ["unobtained", "pass"] })),
        ...Array.from({ length: f }, () => row("fail", { l1: ["fail", "pass"] })),
      ];
      const got = run(rows, { n })["l1.0"]!;
      const want = contentOutcome({ p, u, f, skipped: 0, rows: rows.length }, n, ZERO_OK);
      expect({ result: got.result, reason: got.reason }).toEqual({ result: want.result, reason: want.reason });
    }
  });
});

describe("第 2、3 层内容类条件：没有内容走到该层 → skipped（前置条件未满足）", () => {
  it("有内容走到封面：按 at_least_n 判；封面通过 2 条、N=2 → 成功", () => {
    const rows = [row("pass", { l1: ["pass", "pass"], l2: "pass", l3: "pass" }), row("pass", { l1: ["pass", "pass"], l2: "pass", l3: "pass" })];
    const r = run(rows);
    expect([r["l2.a1"]!.result, r["l3"]!.result]).toEqual(["success", "success"]);
  });
  it("封面 1 条不通过 1 条通过、N=2 → 不达标；语音只有 1 条走到、通过、N=2 → 不达标（条数没到）", () => {
    const rows = [row("pass", { l1: ["pass", "pass"], l2: "pass", l3: "pass" }), row("fail", { l1: ["pass", "pass"], l2: "fail" })];
    const r = run(rows);
    expect(r["l2.a1"]!.result).toBe("not_met");
    expect(r["l3"]!.result).toBe("not_met");
  });
  it("更早层未获取成功的行（final = unobtained，没有该层证据）计入 U：不会被判成不达标", () => {
    const rows = [row("pass", { l1: ["pass", "pass"], l2: "pass" }), row("unobtained", { l1: ["unobtained", "pass"] })];
    expect(run(rows)["l2.a1"]!.result).toBe("unobtained"); // P=1, U=1, N=2
  });
  it("所有行都在第 1 层被挡住（fail）→ 第 2、3 层都是 skipped，第 1 层条件正常出结果", () => {
    const rows = [row("fail", { l1: ["fail", "pass"] }), row("fail", { l1: ["pass", "fail"] })];
    const r = run(rows);
    expect([r["l2.a1"]!.result, r["l3"]!.result]).toEqual(["skipped", "skipped"]);
    expect(r["l1.0"]!.result).toBe("not_met");
  });
  it("零内容账号：第 2、3 层是 skipped，不走零内容规则", () => {
    const r = run([], { zero: ZERO_GAP });
    expect([r["l2.a1"]!.result, r["l3"]!.result]).toEqual(["skipped", "skipped"]);
  });
});

describe("账号类条件（头像 / 主页背景）与评论", () => {
  const cond = [AVATAR, COMMENT];
  it("取 account_detail.abilities 里同 id 的状态：pass → 成功、fail → 不达标、unobtained → 未获取成功并带原因", () => {
    const go = (state: string, reason?: string) => abilityOutcomes({ conditions: cond, rows: [], n: 1, zero: ZERO_OK, accountDetail: { result: "x", abilities: [{ id: "a2", state, ...(reason ? { reason } : {}) }] }, commentResult: null })[0]!;
    expect(go("pass").result).toBe("success");
    expect(go("fail").result).toBe("not_met");
    expect(go("unobtained", "image_unreadable")).toEqual({ key: "l2.a2", result: "unobtained", reason: "image_unreadable" });
  });
  it("账号要求整体未获取成功（没有主页快照，abilities 为空）→ 每个账号条件沿用整体结果与原因", () => {
    const r = abilityOutcomes({ conditions: [AVATAR], rows: [], n: 1, zero: ZERO_OK, accountDetail: { result: "unobtained", reason: "no_profile_snapshot", abilities: [] }, commentResult: null });
    expect(r).toEqual([{ key: "l2.a2", result: "unobtained", reason: "no_profile_snapshot" }]);
  });
  it("account_detail 为空（还没算 / 没启用）→ 不写该条；评论取 comment_result，未配置则不写", () => {
    expect(abilityOutcomes({ conditions: [AVATAR], rows: [], n: 1, zero: ZERO_OK, accountDetail: null, commentResult: null })).toEqual([]);
    expect(abilityOutcomes({ conditions: [COMMENT], rows: [], n: 1, zero: ZERO_OK, accountDetail: null, commentResult: "not_met" })).toEqual([{ key: "comment", result: "not_met" }]);
    expect(abilityOutcomes({ conditions: [COMMENT], rows: [], n: 1, zero: ZERO_OK, accountDetail: null, commentResult: null })).toEqual([]);
  });
  it("账号类条件不会出现 skipped", () => {
    for (const state of ["pass", "fail", "unobtained"]) {
      const r = abilityOutcomes({ conditions: [AVATAR], rows: [], n: 1, zero: ZERO_OK, accountDetail: { abilities: [{ id: "a2", state }] }, commentResult: null });
      expect(r[0]!.result).not.toBe("skipped");
    }
  });
});

describe("各能力都成功、整体仍可能不达标（N=1，不同内容各过一项）", () => {
  it("文本由内容 A 通过、话题由内容 B 通过、没有一条两者都过：第 1 层各条件成功，第 2、3 层 skipped", () => {
    const rows = [row("fail", { l1: ["pass", "fail"] }), row("fail", { l1: ["fail", "pass"] })];
    const r = run(rows, { n: 1 });
    expect([r["l1.0"]!.result, r["l1.1"]!.result, r["l2.a1"]!.result]).toEqual(["success", "success", "skipped"]);
  });
});
