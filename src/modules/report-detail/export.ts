// Excel 写出（requirements EL-8；ADR-0011：只用 exceljs 的**写入** API，生产代码里不得出现任何读取 xlsx 的调用）。
// 流式写入器：逐行 commit，内存与「一批行」而不是全表成正比；不嵌图片、不写图片链接。
import type { Writable } from "node:stream";
import ExcelJS from "exceljs";
import { safeText } from "./cells";
import type { ColumnDef, Tone, ViewRow } from "./types";

export interface SheetSpec {
  name: string;
  columns: ColumnDef[];
  rows: AsyncIterable<ViewRow>;
}
const TONE_COLOR: Partial<Record<Tone, string>> = { pass: "FF1B7F3B", fail: "FFC0362C", unobtained: "FF8A8F98", skipped: "FFB5BAC2" };
/** 内容 ID、门店编码等必须是文本单元格：19 位 ID 否则会被科学计数法吞掉精度。 */
const TEXT_KEYS = new Set(["contentId", "storeCode"]);
const WIDTHS: Record<string, number> = { title: 44, url: 34, homeUrl: 34, contentId: 22, dealer: 28, store: 28, nickname: 26 };
// ponytail: 列宽只按表头与已知长列估算，不扫描内容（流式写入器要在第一行之前定列宽）；要按内容自适应就得缓存首批行。
const widthOf = (c: ColumnDef): number => WIDTHS[c.key] ?? Math.min(48, Math.max(10, [...c.header].length * 2 + 2));
/** Excel 单元格上限 32767 字符；超出截断并加省略号（标题等长文本）。 */
const clip = (s: string): string => (s.length > 32000 ? `${s.slice(0, 32000)}…` : s);

export interface ExportResult {
  rowsBySheet: Record<string, number>;
}
/** 写出多个 sheet；任一行源抛错则整个写出中止（调用方负责终止连接，不留一份「看起来完整」的文件）。 */
export async function writeWorkbook(sink: Writable, sheets: readonly SheetSpec[]): Promise<ExportResult> {
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: sink, useStyles: true, useSharedStrings: false });
  const rowsBySheet: Record<string, number> = {};
  for (const sheet of sheets) {
    const ws = wb.addWorksheet(sheet.name, { views: [{ state: "frozen", ySplit: 1 }] });
    ws.columns = sheet.columns.map((c) => ({ header: c.header, key: c.key, width: widthOf(c), ...(TEXT_KEYS.has(c.key) ? { style: { numFmt: "@" } } : {}) }));
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).commit();
    let n = 0;
    for await (const r of sheet.rows) {
      const row = ws.addRow(sheet.columns.map((c) => {
        const cell = r.cells[c.key];
        if (!cell) return "";
        return cell.num !== undefined ? cell.num : clip(safeText(cell.text));
      }));
      sheet.columns.forEach((c, i) => {
        const color = TONE_COLOR[r.cells[c.key]?.tone ?? "plain"];
        if (color) row.getCell(i + 1).font = { color: { argb: color } };
      });
      row.commit();
      n++;
    }
    rowsBySheet[sheet.name] = n;
    ws.commit();
  }
  await wb.commit();
  return { rowsBySheet };
}
/** 文件名：`<活动计划名>-<判定计划别名>-<执行完成日期>-全量明细.xlsx`；非法字符替换为 `_`，过长截断。 */
export function exportFileName(activityPlanName: string, planAlias: string, completedDate: string): string {
  const bad = /[\\/:*?"<>|\u0000-\u001f]/g;
  const part = (s: string) => [...s.replace(bad, "_").trim()].slice(0, 40).join("");
  return `${part(activityPlanName)}-${part(planAlias)}-${completedDate}-全量明细.xlsx`;
}
