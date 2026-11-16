// 三值逻辑与专员级达标方式（design §7.6、PRD D §2.0.2）。全部整数运算，不用浮点。
import type { Outcome, Tri } from "./types";

/** 任一不通过 → 不通过；否则任一未获取 → 未获取；否则通过（空集 = 通过，调用方用 not_configured 区分「没配」）。 */
export function and3(xs: readonly Tri[]): Tri {
  if (xs.includes("fail")) return "fail";
  if (xs.includes("unobtained")) return "unobtained";
  return "pass";
}

/** 计划总结果：不达标优先于未获取成功（D-D04）；没配的对象传 null，不参与。 */
export function andOutcome(xs: ReadonlyArray<Outcome | null>): Outcome {
  const present = xs.filter((x): x is Outcome => x !== null);
  if (present.length === 0) throw new Error("计划总结果至少需要一类已配置的要求");
  if (present.includes("not_met")) return "not_met";
  if (present.includes("unobtained")) return "unobtained";
  return "success";
}

export type Method = { type: "at_least_n"; n: number } | { type: "all" } | { type: "any" } | { type: "ratio"; bp: number };
export interface Counts {
  /** 通过 */
  p: number;
  /** 未获取成功 */
  u: number;
  /** 不通过 */
  f: number;
}
export const totalOf = (c: Counts): number => c.p + c.u + c.f;

/**
 * 专员级达标方式。T = P + U + F；all / any / ratio 在 T = 0 时返回 "zero"，由调用方按零内容规则处理。
 * at_least_n 不依赖 T：只看 P 与 P + U 相对 n（内容要求的零内容由调用方按「参与内容行数为 0」先判，见 aggregate.ts）。
 */
export function evaluateMethod(m: Method, c: Counts): Outcome | "zero" {
  const t = totalOf(c);
  switch (m.type) {
    case "at_least_n":
      if (c.p >= m.n) return "success";
      if (c.p + c.u < m.n) return "not_met";
      return "unobtained";
    case "all":
      if (t === 0) return "zero";
      if (c.f >= 1) return "not_met";
      if (c.u >= 1) return "unobtained";
      return "success";
    case "any":
      if (t === 0) return "zero";
      if (c.p >= 1) return "success";
      return c.u === 0 ? "not_met" : "unobtained";
    case "ratio":
      if (t === 0) return "zero";
      if (c.p * 10000 >= m.bp * t) return "success";
      if ((c.p + c.u) * 10000 < m.bp * t) return "not_met";
      return "unobtained";
  }
}
