// 文件级校验（design §7.1）：大小 → 编码 → 严格 CSV → 11 列表头 → 行数。任一步失败即抛 MasterDataError，不建批次。
// 编码判定与 CSV 解析已抽取到 src/modules/csv-file（只有该模块依赖 csv-parse，ADR-0014）；本文件保留主数据自己的表头与错误类型。
import { CsvFileError, parseCsv, type ParsedCsv, type ParseLimits } from "../csv-file";
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

export type { ParseLimits };
export const DEFAULT_LIMITS: ParseLimits = { maxBytes: 10 * 1024 * 1024, maxRows: 10_000 };
export type ParsedFile = ParsedCsv;
export { printableSample } from "../csv-file";

export function parseFile(bytes: Uint8Array, limits: ParseLimits = DEFAULT_LIMITS): ParsedFile {
  try {
    return parseCsv(bytes, { header: HEADER, limits });
  } catch (e) {
    if (e instanceof CsvFileError) throw new MasterDataError("input", e.code, e.message, e.detail);
    throw e;
  }
}
