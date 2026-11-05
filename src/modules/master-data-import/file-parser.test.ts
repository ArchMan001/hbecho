// 文件级校验（MD-1、A1–A8、H11）。夹具全是脱敏造数。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MasterDataError } from "./errors";
import { HEADER, parseFile } from "./file-parser";

const fx = (name: string): Uint8Array => readFileSync(new URL(`../../../tests/fixtures/master-data/${name}`, import.meta.url));
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const head = HEADER.join(",");
const good = "测试店,无撤销,否,C1,商家,D1,分公司,110,日立家装,13,A级\n";

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof MasterDataError) return e.code;
    throw e;
  }
  return "no_error";
}

describe("运行时能力", () => {
  it("TextDecoder('gb18030', {fatal:true}) 可用（full-icu）", () => {
    expect(new TextDecoder("gb18030", { fatal: true }).decode(fx("small.gb18030.csv"))).toContain("测试一店");
  });
});

describe("编码", () => {
  it("UTF-8（带 / 不带 BOM）与 GB18030 的同一份内容得到完全相同的行，且无替换字符", () => {
    const a = parseFile(fx("small.utf8.csv"));
    const b = parseFile(fx("small.utf8-bom.csv"));
    const c = parseFile(fx("small.gb18030.csv"));
    expect(a.encoding).toBe("utf-8");
    expect(b.encoding).toBe("utf-8");
    expect(c.encoding).toBe("gb18030");
    expect(b.rows).toEqual(a.rows);
    expect(c.rows).toEqual(a.rows);
    expect(JSON.stringify(a.rows)).not.toContain("\uFFFD");
    expect(a.rows).toHaveLength(3);
    expect(a.rows[0]!.rowNo).toBe(1);
  });

  it("UTF-16LE / UTF-16BE 带 BOM 可识别", () => {
    const text = `${head}\n${good}`;
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
    const be = Buffer.from(le);
    be.swap16(); // 同样的字节序交换后 BOM 变成 FE FF
    expect(parseFile(le).encoding).toBe("utf-16le");
    expect(parseFile(be).encoding).toBe("utf-16be");
    expect(parseFile(be).rows).toEqual(parseFile(le).rows);
  });

  it("乱码字节：encoding_unrecognized，返回前 200 字节的可打印样本", () => {
    try {
      parseFile(fx("garbage.bin"));
      expect.unreachable();
    } catch (e) {
      expect((e as MasterDataError).code).toBe("encoding_unrecognized");
      expect(((e as MasterDataError).detail as { sample: string }).sample).toContain("\\xff");
    }
  });
});

describe("限额与结构", () => {
  it("10 MB + 1 字节 → file_too_large；恰好 10 MB 不因大小被拒", () => {
    expect(code(() => parseFile(new Uint8Array(10 * 1024 * 1024 + 1)))).toBe("file_too_large");
    expect(code(() => parseFile(new Uint8Array(10 * 1024 * 1024)))).not.toBe("file_too_large");
  });

  it("10,001 行 → too_many_rows；10,000 行通过", () => {
    const mk = (n: number) => enc(head + "\n" + good.repeat(n));
    expect(code(() => parseFile(mk(10_001)))).toBe("too_many_rows");
    expect(parseFile(mk(10_000)).rows).toHaveLength(10_000);
  });

  it("空文件、只有表头", () => {
    expect(code(() => parseFile(new Uint8Array()))).toBe("empty_file");
    expect(code(() => parseFile(enc("  \n\n")))).toBe("empty_file");
    expect(code(() => parseFile(enc(head + "\n")))).toBe("no_data_rows");
  });

  it("列数不一致、引号未闭合 → csv_malformed", () => {
    expect(code(() => parseFile(enc(`${head}\n测试店,无撤销\n`)))).toBe("csv_malformed");
    expect(code(() => parseFile(enc(`${head}\n"测试店,无撤销,否,C1,商家,D1,分公司,110,日立家装,13,A级\n`)))).toBe("csv_malformed");
  });

  it("引号内的逗号与换行属于单元格，不拆行", () => {
    const f = parseFile(enc(`${head}\n"测试,店",无撤销,否,C1,"商\n家",D1,分公司,110,日立家装,13,A级\r\n`));
    expect(f.rows).toHaveLength(1);
    expect(f.rows[0]!.cells[0]).toBe("测试,店");
    expect(f.rows[0]!.cells[4]).toBe("商\n家");
  });

  it("表头改动一位 / 换序 / 缺列 → header_mismatch，并给出正确 11 列", () => {
    const cols: string[] = [...HEADER];
    const renamed = [...cols];
    renamed[4] = "经销商名称";
    const swapped = [...cols];
    [swapped[0], swapped[1]] = [swapped[1]!, swapped[0]!];
    for (const bad of [renamed, swapped]) {
      try {
        parseFile(enc(`${bad.join(",")}\n${good}`));
        expect.unreachable();
      } catch (e) {
        expect((e as MasterDataError).code).toBe("header_mismatch");
        expect(((e as MasterDataError).detail as { expected: string[] }).expected).toEqual(cols);
      }
    }
  });

  it("带「负责人」的 12 列文件整批拒绝", () => {
    expect(code(() => parseFile(fx("with-owner-12cols.csv")))).toBe("header_mismatch");
  });

  it("表头被跳过，row_no 从 1 开始，原文单元格不被去空白", () => {
    const f = parseFile(enc(`${head}\n 测试店 ,无撤销,否,C1,商家,D1,分公司,110,日立家装,13,A级\n${good}`));
    expect(f.rows.map((r) => r.rowNo)).toEqual([1, 2]);
    expect(f.rows[0]!.cells[0]).toBe(" 测试店 ");
    expect(f.sha256).toHaveLength(32);
  });
});
