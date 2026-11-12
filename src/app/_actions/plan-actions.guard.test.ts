// 活动计划页面与服务端动作的静态护栏：没有自动化的页面测试（仓库无 jsdom），所以把「每个入口都经过会话与 Capability」写成可执行的检查。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const APP = join(__dirname, "..");
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));

describe("服务端动作：每个导出的动作都经过 run()（会话校验 + 统一的错误映射）", () => {
  for (const file of ["plans.ts", "accounts.ts"]) {
    it(file, () => {
      const src = readFileSync(join(APP, "_actions", file), "utf8");
      const actions = [...src.matchAll(/export async function (\w+)\([^)]*\)[^{]*\{([\s\S]*?)\n\}/g)];
      expect(actions.length).toBeGreaterThanOrEqual(3);
      expect(actions.filter((m) => !/\brun\(/.test(m[2]!)).map((m) => m[1])).toEqual([]);
      expect(src.startsWith('"use server"')).toBe(true);
    });
  }
  it("动作里没有角色字面量、没有 SQL", () => {
    for (const file of ["plans.ts", "accounts.ts"]) {
      const src = readFileSync(join(APP, "_actions", file), "utf8");
      expect(src).not.toMatch(/\b(platform_admin|hq_manager|branch_manager|store_staff)\b/);
      expect(src).not.toMatch(/\.(insert|update|delete|execute|transaction)\(|\bsql`/);
    }
  });
});

describe("页面：每个页面先 requireUser，再按 Capability 决定显示还是「无权访问」", () => {
  const pages = ["plans", "batches", "accounts"].flatMap((d) => walk(join(APP, "(app)", d)).filter((f) => f.endsWith("page.tsx")));
  it("覆盖到全部 7 个页面", () => {
    expect(pages.map((p) => p.slice(APP.length + 1)).sort()).toEqual([
      "(app)/accounts/page.tsx",
      "(app)/batches/[id]/page.tsx",
      "(app)/batches/page.tsx",
      "(app)/plans/[id]/import/page.tsx",
      "(app)/plans/[id]/page.tsx",
      "(app)/plans/new/page.tsx",
      "(app)/plans/page.tsx",
      "(app)/plans/trash/page.tsx",
    ].sort());
  });
  for (const f of pages) {
    it(f.slice(APP.length + 1), () => {
      const src = readFileSync(f, "utf8");
      expect(src).toMatch(/await requireUser\(\)/);
      expect(src).toMatch(/capabilities\.has\("(activity_plan\.(create|join)|data\.account\.manage)"\)/);
      expect(src).toMatch(/<DeniedState/);
    });
  }
});
