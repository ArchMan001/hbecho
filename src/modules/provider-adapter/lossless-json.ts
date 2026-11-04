// 无损 JSON 解析：数字保留原文，不经 JavaScript number（R5.1）。
// 用 Node 原生 JSON.parse 的 reviver 第三参数 context.source（Node ≥ 22 / V8 ≥ 11.4），不引入依赖。

/** 一个 JSON 数字 token 的原文。外部 ID、游标、计数都从 source 取值，绝不转 number。 */
export class JsonNumber {
  constructor(readonly source: string) {}
}

export type JsonObject = { [key: string]: JsonValue };
export type JsonValue = null | boolean | string | JsonNumber | JsonValue[] | JsonObject;

/** 整数字面量（可带负号，无小数点、无指数）。 */
export function isIntegerLiteral(n: JsonNumber): boolean {
  return /^-?\d+$/.test(n.source);
}

export function isJsonObject(v: JsonValue | undefined): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof JsonNumber);
}

export function parseJson(text: string): JsonValue {
  return JSON.parse(text, (_key: string, value: unknown, context?: { source?: string }) => {
    if (typeof value === "number") {
      if (context?.source === undefined) {
        throw new Error("当前运行时的 JSON.parse 不提供 context.source，无法无损解析数字（需要 Node 24）");
      }
      return new JsonNumber(context.source);
    }
    return value;
  }) as JsonValue;
}
