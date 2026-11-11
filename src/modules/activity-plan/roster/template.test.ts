import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EXAMPLE_ROW, MAX_ROWS, ROSTER_HEADER } from "../constants";
import { buildTemplate, parseRosterFile, TEMPLATE_GUIDE } from "./template";

const fx = (n: string): Uint8Array => readFileSync(new URL(`../../../../tests/fixtures/roster/${n}`, import.meta.url));
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const HEADER = ROSTER_HEADER.join(",");
const fail = (bytes: Uint8Array): string => {
  try {
    parseRosterFile(bytes);
  } catch (e) {
    return (e as { code: string }).code;
  }
  return "ok";
};

describe("编码：UTF-8 / BOM / GB18030 同内容结果完全相同", () => {
  it("三种编码解析出相同的行", () => {
    const a = parseRosterFile(fx("basic.utf8.csv"));
    const b = parseRosterFile(fx("basic.utf8-bom.csv"));
    const c = parseRosterFile(fx("basic.gb18030.csv"));
    expect(a.rows).toEqual(b.rows);
    expect(a.rows).toEqual(c.rows);
    expect(a.rows).toHaveLength(2);
    expect([a.encoding, c.encoding]).toEqual(["utf-8", "gb18030"]);
  });
  it("乱码字节 → encoding_unrecognized，带可打印样本", () => {
    try {
      parseRosterFile(fx("garbage.bin"));
      expect.unreachable();
    } catch (e) {
      expect(e).toMatchObject({ category: "input", code: "encoding_unrecognized" });
      expect((e as { detail: { sample: string } }).detail.sample).toContain("garbage");
    }
  });
});

describe("文件级失败", () => {
  it("表头改名 / 换序 / 多列 / 少列 → header_mismatch，提示重新下载模板", () => {
    for (const h of ["门店编号,专员姓名,手机号,主页链接", "专员姓名,门店编码,手机号,主页链接", `${HEADER},平台`, "门店编码,专员姓名,手机号"]) {
      expect(fail(enc(`${h}\r\nS1,甲,13800000001,https://a\r\n`)), h).toMatch(/header_mismatch|csv_malformed/);
    }
    try {
      parseRosterFile(enc("门店编号,专员姓名,手机号,主页链接\r\nS1,甲,13800000001,x\r\n"));
    } catch (e) {
      expect((e as Error).message).toContain("roster-import.v1");
      expect((e as { detail: { expected: string[] } }).detail.expected).toEqual([...ROSTER_HEADER]);
    }
  });
  it("空文件、只有表头、列数不一致、引号未闭合", () => {
    expect(fail(enc(""))).toBe("empty_file");
    expect(fail(enc(`${HEADER}\r\n`))).toBe("no_data_rows");
    expect(fail(enc(`${HEADER}\r\nS1,甲,13800000001\r\n`))).toBe("csv_malformed");
    expect(fail(enc(`${HEADER}\r\nS1,"甲,13800000001,x\r\n`))).toBe("csv_malformed");
  });
  it("大小与行数上限：10 MB + 1 字节、2,001 行；2,000 行可用", () => {
    expect(fail(new Uint8Array(10 * 1024 * 1024 + 1))).toBe("file_too_large");
    const rows = (n: number) => enc(`${HEADER}\r\n${Array.from({ length: n }, (_, i) => `S1,甲,138${String(i).padStart(8, "0")},u${i}`).join("\r\n")}\r\n`);
    expect(fail(rows(MAX_ROWS + 1))).toBe("too_many_rows");
    expect(fail(rows(MAX_ROWS))).toBe("ok");
  });
});

describe("表头跳过与示例行", () => {
  it("模板原样上传：表头跳过，示例行被标出且不进入数据；示例行占位，其余行号不变", () => {
    const r = parseRosterFile(enc(buildTemplate() + "S1,甲,13800000001,https://a\r\n"));
    expect(r.exampleRowNos).toEqual([1]);
    expect(r.rows).toEqual([{ rowNo: 2, cells: ["S1", "甲", "13800000001", "https://a"] }]);
  });
  it("示例行只改了一个单元格 → 不再是示例行，按数据行", () => {
    const edited: string[] = [...EXAMPLE_ROW];
    edited[2] = "13800138001";
    const r = parseRosterFile(enc(`${HEADER}\r\n${edited.join(",")}\r\n`));
    expect(r.exampleRowNos).toEqual([]);
    expect(r.rows).toHaveLength(1);
  });
  it("只有示例行没有数据 → no_data_rows", () => {
    expect(fail(enc(buildTemplate()))).toBe("no_data_rows");
  });
});

describe("按文本保留", () => {
  it("前导零、公式前缀、首尾空白都原样进入 cells（规范化在分类阶段做）", () => {
    const r = parseRosterFile(enc(`${HEADER}\r\n00123, 甲 ,0138-0000-0001,=cmd|' /c calc'!A0\r\n`));
    expect(r.rows[0]?.cells).toEqual(["00123", " 甲 ", "0138-0000-0001", "=cmd|' /c calc'!A0"]);
  });
});

describe("模板", () => {
  it("带 BOM 与 CRLF，表头 + 一行示例；说明含「另存为 CSV」与「设为文本格式」", () => {
    const t = buildTemplate();
    expect(t.startsWith("\uFEFF")).toBe(true);
    expect(t.split("\r\n")[0]).toBe(`\uFEFF${HEADER}`);
    expect(TEMPLATE_GUIDE.join("\n")).toMatch(/另存为 CSV/);
    expect(TEMPLATE_GUIDE.join("\n")).toMatch(/设为「文本」格式/);
  });
  it("模板自己重新上传会解析为：示例行被跳过 → no_data_rows", () => {
    expect(fail(enc(buildTemplate()))).toBe("no_data_rows");
  });
});
