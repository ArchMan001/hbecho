// 静态边界（requirements EL-7 / EL-8、ADR-0011、design §13）：靠扫描源码保证，不靠人记得。
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..", "..");
const HERE = __dirname;
const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? walk(p) : [p];
});
const prod = (files: string[]) => files.filter((p) => /\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p));
const hits = (files: string[], re: RegExp) => files.filter((p) => re.test(readFileSync(p, "utf8"))).map((p) => p.replace(SRC, "src"));
const READ = /\bxlsx\s*\.\s*(read|readFile|load)\b|\bworkbook\s*\.\s*xlsx\s*\.\s*(read|load)/i;
const IMAGE = /\baddImage\s*\(/;
const D_TABLES = /\b(judgementPlans|judgementRuns|judgementPlanVersions|runContents|runParticipants)\b/;
const WRITE = /\.\s*(insert|update|delete)\s*\(/;

describe("ADR-0011：生产代码只写不读 xlsx", () => {
  it("全仓非测试代码里没有 xlsx.read / xlsx.load / xlsx.readFile", () => {
    expect(hits(prod(walk(SRC)), READ)).toEqual([]);
  });
  it("反向用例：扫描条件本身能识别读取与嵌图", () => {
    expect(READ.test("await wb.xlsx.load(buf)")).toBe(true);
    expect(READ.test("workbook.xlsx.read(stream)")).toBe(true);
    expect(READ.test("wb.stream.xlsx.WorkbookWriter")).toBe(false);
    expect(IMAGE.test("ws.addImage(id, 'A1')")).toBe(true);
  });
  it("导出代码没有嵌图（addImage 零调用）：EL-8 导出不含图片", () => {
    expect(hits(prod(walk(HERE)), IMAGE)).toEqual([]);
  });
});
describe("design §13：只读，且不 JOIN D 的表", () => {
  it("report-detail 的非测试代码不写任何表（没有 insert / update / delete）", () => {
    expect(hits(prod(walk(HERE)), WRITE).map((f) => f.replace("src/modules/report-detail/", ""))).toEqual([]);
  });
  it("report-detail 不引用 D 的表（只经 JudgementOutcomeReader 读）", () => {
    expect(hits(prod(walk(HERE)), D_TABLES)).toEqual([]);
  });
  it("反向用例", () => {
    expect(WRITE.test("await db.insert(x).values(y)")).toBe(true);
    expect(D_TABLES.test('import { runContents } from "../../db/schema"')).toBe(true);
    expect(D_TABLES.test("contentSnapshots")).toBe(false);
  });
});
