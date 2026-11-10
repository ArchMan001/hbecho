// CSV 文件的通用处理：编码识别、严格解析、回流单元格转义（从 master-data-import 抽取；a-activity-plan design §10.1）。
// 只有本模块依赖 csv-parse（ADR-0014）。业务无关：不知道表头长什么样，也不知道错误如何呈现，
// 失败抛 CsvFileError，调用方按自己的错误体系包装。
import { createHash } from "node:crypto";
import { CsvError, parse } from "csv-parse/sync";

export type CsvFileErrorCode = "file_too_large" | "empty_file" | "encoding_unrecognized" | "csv_malformed" | "header_mismatch" | "no_data_rows" | "too_many_rows";

export class CsvFileError extends Error {
  constructor(
    readonly code: CsvFileErrorCode,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "CsvFileError";
  }
}

export interface ParseLimits {
  maxBytes: number;
  maxRows: number;
}

export interface ParsedCsv {
  encoding: "utf-8" | "gb18030" | "utf-16le" | "utf-16be";
  sha256: Buffer;
  /** 表头之后的数据行；rowNo 从 1 开始。cells 保存原文（不去空白）。 */
  rows: Array<{ rowNo: number; cells: string[] }>;
}

/** 前 n 字节的可打印表示：可打印 ASCII 原样，其余 \xNN。 */
export function printableSample(bytes: Uint8Array, n = 200): string {
  let out = "";
  for (const b of bytes.subarray(0, n)) out += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : `\\x${b.toString(16).padStart(2, "0")}`;
  return out;
}

/** BOM → 严格 UTF-8 → 严格 GB18030（ADR-0005：fatal 必须开）。 */
export function decodeText(bytes: Uint8Array): { text: string; encoding: ParsedCsv["encoding"] } {
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
      const g = tryDecode("gb18030");
      if (g !== undefined) return { text: g, encoding: "gb18030" };
    }
  }
  throw new CsvFileError("encoding_unrecognized", "无法识别文件编码（支持 UTF-8 / GB18030，请另存为 UTF-8 CSV）", { sample: printableSample(bytes) });
}

/** 文件级校验：大小 → 编码 → 严格 CSV → 表头逐列一致 → 行数。任一步失败即抛 CsvFileError。 */
export function parseCsv(bytes: Uint8Array, opts: { header: readonly string[]; limits: ParseLimits }): ParsedCsv {
  const { header, limits } = opts;
  if (bytes.length > limits.maxBytes) {
    throw new CsvFileError("file_too_large", `文件超过 ${limits.maxBytes} 字节上限`, { bytes: bytes.length });
  }
  if (bytes.length === 0) throw new CsvFileError("empty_file", "文件为空");
  const { text, encoding } = decodeText(bytes);
  if (text.trim() === "") throw new CsvFileError("empty_file", "文件为空");
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
      throw new CsvFileError("csv_malformed", `CSV 结构不合法：${e.code}${e.lines ? `（第 ${e.lines} 行附近）` : ""}`, { csvCode: e.code });
    }
    throw e;
  }
  const got = records[0] ?? [];
  if (got.length !== header.length || got.some((h, i) => h !== header[i])) {
    throw new CsvFileError("header_mismatch", `表头必须逐列等于下面 ${header.length} 列（列名、顺序、列数都不能变）`, { expected: [...header], got });
  }
  const data = records.slice(1);
  if (data.length === 0) throw new CsvFileError("no_data_rows", "表头之后没有数据行");
  if (data.length > limits.maxRows) {
    throw new CsvFileError("too_many_rows", `数据行超过 ${limits.maxRows} 行上限，请拆分文件`, { rows: data.length });
  }
  return {
    encoding,
    sha256: createHash("sha256").update(bytes).digest(),
    rows: data.map((cells, i) => ({ rowNo: i + 1, cells })),
  };
}

/** 单元格以 = + - @ \t \r 开头加 ' 前缀（公式注入的展示保护，F-D11），含逗号 / 引号 / 换行时加引号转义。 */
export const csvCell = (v: string): string => {
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
};

/** 带 BOM 的 UTF-8、CRLF，Excel 直接打开不乱码。 */
export function buildCsv(header: readonly string[], rows: ReadonlyArray<readonly string[]>): string {
  const lines = [header.map(csvCell).join(","), ...rows.map((r) => r.map(csvCell).join(","))];
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}
