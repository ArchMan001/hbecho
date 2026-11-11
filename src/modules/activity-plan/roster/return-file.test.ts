import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildRosterReturnFile, isReturned, REASON_TEXT, RETURN_COLUMNS, type ReturnRow } from "./return-file";

const row = (over: Partial<ReturnRow> = {}): ReturnRow => ({ raw: { 门店编码: "S1", 专员姓名: "甲", 手机号: "13800000001", 主页链接: "https://www.douyin.com/user/A" }, precheckClass: "new", outcome: null, reasonCode: null, reasonDetail: null, ...over });

describe("回流文件", () => {
  it("只含 error / conflict / invalid / resolve_failed 的行；成功与解析中不回流", () => {
    const rows = [
      row({ precheckClass: "error", reasonCode: "phone_invalid" }),
      row({ outcome: "imported" }),
      row({ outcome: "unchanged" }),
      row({ outcome: "pending_account" }),
      row({ outcome: "suspected_empty" }),
      row({ outcome: "conflict", reasonCode: "assignment_conflict" }),
      row({ outcome: "invalid", reasonCode: "result_validation_exhausted" }),
      row({ outcome: "resolve_failed", reasonCode: "root_failed" }),
    ];
    expect(rows.filter(isReturned)).toHaveLength(4);
    expect(buildRosterReturnFile(rows).rows).toBe(4);
  });
  it("列：原 4 列 + 预检分类 / 结果 / 原因；顺序与输入一致；BOM + CRLF", () => {
    const f = buildRosterReturnFile([row({ precheckClass: "error", reasonCode: "store_not_found" }), row({ raw: { 门店编码: "S2", 专员姓名: "乙", 手机号: "13800000002", 主页链接: "u" }, outcome: "conflict", reasonCode: "assignment_conflict" })]);
    expect(f.content.startsWith("\uFEFF")).toBe(true);
    const lines = f.content.trimEnd().split("\r\n");
    expect(lines[0]).toBe(`\uFEFF${RETURN_COLUMNS.join(",")}`);
    expect(lines[0]).toContain("门店编码,专员姓名,手机号,主页链接,预检分类,结果,原因");
    expect(lines[1]).toMatch(/^S1,甲,13800000001,https:\/\/www\.douyin\.com\/user\/A,错误,未写入,/);
    expect(lines[2]).toMatch(/^S2,乙,.*,冲突,/);
  });
  it("以 = + - @ 开头的单元格带 ' 前缀（公式注入保护）", () => {
    const f = buildRosterReturnFile([row({ raw: { 门店编码: "=cmd|' /c calc'!A0", 专员姓名: "+x", 手机号: "-1", 主页链接: "@y" }, precheckClass: "error", reasonCode: "required_missing" })]);
    const line = f.content.trimEnd().split("\r\n")[1]!;
    expect(line).toContain("\"'=cmd|' /c calc'!A0\"".replace(/^"|"$/g, "")); // 外层引号视逗号而定，前缀必须在
    expect(line).toContain("'+x");
    expect(line).toContain("'-1");
    expect(line).toContain("'@y");
  });
  it("原因列：业务文案 + 括号里的代码；未知代码退回代码本身", () => {
    const f = buildRosterReturnFile([row({ precheckClass: "error", reasonCode: "store_not_found" }), row({ precheckClass: "error", reasonCode: "brand_new_code" })]);
    expect(f.content).toContain("门店编码在系统中不存在，请联系管理员（store_not_found）");
    expect(f.content).toContain("brand_new_code（brand_new_code）");
  });
});

describe("每个 reason_code 都有原因文案（遗漏使测试失败）", () => {
  // 从产生原因码的源码里把字符串字面量扫出来：新加了原因码却没写文案，这里就会失败
  const dir = join(__dirname);
  const sources = readdirSync(dir).filter((f) => /^(classify|confirm|settle|staff)\.ts$/.test(f)).map((f) => readFileSync(join(dir, f), "utf8"));
  const found = new Set<string>();
  for (const src of sources) {
    for (const re of [/\bfail\("([a-z][a-z0-9_]+)"/g, /\berr\("([a-z][a-z0-9_]+)"/g, /\breason:\s*"([a-z][a-z0-9_]+)"/g, /reason\w*:\s*"([a-z][a-z0-9_]+)"/g, /"(staff_name_differs|known_account_[a-z_]+|already_in_roster|restore_roster_entry|restored_roster_entry|existing_account_referenced|precheck_stale)"/g]) {
      for (const m of src.matchAll(re)) found.add(m[1]!);
    }
  }
  // 根任务带来的原因码（来自 tracer / 状态机，不是本模块字面量）
  for (const c of ["non_home_locator", "platform_mismatch", "result_validation_exhausted"]) found.add(c);
  found.delete("normal");
  it("扫描到足够多的原因码，且每个都有文案", () => {
    expect(found.size).toBeGreaterThan(25);
    expect([...found].filter((c) => !(c in REASON_TEXT) && /_/.test(c)).sort()).toEqual([]);
  });
  it("文案里没有内部字段名（下划线词）", () => {
    for (const [code, text] of Object.entries(REASON_TEXT)) expect(text.replace(code, ""), code).not.toMatch(/[a-z]+_[a-z_]+/);
  });
});
