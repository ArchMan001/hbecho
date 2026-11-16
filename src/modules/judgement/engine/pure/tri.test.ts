import { describe, expect, it } from "vitest";
import { and3, andOutcome, evaluateMethod, type Method } from "./tri";
import type { Outcome, Tri } from "./types";

const TRIS: Tri[] = ["pass", "fail", "unobtained"];

describe("and3", () => {
  it("3×3 全表：不通过 > 未获取成功 > 通过", () => {
    for (const a of TRIS)
      for (const b of TRIS) {
        const want: Tri = a === "fail" || b === "fail" ? "fail" : a === "unobtained" || b === "unobtained" ? "unobtained" : "pass";
        expect(and3([a, b])).toBe(want);
      }
  });
  it("空集 = 通过（没配的层由调用方用 not_configured 区分）", () => expect(and3([])).toBe("pass"));
});

describe("andOutcome", () => {
  it("不达标优先于未获取成功；没配的对象（null）不参与", () => {
    expect(andOutcome(["success", "not_met", "unobtained"])).toBe("not_met");
    expect(andOutcome(["success", "unobtained", "success"])).toBe("unobtained");
    expect(andOutcome(["success", null, "success"])).toBe("success");
    expect(andOutcome([null, "unobtained", null])).toBe("unobtained");
  });
  it("一类要求都没配 → 抛错（配置校验期就应挡住）", () => expect(() => andOutcome([null, null])).toThrow());
});

/** 独立参照：把未获取成功分别按「全部通过」「全部不通过」两种极端代入——最坏也达标 = 成功；最好也不达标 = 不达标；其余未获取成功。 */
function reference(m: Method, p: number, u: number, f: number): Outcome | "zero" {
  const t = p + u + f;
  if (t === 0 && m.type !== "at_least_n") return "zero";
  const ok = (P: number, F: number): boolean => {
    switch (m.type) {
      case "at_least_n": return P >= m.n;
      case "all": return F === 0 && P === t && t > 0;
      case "any": return P >= 1;
      case "ratio": return P * 10000 >= m.bp * t;
    }
  };
  if (ok(p, f + u)) return "success";
  if (!ok(p + u, f)) return "not_met";
  return "unobtained";
}

describe("evaluateMethod", () => {
  const methods: Method[] = [
    { type: "at_least_n", n: 1 }, { type: "at_least_n", n: 3 }, { type: "at_least_n", n: 5 },
    { type: "all" }, { type: "any" },
    { type: "ratio", bp: 1 }, { type: "ratio", bp: 3333 }, { type: "ratio", bp: 5000 }, { type: "ratio", bp: 10000 },
  ];
  it("四种方式 × T ≤ 5 的 (P, U, F) 穷举与独立参照实现逐格相等", () => {
    let cells = 0;
    for (const m of methods)
      for (let p = 0; p <= 5; p++)
        for (let u = 0; p + u <= 5; u++)
          for (let f = 0; p + u + f <= 5; f++) {
            expect(evaluateMethod(m, { p, u, f }), `${JSON.stringify(m)} P=${p} U=${u} F=${f}`).toBe(reference(m, p, u, f));
            cells++;
          }
    expect(cells).toBeGreaterThan(500);
  });
  it("至少 N：P ≥ N 成功；P + U < N 不达标；其余未获取（PRD 例：2 通过 + 1 缺素材、N=3 → 未获取成功）", () => {
    const m: Method = { type: "at_least_n", n: 3 };
    expect(evaluateMethod(m, { p: 6, u: 0, f: 0 })).toBe("success");
    expect(evaluateMethod(m, { p: 2, u: 1, f: 0 })).toBe("unobtained");
    expect(evaluateMethod(m, { p: 2, u: 0, f: 5 })).toBe("not_met");
    expect(evaluateMethod({ type: "at_least_n", n: 5 }, { p: 6, u: 0, f: 0 })).toBe("success");
    expect(evaluateMethod({ type: "at_least_n", n: 6 }, { p: 4, u: 0, f: 0 })).toBe("not_met");
    expect(evaluateMethod({ type: "at_least_n", n: 6 }, { p: 5, u: 1, f: 0 })).toBe("unobtained");
  });
  it("全部通过 / 任一条通过的边界", () => {
    expect(evaluateMethod({ type: "all" }, { p: 3, u: 0, f: 1 })).toBe("not_met");
    expect(evaluateMethod({ type: "all" }, { p: 3, u: 1, f: 0 })).toBe("unobtained");
    expect(evaluateMethod({ type: "all" }, { p: 3, u: 0, f: 0 })).toBe("success");
    expect(evaluateMethod({ type: "any" }, { p: 0, u: 0, f: 4 })).toBe("not_met");
    expect(evaluateMethod({ type: "any" }, { p: 0, u: 1, f: 4 })).toBe("unobtained");
  });
  it("ratio 边界：P·10000 = bp·T 判成功；(P+U)·10000 < bp·T 判不达标", () => {
    expect(evaluateMethod({ type: "ratio", bp: 5000 }, { p: 2, u: 0, f: 2 })).toBe("success");
    expect(evaluateMethod({ type: "ratio", bp: 5000 }, { p: 1, u: 0, f: 3 })).toBe("not_met");
    expect(evaluateMethod({ type: "ratio", bp: 5000 }, { p: 1, u: 1, f: 2 })).toBe("unobtained");
  });
  it("T = 0：all / any / ratio 交给调用方（zero）；at_least_n 不依赖 T", () => {
    for (const m of [{ type: "all" }, { type: "any" }, { type: "ratio", bp: 5000 }] as Method[]) expect(evaluateMethod(m, { p: 0, u: 0, f: 0 })).toBe("zero");
    expect(evaluateMethod({ type: "at_least_n", n: 1 }, { p: 0, u: 0, f: 0 })).toBe("not_met");
  });
});
