import { describe, expect, it } from "vitest";
import { decodedData } from "../../../tests/harness/decode-helpers";
import { loadFixtureBytes } from "../../../tests/harness/fixtures";
import { decodeVideoList } from "../provider-adapter";
import { XHS_DOMINANT_AUTHOR_V1, decideDominantAuthor } from "./dominant-author";
import { EvidenceError, buildEvidence, evidenceDigestHex, parseEvidence } from "./evidence";

const VECTOR_2_HEX = "2ecbbeebd4d015bb5685d288c0230ab92646f1d0cba08a0937b2a5def673b36d";
const NS = "xiaohongshu.content.user_id" as const;

const accepted = () => ({
  schema_version: "dominant-list-author-evidence.v1",
  decision: "accepted",
  reason: "unique_highest_and_policy_passed",
  policy_version: "xhs-dominant-author.v1",
  evidence_batch_id: "42",
  candidate_identifier: { namespace: NS, value: "5decba2300000000010007e1", count: 21 },
  total_entry_count: 21,
  non_empty_author_entry_count: 21,
  empty_author_entry_count: 0,
  author_counts: [{ identifier: "5decba2300000000010007e1", count: 21 }],
});

describe("由决定生成 evidence（v2 §8.2、§5.5 向量 2）", () => {
  it("小红书 21 条 fixture → 决定 → evidence，摘要等于文档指定的向量 2", () => {
    const authors = decodedData(decodeVideoList("xiaohongshu", loadFixtureBytes("raw3.xiaohongshu.user_video_list"))).entries.map((e) =>
      e.author.id.state === "value" ? e.author.id.value : null,
    );
    const decision = decideDominantAuthor(authors, XHS_DOMINANT_AUTHOR_V1);
    const evidence = buildEvidence(decision, { batchId: 42n, namespace: NS });
    expect(evidence).toEqual(accepted());
    expect(evidenceDigestHex(evidence)).toBe(VECTOR_2_HEX);
  });

  it("拒绝决定同样生成 evidence：candidate 显式为 null，仍保留精确计数与分母", () => {
    const decision = decideDominantAuthor(["A", "A", "B", "B"], XHS_DOMINANT_AUTHOR_V1);
    const evidence = buildEvidence(decision, { batchId: 7n, namespace: NS });
    expect(evidence).toMatchObject({
      decision: "rejected",
      reason: "tie_for_highest",
      candidate_identifier: null,
      total_entry_count: 4,
      non_empty_author_entry_count: 4,
      empty_author_entry_count: 0,
      author_counts: [
        { identifier: "A", count: 2 },
        { identifier: "B", count: 2 },
      ],
    });
    expect(evidenceDigestHex(evidence)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("样本不足的拒绝同样可生成 evidence", () => {
    const decision = decideDominantAuthor(["A", null, null], XHS_DOMINANT_AUTHOR_V1);
    expect(buildEvidence(decision, { batchId: 1n, namespace: NS })).toMatchObject({ reason: "insufficient_samples" });
  });
});

describe("parseEvidence 是 closed schema", () => {
  it("key 输入顺序不影响摘要", () => {
    const e = accepted();
    const shuffled = Object.fromEntries(Object.entries(e).reverse());
    expect(evidenceDigestHex(parseEvidence(shuffled))).toBe(VECTOR_2_HEX);
  });

  it("未知字段被拒绝", () => {
    expect(() => parseEvidence({ ...accepted(), extra: 1 })).toThrow(EvidenceError);
    expect(() => parseEvidence({ ...accepted(), candidate_identifier: { ...accepted().candidate_identifier, note: "x" } })).toThrow(EvidenceError);
  });

  it("缺失字段被拒绝（absent 与 null 不同义）", () => {
    for (const key of Object.keys(accepted())) {
      const e = accepted() as Record<string, unknown>;
      delete e[key];
      expect(() => parseEvidence(e), `缺 ${key}`).toThrow(EvidenceError);
    }
  });

  it("只有 rejected 的 candidate_identifier 可以是 null；accepted 为 null 被拒绝；其他字段为 null 被拒绝", () => {
    expect(() => parseEvidence({ ...accepted(), candidate_identifier: null })).toThrow(EvidenceError);
    const rejected = { ...accepted(), decision: "rejected", reason: "tie_for_highest", candidate_identifier: null };
    expect(() => parseEvidence(rejected)).not.toThrow();
    expect(() => parseEvidence({ ...rejected, policy_version: null })).toThrow(EvidenceError);
    expect(() => parseEvidence({ ...rejected, total_entry_count: null })).toThrow(EvidenceError);
  });

  it("计数必须是非负整数；浮点、字符串、指数形式、负数都拒绝", () => {
    for (const bad of [1.5, "21", -1, Number.NaN, 2 ** 53]) {
      expect(() => parseEvidence({ ...accepted(), total_entry_count: bad })).toThrow(EvidenceError);
    }
  });

  it("evidence_batch_id 必须是十进制 BIGINT 的 string：数字、前导零、负数、0 都拒绝", () => {
    for (const bad of [42, "042", "-1", "0", "4.2", ""]) {
      expect(() => parseEvidence({ ...accepted(), evidence_batch_id: bad })).toThrow(EvidenceError);
    }
    expect(() => parseEvidence({ ...accepted(), evidence_batch_id: "9007199254740993" })).not.toThrow();
  });

  it("计数一致性：total = 非空 + 空；author_counts 之和 = 非空条目数", () => {
    expect(() => parseEvidence({ ...accepted(), total_entry_count: 22 })).toThrow(EvidenceError);
    expect(() => parseEvidence({ ...accepted(), author_counts: [{ identifier: "5decba2300000000010007e1", count: 20 }] })).toThrow(EvidenceError);
  });

  it("author_counts 必须按 identifier 的 UTF-8 字节序排序且不重复", () => {
    const base = { ...accepted(), total_entry_count: 4, non_empty_author_entry_count: 4, candidate_identifier: null, decision: "rejected", reason: "tie_for_highest" };
    expect(() => parseEvidence({ ...base, author_counts: [{ identifier: "b", count: 2 }, { identifier: "a", count: 2 }] })).toThrow(EvidenceError);
    expect(() => parseEvidence({ ...base, author_counts: [{ identifier: "a", count: 2 }, { identifier: "a", count: 2 }] })).toThrow(EvidenceError);
    expect(() => parseEvidence({ ...base, author_counts: [{ identifier: "a", count: 2 }, { identifier: "b", count: 2 }] })).not.toThrow();
  });

  it("accepted 的候选必须出现在 author_counts 中且计数一致", () => {
    expect(() => parseEvidence({ ...accepted(), candidate_identifier: { namespace: NS, value: "other", count: 21 } })).toThrow(EvidenceError);
    expect(() => parseEvidence({ ...accepted(), candidate_identifier: { namespace: NS, value: "5decba2300000000010007e1", count: 20 } })).toThrow(EvidenceError);
  });

  it("identifier 是 exact text：大小写不同是不同作者；NFC 与 NFD 的摘要不同", () => {
    const mk = (v: string) => ({ ...accepted(), candidate_identifier: { namespace: NS, value: v, count: 21 }, author_counts: [{ identifier: v, count: 21 }] });
    expect(evidenceDigestHex(parseEvidence(mk("abc")))).not.toBe(evidenceDigestHex(parseEvidence(mk("ABC"))));
    expect(evidenceDigestHex(parseEvidence(mk("\u00e9")))).not.toBe(evidenceDigestHex(parseEvidence(mk("e\u0301"))));
  });

  it("namespace 只能是代码枚举里的内容作者命名空间", () => {
    expect(() => parseEvidence({ ...accepted(), candidate_identifier: { namespace: "douyin.user_id", value: "5decba2300000000010007e1", count: 21 } })).toThrow(EvidenceError);
  });
});
