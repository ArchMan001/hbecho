import { describe, expect, it } from "vitest";
import { decodedData } from "../../../tests/harness/decode-helpers";
import { loadFixtureBytes } from "../../../tests/harness/fixtures";
import { decodeVideoList } from "../provider-adapter";
import { XHS_DOMINANT_AUTHOR_V1, decideDominantAuthor } from "./dominant-author";

const rep = (id: string | null, n: number) => Array<string | null>(n).fill(id);

describe("xhs-dominant-author.v1 策略定义", () => {
  it("版本名以 v2 §5.5 向量 2 为准，阈值 80%、候选最少 3 条，对象冻结（改阈值必须升版本）", () => {
    expect(XHS_DOMINANT_AUTHOR_V1).toEqual({
      version: "xhs-dominant-author.v1",
      thresholdPercent: 80,
      minCandidateCount: 3,
    });
    expect(Object.isFrozen(XHS_DOMINANT_AUTHOR_V1)).toBe(true);
  });
});

describe("decideDominantAuthor（R6.1/R6.2/R6.5/R6.6）", () => {
  const decide = (authors: Array<string | null>) => decideDominantAuthor(authors, XHS_DOMINANT_AUTHOR_V1);

  it("21/21 同一作者 → accepted，证据含精确计数与分母", () => {
    expect(decide(rep("5decba2300000000010007e1", 21))).toEqual({
      policyVersion: "xhs-dominant-author.v1",
      decision: "accepted",
      reason: "unique_highest_and_policy_passed",
      candidate: { value: "5decba2300000000010007e1", count: 21 },
      totalEntryCount: 21,
      nonEmptyAuthorEntryCount: 21,
      emptyAuthorEntryCount: 0,
      authorCounts: [{ identifier: "5decba2300000000010007e1", count: 21 }],
    });
  });

  it("恰好 80% 通过（≥ 含边界）：4/5", () => {
    const d = decide([...rep("A", 4), ...rep("B", 1)]);
    expect(d.decision).toBe("accepted");
    expect(d.candidate).toEqual({ value: "A", count: 4 });
  });

  it("唯一最高但低于 80% → rejected / below_threshold，且不给出候选", () => {
    const d = decide([...rep("A", 7), ...rep("B", 2)]); // 7/9 = 77.8%
    expect(d).toMatchObject({ decision: "rejected", reason: "below_threshold", candidate: null });
    expect(d.authorCounts).toEqual([
      { identifier: "A", count: 7 },
      { identifier: "B", count: 2 },
    ]);
  });

  it("并列最高 → rejected / tie_for_highest（即使占比 100%）", () => {
    const d = decide([...rep("A", 5), ...rep("B", 5)]);
    expect(d).toMatchObject({ decision: "rejected", reason: "tie_for_highest", candidate: null });
  });

  it("没有任何非空作者 → rejected / no_non_empty_author；null、空串、纯空白都算空", () => {
    const d = decide([null, "", "  ", null]);
    expect(d).toMatchObject({
      decision: "rejected",
      reason: "no_non_empty_author",
      totalEntryCount: 4,
      nonEmptyAuthorEntryCount: 0,
      emptyAuthorEntryCount: 4,
      authorCounts: [],
    });
    expect(decide([])).toMatchObject({ decision: "rejected", reason: "no_non_empty_author", totalEntryCount: 0 });
  });

  it("分母是非空作者条目（与 v2 evidence 的 non_empty_author_entry_count 一致），空作者单独计数", () => {
    const d = decide([...rep("A", 8), ...rep(null, 2)]);
    expect(d).toMatchObject({ decision: "accepted", totalEntryCount: 10, nonEmptyAuthorEntryCount: 8, emptyAuthorEntryCount: 2 });
  });

  it("最小样本：候选作者至少出现 3 次；1 条非空 + 20 条空 → 拒绝 insufficient_samples", () => {
    const d = decide([...rep("A", 1), ...rep(null, 20)]);
    expect(d).toMatchObject({
      decision: "rejected",
      reason: "insufficient_samples",
      candidate: null,
      totalEntryCount: 21,
      nonEmptyAuthorEntryCount: 1,
      emptyAuthorEntryCount: 20,
    });
  });

  it("3 条同一作者 + 18 条空 → 绑定（恰好达到下限）", () => {
    expect(decide([...rep("A", 3), ...rep(null, 18)])).toMatchObject({
      decision: "accepted",
      candidate: { value: "A", count: 3 },
    });
  });

  it("2 条同一作者（占比 100%）仍不足下限；样本不足先于占比判断", () => {
    expect(decide([...rep("A", 2)]).reason).toBe("insufficient_samples");
    expect(decide([...rep("A", 2), ...rep("B", 1)]).reason).toBe("insufficient_samples");
  });

  it("并列最高仍优先报 tie_for_highest（即使两者都不足下限）", () => {
    expect(decide([...rep("A", 1), ...rep("B", 1)]).reason).toBe("tie_for_highest");
  });

  it("下限是策略参数：minCandidateCount 非法时抛出", () => {
    for (const bad of [0, -1, 1.5]) {
      expect(() =>
        decideDominantAuthor(["A"], Object.freeze({ version: "x", thresholdPercent: 80, minCandidateCount: bad })),
      ).toThrow(RangeError);
    }
  });

  it("按 exact 文本计数：大小写、前导零都是不同作者；不做 trim 之外的归一", () => {
    const d = decide([...rep("abc", 3), ...rep("ABC", 3), ...rep("007", 1), ...rep("7", 1)]);
    expect(d.reason).toBe("tie_for_highest");
    expect(d.authorCounts.map((c) => c.identifier)).toEqual(["007", "7", "ABC", "abc"]);
  });

  it("author_counts 按 identifier 的 UTF-8 字节序排序，计数之和 = 非空条目数（v2 §8.2）", () => {
    const d = decide([...rep("b", 1), ...rep("a", 8), ...rep("é", 1)]);
    expect(d.authorCounts.map((c) => c.identifier)).toEqual(["a", "b", "é"]);
    expect(d.authorCounts.reduce((n, c) => n + c.count, 0)).toBe(d.nonEmptyAuthorEntryCount);
    expect(d.totalEntryCount).toBe(d.nonEmptyAuthorEntryCount + d.emptyAuthorEntryCount);
  });

  it("阈值是策略参数：同一分布在更严格的策略下被拒绝", () => {
    const strict = Object.freeze({
      version: "xhs-dominant-author.v2-test",
      thresholdPercent: 95,
      minCandidateCount: 3,
    });
    expect(decideDominantAuthor([...rep("A", 9), ...rep("B", 1)], strict)).toMatchObject({
      policyVersion: "xhs-dominant-author.v2-test",
      reason: "below_threshold",
    });
  });
});

