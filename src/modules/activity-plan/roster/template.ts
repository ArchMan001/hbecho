// 名单模板与文件级校验（requirements AP-5）：大小 → 编码 → CSV 结构 → 表头逐列一致 → 行数。
// 模板版本 roster-import.v1 就是「表头四列逐列一致」（4 列 CSV 没有地方放独立版本单元格，design AP-D12）：
// 表头不一致报「模板版本不符，请重新下载」；一致则自动跳过表头；与示例行逐格相同的行标为示例行，不进入数据。
// 单元格按文本保留（不去空白、不转数字）：门店编码和手机号的前导零不能丢。
import { buildCsv, CsvFileError, parseCsv } from "../../csv-file";
import { EXAMPLE_ROW, MAX_FILE_BYTES, MAX_ROWS, ROSTER_HEADER, TEMPLATE_VERSION } from "../constants";
import { PlanError } from "../errors";

/** 模板说明（随模板一起提供给业务）：两个最常见的坑。 */
export const TEMPLATE_GUIDE = [
  "1. 在 Excel 里编辑后，必须「另存为 CSV」再上传（xlsx 不能直接上传）。",
  "2. 「门店编码」「手机号」两列请先把整列设为「文本」格式再填写，否则前导零会丢失、手机号会变成科学计数法。",
  "3. 表头和示例行可以保留，系统会自动跳过；每位专员只填一行，一个专员对应一个主页链接。",
  "4. 主页链接必须是账号主页（不是视频或笔记），并且属于计划的平台。",
] as const;

/** 模板文件内容：带 BOM 的 UTF-8、CRLF，表头 + 一行示例。 */
export const buildTemplate = (): string => buildCsv(ROSTER_HEADER, [EXAMPLE_ROW]);

export interface ParsedRoster {
  encoding: string;
  sha256: Buffer;
  /** 数据行；rowNo 是表头之后的文件行号（从 1 起，示例行占位但不出现在这里）。cells 是原文。 */
  rows: Array<{ rowNo: number; cells: string[] }>;
  /** 被识别为示例行的行号。 */
  exampleRowNos: number[];
}

export function parseRosterFile(bytes: Uint8Array): ParsedRoster {
  let parsed;
  try {
    parsed = parseCsv(bytes, { header: ROSTER_HEADER, limits: { maxBytes: MAX_FILE_BYTES, maxRows: MAX_ROWS + 1 } }); // +1：示例行不占数据行上限，过滤后再检查
  } catch (e) {
    if (e instanceof CsvFileError) {
      const message = e.code === "header_mismatch" ? `模板版本不符（${TEMPLATE_VERSION}），请重新下载模板：表头必须逐列等于「${ROSTER_HEADER.join("、")}」` : e.message;
      throw new PlanError("input", e.code, message, e.detail);
    }
    throw e;
  }
  const isExample = (cells: string[]): boolean => cells.length === EXAMPLE_ROW.length && cells.every((c, i) => c === EXAMPLE_ROW[i]);
  const exampleRowNos = parsed.rows.filter((r) => isExample(r.cells)).map((r) => r.rowNo);
  const rows = parsed.rows.filter((r) => !isExample(r.cells));
  if (rows.length > MAX_ROWS) throw new PlanError("input", "too_many_rows", `数据行超过 ${MAX_ROWS} 行上限，请拆分文件`, { rows: rows.length });
  if (rows.length === 0) throw new PlanError("input", "no_data_rows", "除表头和示例行外没有数据行");
  return { encoding: parsed.encoding, sha256: parsed.sha256, rows, exampleRowNos };
}
