import { describe, expect, it } from "vitest";
import { HEADER } from "./file-parser";
import { buildReturnFile, csvCell, type ReturnRow } from "./return-file";

const raw = (o: Record<string, string> = {}): Record<string, string> => ({
  ...Object.fromEntries(HEADER.map((h) => [h, "x"])),
  ...o,
});
const r = (over: Partial<ReturnRow> = {}): ReturnRow => ({ raw: raw(), precheckClass: "error", outcome: null, reasonCode: "dealer_code_missing", reasonDetail: null, ...over });

describe("回流文件", () => {
  it("带 BOM；原 11 列 + 预检分类 / 结果 / 原因；行用 CRLF", () => {
    const text = buildReturnFile([r()]);
    expect(text.startsWith("\uFEFF")).toBe(true);
    const [head, line] = text.slice(1).split("\r\n");
    expect(head!.split(",")).toEqual([...HEADER, "预检分类", "结果", "原因"]);
    expect(line).toContain("错误,未写入,");
    expect(line).toContain("dealer_code_missing");
  });

  it("只含 error / needs_superadmin / conflict；成功行不回流", () => {
    const rows = [
      r({ raw: raw({ 门店编码: "E" }) }),
      r({ raw: raw({ 门店编码: "Q" }), precheckClass: "needs_superadmin", reasonCode: "dealer_not_found" }),
      r({ raw: raw({ 门店编码: "C" }), precheckClass: "update", outcome: "conflict", reasonCode: "precheck_stale" }),
      r({ raw: raw({ 门店编码: "OK1" }), precheckClass: "new", outcome: "imported", reasonCode: null }),
      r({ raw: raw({ 门店编码: "OK2" }), precheckClass: "unchanged", outcome: "unchanged", reasonCode: null }),
    ];
    const text = buildReturnFile(rows);
    expect(text.trim().split("\r\n")).toHaveLength(4); // 表头 + 3
    expect(text).not.toContain("OK1");
    expect(text).not.toContain("OK2");
  });

  it("以 = + - @ \\t \\r 开头的单元格加 ' 前缀；含逗号、引号、换行的单元格加引号并转义", () => {
    for (const v of ["=1+1", "+1", "-1", "@SUM(A1)", "\tx", "\rx"]) expect(csvCell(v).replace(/^"|"$/g, "").startsWith("'")).toBe(true);
    expect(csvCell("普通")).toBe("普通");
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell("a\nb")).toBe('"a\nb"');
  });
});