describe("与 fixture 联用", () => {
  const authorsOf = (id: string, platform: "douyin" | "xiaohongshu") =>
    decodedData(decodeVideoList(platform, loadFixtureBytes(id))).entries.map((e) =>
      e.author.id.state === "value" ? e.author.id.value : null,
    );

  it("小红书 21 条日立 fixture：主导作者 5decba2300000000010007e1 通过（R6.4）", () => {
    const d = decideDominantAuthor(authorsOf("raw3.xiaohongshu.user_video_list", "xiaohongshu"), XHS_DOMINANT_AUTHOR_V1);
    expect(d).toMatchObject({
      decision: "accepted",
      candidate: { value: "5decba2300000000010007e1", count: 21 },
      totalEntryCount: 21,
    });
  });

  it("在小红书 21 条上注入负例：唯一但 <80%（4 条换作者）仍以 17/21=81% 通过；换 5 条则 16/21=76% 被拒绝", () => {
    const base = authorsOf("raw3.xiaohongshu.user_video_list", "xiaohongshu");
    const swap = (n: number) => base.map((a, i) => (i < n ? `other-${i}` : a));
    expect(decideDominantAuthor(swap(4), XHS_DOMINANT_AUTHOR_V1).decision).toBe("accepted");
    expect(decideDominantAuthor(swap(5), XHS_DOMINANT_AUTHOR_V1)).toMatchObject({
      decision: "rejected",
      reason: "below_threshold",
    });
  });

  it("抖音 20 条：19 条 HITACHI1 + 1 条 HITACHI2023 → 19/20=95% 通过（该策略只用于小红书，这里仅验证异作者计数）", () => {
    const d = decideDominantAuthor(authorsOf("raw3.douyin.user_video_list", "douyin"), XHS_DOMINANT_AUTHOR_V1);
    expect(d.authorCounts).toEqual([
      { identifier: "HITACHI1", count: 19 },
      { identifier: "HITACHI2023", count: 1 },
    ]);
  });
});
