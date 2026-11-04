// RFC 8785 JSON Canonicalization Scheme，只覆盖本项目 closed schema 用到的类型：
// string / boolean / null / 安全整数 / 数组 / 普通对象。
//
// 自己实现而不引库（2026-11-04 刘学奎决定）：输入类型被限死后，JCS 只剩两件事——
// ① key 按 UTF-16 码元排序；② 字符串与整数按 ECMAScript 的 JSON 序列化规则输出（JSON.stringify 已经满足）。
// 用 v2 §5.5 的两个固定向量锁住；浮点数、bigint、undefined 一律拒绝，而不是悄悄转换。
import { createHash } from "node:crypto";

export type JcsValue = string | boolean | null | number | JcsValue[] | { [key: string]: JcsValue };

export class JcsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JcsError";
  }
}

function encode(v: unknown, path: string): string {
  if (v === null) return "null";
  switch (typeof v) {
    case "boolean":
      return v ? "true" : "false";
    case "string":
      // 孤立代理项不能编码为合法 UTF-8；JSON.stringify 会输出 \udXXX，那不是 JCS 要求的 UTF-8 字节
      if (!v.isWellFormed()) throw new JcsError(`${path}：字符串含孤立代理项`);
      return JSON.stringify(v);
    case "number":
      if (!Number.isSafeInteger(v)) throw new JcsError(`${path}：只接受安全整数，收到 ${String(v)}（BIGINT 与外部 ID 请先转十进制 string）`);
      return Object.is(v, -0) ? "0" : String(v);
    case "object": {
      if (Array.isArray(v)) return `[${v.map((x, i) => encode(x, `${path}[${i}]`)).join(",")}]`;
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) throw new JcsError(`${path}：只接受普通对象`);
      const obj = v as Record<string, unknown>;
      // 默认的 sort() 按 UTF-16 码元比较，正是 RFC 8785 §3.2.3 要求的顺序
      const keys = Object.keys(obj).sort();
      return `{${keys.map((k) => `${encode(k, `${path}.${k}`)}:${encode(obj[k], `${path}.${k}`)}`).join(",")}}`;
    }
    default:
      throw new JcsError(`${path}：不支持的类型 ${typeof v}`);
  }
}

export function jcsString(value: JcsValue): string {
  return encode(value, "$");
}

/** 无 BOM 的 UTF-8 字节。 */
export function jcsBytes(value: JcsValue): Uint8Array {
  return new TextEncoder().encode(jcsString(value));
}

export function jcsSha256(value: JcsValue): Buffer {
  return createHash("sha256").update(jcsBytes(value)).digest();
}

export function jcsSha256Hex(value: JcsValue): string {
  return jcsSha256(value).toString("hex");
}
