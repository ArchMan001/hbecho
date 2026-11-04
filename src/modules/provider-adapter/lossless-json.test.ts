import { describe, expect, it } from "vitest";
import { JsonNumber, isIntegerLiteral, parseJson } from "./lossless-json";

describe("parseJson（R5.1：不经 JavaScript number 的有损转换）", () => {
  it("超过 2^53 的整数保留原文，不丢精度", () => {
    const v = parseJson('{"a":9007199254740993}') as { a: JsonNumber };
    expect(v.a).toBeInstanceOf(JsonNumber);
    expect(v.a.source).toBe("9007199254740993");
    expect(isIntegerLiteral(v.a)).toBe(true);
    expect(BigInt(v.a.source)).toBe(9007199254740993n);
  });

  it("整数与带小数/指数的数字可区分，且保留原文", () => {
    const v = parseJson('{"i":0,"f":1.0,"e":1e3,"n":-5}') as Record<string, JsonNumber>;
    expect(v.i!.source).toBe("0");
    expect(isIntegerLiteral(v.i!)).toBe(true);
    expect(v.f!.source).toBe("1.0");
    expect(isIntegerLiteral(v.f!)).toBe(false);
    expect(isIntegerLiteral(v.e!)).toBe(false);
    expect(v.n!.source).toBe("-5");
  });

  it("字符串 ID 保持字符串，数字 0 / 缺失 / null 互不相同", () => {
    const v = parseJson('{"id":"9007199254740993","zero":0,"nil":null}') as Record<string, unknown>;
    expect(v.id).toBe("9007199254740993");
    expect(v.zero).toBeInstanceOf(JsonNumber);
    expect(v.nil).toBeNull();
    expect(Object.hasOwn(v, "nil")).toBe(true);
    expect(Object.hasOwn(v, "absent")).toBe(false);
  });

  it("嵌套数组与对象中的数字同样保留原文", () => {
    const v = parseJson('{"xs":[1,{"y":12345678901234567890}]}') as any;
    expect(v.xs[0].source).toBe("1");
    expect(v.xs[1].y.source).toBe("12345678901234567890");
  });

  it("__proto__ 键只是普通自有属性，不污染原型", () => {
    const v = parseJson('{"__proto__":{"polluted":true}}') as Record<string, unknown>;
    expect(Object.hasOwn(v, "__proto__")).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("非法 JSON 抛出，不返回半成品", () => {
    expect(() => parseJson("{")).toThrow();
    expect(() => parseJson("")).toThrow();
  });
});
