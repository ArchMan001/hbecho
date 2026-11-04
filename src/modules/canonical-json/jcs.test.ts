import { describe, expect, it } from "vitest";
import { JcsError, jcsBytes, jcsSha256Hex, jcsString } from "./jcs";

const hex = (o: unknown) => jcsSha256Hex(o as never);

describe("v2 §5.5 跨实现验收向量", () => {
  it("向量 1：tracer command —— exact bytes 与 SHA-256", () => {
    const command = {
      // 故意打乱 key 输入顺序：摘要不得依赖输入顺序
      schema_version: "data-foundation-tracer-command.v1",
      platform_id_decimal: "2",
      media_staff_id_decimal: "9007199254740993",
      home_locator_exact_utf8: 'https://www.xiaohongshu.com/user/profile/测试?x="a"&line=一\n二',
      effective_initial_content_limit: 20,
    };
    expect(jcsString(command)).toBe(
      '{"effective_initial_content_limit":20,"home_locator_exact_utf8":"https://www.xiaohongshu.com/user/profile/测试?x=\\"a\\"&line=一\\n二","media_staff_id_decimal":"9007199254740993","platform_id_decimal":"2","schema_version":"data-foundation-tracer-command.v1"}',
    );
    expect(hex(command)).toBe("7dcf255d17be6de663a23e92310bb0f835e00b6cb223d46a9a2c8abd0bf8ec36");
  });

  it("向量 2：dominant-list-author evidence —— exact bytes 与 SHA-256", () => {
    const evidence = {
      total_entry_count: 21,
      schema_version: "dominant-list-author-evidence.v1",
      reason: "unique_highest_and_policy_passed",
      policy_version: "xhs-dominant-author.v1",
      non_empty_author_entry_count: 21,
      evidence_batch_id: "42",
      empty_author_entry_count: 0,
      decision: "accepted",
      candidate_identifier: { value: "5decba2300000000010007e1", namespace: "xiaohongshu.content.user_id", count: 21 },
      author_counts: [{ identifier: "5decba2300000000010007e1", count: 21 }],
    };
    expect(jcsString(evidence)).toBe(
      '{"author_counts":[{"count":21,"identifier":"5decba2300000000010007e1"}],"candidate_identifier":{"count":21,"namespace":"xiaohongshu.content.user_id","value":"5decba2300000000010007e1"},"decision":"accepted","empty_author_entry_count":0,"evidence_batch_id":"42","non_empty_author_entry_count":21,"policy_version":"xhs-dominant-author.v1","reason":"unique_highest_and_policy_passed","schema_version":"dominant-list-author-evidence.v1","total_entry_count":21}',
    );
    expect(hex(evidence)).toBe("2ecbbeebd4d015bb5685d288c0230ab92646f1d0cba08a0937b2a5def673b36d");
  });
});

describe("RFC 8785 要点", () => {
  it("key 按 UTF-16 码元排序（不是码点、不是 UTF-8 字节序）：增补平面字符排在 U+FFFF 之前", () => {
    // U+10000 的 UTF-16 是 D800 DC00，小于 U+FFFF；按码点则相反
    expect(jcsString({ "\uFFFF": 1, "\u{10000}": 2 })).toBe('{"\u{10000}":2,"\uFFFF":1}');
  });

  it("字符串转义：只转义 \" \\ 与控制字符；U+2028 等不转义；用小写十六进制 \\u00xx", () => {
    expect(jcsString("a\"b\\c\b\f\n\r\t\u0001\u001f\u007f\u2028é")).toBe('"a\\"b\\\\c\\b\\f\\n\\r\\t\\u0001\\u001f\u007f\u2028é"');
  });

  it("不做 Unicode 归一化：NFC 与 NFD 是不同字节、不同摘要", () => {
    const nfc = "\u00e9";
    const nfd = "e\u0301";
    expect(hex({ v: nfc })).not.toBe(hex({ v: nfd }));
    expect(Buffer.from(jcsBytes({ v: nfd })).includes(Buffer.from("e\u0301"))).toBe(true);
  });

  it("输出是无 BOM 的 UTF-8", () => {
    const b = jcsBytes({ a: "é" });
    expect(b[0]).toBe(0x7b);
    expect(Array.from(b)).toEqual([...Buffer.from('{"a":"é"}', "utf8")]);
  });

  it("key 输入顺序不影响结果；嵌套对象与数组递归处理，数组保持顺序", () => {
    expect(jcsString({ b: [{ z: 1, a: 2 }, 3], a: null })).toBe('{"a":null,"b":[{"a":2,"z":1},3]}');
    expect(hex({ a: 1, b: 2 })).toBe(hex({ b: 2, a: 1 }));
  });

  it("整数按十进制输出：0、负数、安全整数上界；-0 输出 0", () => {
    expect(jcsString([0, -5, Number.MAX_SAFE_INTEGER, -0])).toBe("[0,-5,9007199254740991,0]");
  });

  it("BIGINT 与外部 ID 必须以十进制 string 传入，原样保留", () => {
    expect(jcsString({ id: "9007199254740993" })).toBe('{"id":"9007199254740993"}');
  });
});

describe("拒绝（closed schema 的底层保证）", () => {
  it.each([
    ["浮点数", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["超出安全整数", 2 ** 53],
    ["bigint（会丢语义，必须先转十进制 string）", 5n],
    ["undefined", undefined],
    ["函数", () => 1],
    ["symbol", Symbol("x")],
  ])("%s", (_name, value) => {
    expect(() => jcsBytes({ v: value } as never)).toThrow(JcsError);
  });

  it("对象里值为 undefined 的 key 被拒绝，而不是悄悄丢弃", () => {
    expect(() => jcsBytes({ a: 1, b: undefined } as never)).toThrow(JcsError);
  });

  it("非普通对象（Date、Map、类实例）被拒绝", () => {
    expect(() => jcsBytes({ at: new Date(0) } as never)).toThrow(JcsError);
    expect(() => jcsBytes(new Map() as never)).toThrow(JcsError);
  });

  it("含孤立代理项的字符串被拒绝（无法编码为合法 UTF-8）", () => {
    expect(() => jcsBytes("\ud800" as never)).toThrow(JcsError);
  });
});
