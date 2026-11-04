import { describe, expect, it } from "vitest";
import { parseJson, type JsonObject } from "./lossless-json";
import { readCount, readExternalId, readText } from "./value-state";

const obj = (text: string) => parseJson(text) as JsonObject;

describe("readCount：五态中的前四态（R5.5；unsupported 由接口语义决定，不由取值产生）", () => {
  it("真实 0 是 value，不是 missing", () => {
    expect(readCount(obj('{"a":0}'), "a")).toEqual({ state: "value", value: 0n });
  });

  it("缺失 / 显式 null / 非法互不转换", () => {
    expect(readCount(obj("{}"), "a")).toEqual({ state: "missing" });
    expect(readCount(obj('{"a":null}'), "a")).toEqual({ state: "explicit_null" });
    expect(readCount(obj('{"a":"abc"}'), "a")).toEqual({ state: "invalid", raw: '"abc"' });
    expect(readCount(obj('{"a":-1}'), "a")).toEqual({ state: "invalid", raw: "-1" });
    expect(readCount(obj('{"a":1.5}'), "a")).toEqual({ state: "invalid", raw: "1.5" });
    expect(readCount(obj('{"a":true}'), "a")).toEqual({ state: "invalid", raw: "true" });
  });

  it("供应商以十进制字符串给出的计数视为 value（profile 的 *_count）", () => {
    expect(readCount(obj('{"a":"1181412"}'), "a")).toEqual({ state: "value", value: 1181412n });
    expect(readCount(obj('{"a":"007"}'), "a").state).toBe("invalid");
  });

  it("超过 2^53 的计数不丢精度", () => {
    expect(readCount(obj('{"a":9007199254740993}'), "a")).toEqual({ state: "value", value: 9007199254740993n });
  });

  it("多个候选字段：第一个有效值胜出，其后才按 invalid > explicit_null > missing 取最强的无效态", () => {
    const keys = ["x_number", "x_count"] as const;
    expect(readCount(obj('{"x_count":"5","x_number":7}'), ...keys)).toEqual({ state: "value", value: 7n });
    expect(readCount(obj('{"x_number":null,"x_count":"5"}'), ...keys)).toEqual({ state: "value", value: 5n });
    expect(readCount(obj('{"x_number":null}'), ...keys)).toEqual({ state: "explicit_null" });
    expect(readCount(obj('{"x_number":"bad"}'), ...keys).state).toBe("invalid");
    expect(readCount(obj('{"x_number":null,"x_count":"bad"}'), ...keys).state).toBe("invalid");
    expect(readCount(obj("{}"), ...keys)).toEqual({ state: "missing" });
  });
});

describe("readExternalId：外部 ID 一律文本", () => {
  it("字符串原样保留（含前导零与 19 位数字）", () => {
    expect(readExternalId(obj('{"id":"007"}'), "id")).toEqual({ state: "value", value: "007" });
    expect(readExternalId(obj('{"id":"7680127373081070848"}'), "id")).toEqual({
      state: "value",
      value: "7680127373081070848",
    });
  });

  it("整数 token 取其原文，不经 number", () => {
    expect(readExternalId(obj('{"id":7680127373081070848}'), "id")).toEqual({
      state: "value",
      value: "7680127373081070848",
    });
  });

  it("缺失 / null / 空串 / 浮点 / 布尔 分别落在不同状态", () => {
    expect(readExternalId(obj("{}"), "id")).toEqual({ state: "missing" });
    expect(readExternalId(obj('{"id":null}'), "id")).toEqual({ state: "explicit_null" });
    expect(readExternalId(obj('{"id":""}'), "id")).toEqual({ state: "invalid", raw: '""' });
    expect(readExternalId(obj('{"id":1.5}'), "id")).toEqual({ state: "invalid", raw: "1.5" });
    expect(readExternalId(obj('{"id":false}'), "id")).toEqual({ state: "invalid", raw: "false" });
  });
});

describe("readText", () => {
  it("字符串为 value（空串也是有效文本）；缺失 / null / 非字符串分开", () => {
    expect(readText(obj('{"t":"x"}'), "t")).toEqual({ state: "value", value: "x" });
    expect(readText(obj('{"t":""}'), "t")).toEqual({ state: "value", value: "" });
    expect(readText(obj("{}"), "t")).toEqual({ state: "missing" });
    expect(readText(obj('{"t":null}'), "t")).toEqual({ state: "explicit_null" });
    expect(readText(obj('{"t":1}'), "t")).toEqual({ state: "invalid", raw: "1" });
  });
});
