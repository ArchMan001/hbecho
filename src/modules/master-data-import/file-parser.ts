// 文件级校验（design §7.1）：大小 → 编码 → 严格 CSV → 11 列表头 → 行数。任一步失败即抛 MasterDataError，不建批次。
// 编码判定自己做（BOM → 严格 UTF-8 → 严格 GB18030），CSV 解析交给 csv-parse（ADR-0014）；只有本文件依赖 csv-parse。
import { createHash } from "node:crypto";
import { CsvError, parse } from "csv-parse/sync";
import { MasterDataError } from "./errors";

export const HEADER = [
  "门店名称",
  "撤店情况",
  "是否数字门店",
  "门店编码",
  "门店所属商家",
  "门店所属商家渠道编码",
  "所属分公司",
  "分公司编码",
  "主营业务",
  "主营业务编码",
  "店面标准",
] as const;

export interface ParseLimits {
  maxBytes: number;
  maxRows: number;
}
export const DEFAULT_LIMITS: ParseLimits = { maxBytes: 10 * 1024 * 1024, maxRows: 10_000 };

export interface ParsedFile {
  encoding: "utf-8" | "gb18030" | "utf-16le" | "utf-16be";
  sha256: Buffer;
  /** 表头之后的数据行；rowNo 从 1 开始。cells 保存原文（不去空白）。 */
  rows: Array<{ rowNo: number; cells: string[] }>;
}

/** 前 200 字节的可打印表示：可打印 ASCII 原样，其余 \xNN。 */
export function printableSample(bytes: Uint8Array, n = 200): string {
  let out = "";
  for (const b of bytes.subarray(0, n)) out += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : `\\x${b.toString(16).padStart(2, "0")}`;
  return out;
}

function decode(bytes: Uint8Array): { text: string; encoding: ParsedFile["encoding"] } {
  const bom3 = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const tryDecode = (label: string): string | undefined => {
    try {
      return new TextDecoder(label, { fatal: true }).decode(bytes); // 默认会剥掉 BOM
    } catch {
      return undefined;
    }
  };
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    const t = tryDecode("utf-16le");
    if (t !== undefined) return { text: t, encoding: "utf-16le" };
  } else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const t = tryDecode("utf-16be");
    if (t !== undefined) return { text: t, encoding: "utf-16be" };
  } else {
    const u = tryDecode("utf-8");
    if (u !== undefined) return { text: u, encoding: "utf-8" };
    if (!bom3) {
      const g = tryDecode("gb18030"); // ADR-0005：依赖 full-icu；fatal 必须开
      if (g !== undefined) return { text: g, encoding: "gb18030" };
    }
  }
  throw new MasterDataError("input", "encoding_unrecognized", "无法识别文件编码（支持 UTF-8 / GB18030，请另存为 UTF-8 CSV）", {
    sample: printableSample(bytes),
  });
}

export function parseFile(bytes: Uint8Array, limits: ParseLimits = DEFAULT_LIMITS): ParsedFile {
  if (bytes.length > limits.maxBytes) {
    throw new MasterDataError("input", "file_too_large", `文件超过 ${limits.maxBytes} 字节上限`, { bytes: bytes.length });
  }
  if (bytes.length === 0) throw new MasterDataError("input", "empty_file", "文件为空");
  const { text, encoding } = decode(bytes);
  if (text.trim() === "") throw new MasterDataError("input", "empty_file", "文件为空");

  let records: string[][];
  try {
    records = parse(text, {
      relax_column_count: false, // 列数必须与首行一致
      relax_quotes: false, // 引号必须闭合、不能出现在未加引号的字段中间
      skip_empty_lines: true,
      bom: false,
    }) as string[][];
  } catch (e) {
    if (e instanceof CsvError) {
      throw new MasterDataError("input", "csv_malformed", `CSV 结构不合法：${e.code}${e.lines ? `（第 ${e.lines} 行附近）` : ""}`, { csvCode: e.code });
    }
    throw e;
  }

  const header = records[0] ?? [];
  if (header.length !== HEADER.length || header.some((h, i) => h !== HEADER[i])) {
    throw new MasterDataError("input", "header_mismatch", "表头必须逐列等于下面 11 列（列名、顺序、列数都不能变）", {
      expected: [...HEADER],
      got: header,
    });
  }
  const data = records.slice(1);
  if (data.length === 0) throw new MasterDataError("input", "no_data_rows", "表头之后没有数据行");
  if (data.length > limits.maxRows) {
    throw new MasterDataError("input", "too_many_rows", `数据行超过 ${limits.maxRows} 行上限，请拆分文件`, { rows: data.length });
  }
  return {
    encoding,
    sha256: createHash("sha256").update(bytes).digest(),
    rows: data.map((cells, i) => ({ rowNo: i + 1, cells })),
  };
}
