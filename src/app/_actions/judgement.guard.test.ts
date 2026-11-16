// 判定计划页面与服务端动作的静态护栏（仓库无 jsdom，页面没有渲染测试）：
// 动作都经 run()；页面先 requireUser 再按 Capability 决定显示还是「无权访问」；页面与动作不直接碰数据库、不写角色字面量。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const APP = join(__dirname, "..");
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const rel = (f: string) => f.slice(APP.length + 1);
const files = [...walk(join(APP, "(app)", "judgement")), ...walk(join(APP, "_components", "judgement")), join(APP, "_actions", "judgement.ts"), join(APP, "_lib", "judgement.ts"), join(APP, "_lib", "judgement-labels.ts")];

describe("判定计划：服务端动作都经过 run()", () => {
  const src = readFileSync(join(APP, "_actions", "judgement.ts"), "utf8");
  it("以 use server 开头，且每个导出的动作都调用 run()", () => {
    expect(src.startsWith('"use server"')).toBe(true);
    const actions = [...src.matchAll(/export async function (\w+)\([^)]*\)[^{]*\{([\s\S]*?)\n\}/g)];
    expect(actions.map((m) => m[1])).toEqual(["createJudgementPlan", "archiveJudgementPlan", "unarchiveJudgementPlan"]);
    expect(actions.filter((m) => !/\brun\(/.test(m[2]!)).map((m) => m[1])).toEqual([]);
  });
});

describe("判定计划：页面", () => {
  const pages = walk(join(APP, "(app)", "judgement")).filter((f) => f.endsWith("page.tsx"));
  it("当前覆盖的页面", () => {
    expect(pages.map(rel).sort()).toEqual(["(app)/judgement/[id]/page.tsx", "(app)/judgement/page.tsx"]);
  });
  for (const f of pages) {
    it(`${rel(f)}：requireUser → rule.definition.read → DeniedState`, () => {
      const src = readFileSync(f, "utf8");
      expect(src).toMatch(/await requireUser\(\)/);
      expect(src).toMatch(/capabilities\.has\("rule\.definition\.read"\)/);
      expect(src).toMatch(/<DeniedState/);
      expect(src.indexOf("requireUser()")).toBeLessThan(src.indexOf("capabilities.has"));
    });
  }
  it("导航入口由 rule.definition.read 控制", () => {
    expect(readFileSync(join(APP, "(app)", "layout.tsx"), "utf8")).toMatch(/capabilities\.has\("rule\.definition\.read"\)[^\n]*"\/judgement"/);
  });
});

describe("判定计划：页面层只经 Module 取数", () => {
  it("没有角色字面量、没有 SQL、不 import 数据库表定义、不 import A / C 的模块", () => {
    for (const f of files) {
      const src = readFileSync(f, "utf8").replace(/\/\/.*$/gm, "");
      expect(src, rel(f)).not.toMatch(/\b(platform_admin|hq_manager|branch_manager|store_staff)\b/);
      expect(src, rel(f)).not.toMatch(/\.(insert|update|delete|execute|transaction)\(|\bsql`/);
      expect(src, rel(f)).not.toMatch(/from "[./]*\/db\/|from "[./]*\/activity-plan|from "[./]*\/signals|drizzle-orm/);
    }
  });
  it("界面里没有内部字段名 / 表名（稳定错误码除外）", () => {
    for (const f of files.filter((x) => x.endsWith(".tsx"))) {
      const src = readFileSync(f, "utf8");
      expect(src, rel(f)).not.toMatch(/judgement_plans|judgement_runs|run_participants|phase_detail|config_sha256|reason_code/);
    }
  });
});
