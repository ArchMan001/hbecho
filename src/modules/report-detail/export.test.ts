import { PassThrough } from "node:stream";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { exportFileName, writeWorkbook, type SheetSpec } from "./export";
import type { ColumnDef, ViewRow } from "./types";

const cols: ColumnDef[] = [
  { key: "contentId", header: "视频/图文唯一ID", kind: "fixed" },
  { key: "title", header: "视频/图文标题", kind: "fixed" },
  { key: "like", header: "点赞", kind: "fixed" },
  { key: "l1.0", header: "品牌词", kind: "condition", conditionKey: "l1.0" },
];
const row = (o: Partial<Record<string, ViewRow["cells"][string]>>): ViewRow => ({ cells: o as ViewRow["cells"], images: { cover: "https://signed.example/x" } });
async function* gen(rs: ViewRow[]) { for (const r of rs) yield r; }
async function roundtrip(sheets: SheetSpec[]) {
  const sink = new PassThrough();
  const chunks: Buffer[] = [];
  sink.on("data", (c) => chunks.push(c));
  const done = new Promise<void>((res, rej) => { sink.on("end", res); sink.on("error", rej); });
  const result = await writeWorkbook(sink, sheets);
  await done;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.concat(chunks) as unknown as ExcelJS.Buffer); // 只在测试里读自己刚写出的文件；生产代码零 xlsx.read / xlsx.load
  return { wb, result, bytes: Buffer.concat(chunks) };
}
describe("writeWorkbook", () => {
  it("两个 sheet、表头一行、冻结首行；行数与内容一致；空 sheet 仍有表头", async () => {
    const { wb, result } = await roundtrip([
      { name: "视频明细", columns: cols, rows: gen([row({ contentId: { text: "1", tone: "plain" }, title: { text: "t", tone: "plain" }, like: { text: "3", tone: "plain", num: 3 }, "l1.0": { text: "日立", tone: "pass" } })]) },
      { name: "账号维度", columns: cols, rows: gen([]) },
    ]);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["视频明细", "账号维度"]);
    const ws = wb.getWorksheet("视频明细")!;
    expect(ws.getRow(1).values).toEqual([undefined, "视频/图文唯一ID", "视频/图文标题", "点赞", "品牌词"]);
    expect(ws.rowCount).toBe(2);
    expect(ws.getRow(2).getCell(3).value).toBe(3); // 数字单元格
    expect(ws.getRow(2).getCell(4).font?.color?.argb).toBe("FF1B7F3B");
    expect(ws.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });
    expect(wb.getWorksheet("账号维度")!.getRow(1).getCell(1).value).toBe("视频/图文唯一ID");
    expect(result.rowsBySheet).toEqual({ 视频明细: 1, 账号维度: 0 });
  });
  it("19 位内容 ID 往返不丢位：写成文本单元格", async () => {
    const id = "7703376750574989926";
    const { wb } = await roundtrip([{ name: "s", columns: cols, rows: gen([row({ contentId: { text: id, tone: "plain" } })]) }]);
    const v = wb.getWorksheet("s")!.getRow(2).getCell(1).value;
    expect(v).toBe(id);
    expect(typeof v).toBe("string");
  });
  it("公式注入：以 = + - @ 开头的文本加前缀；数字单元格不加", async () => {
    const { wb } = await roundtrip([{ name: "s", columns: cols, rows: gen([row({ title: { text: "=HYPERLINK(\"http://x\")", tone: "plain" }, like: { text: "-5", tone: "plain", num: 5 } })]) }]);
    const r = wb.getWorksheet("s")!.getRow(2);
    expect(r.getCell(2).value).toBe("'=HYPERLINK(\"http://x\")");
    expect(r.getCell(3).value).toBe(5);
  });
  it("没有图片：工作簿里零个图片对象，行里的图片链接也不写出", async () => {
    const { wb, bytes } = await roundtrip([{ name: "s", columns: cols, rows: gen([row({ title: { text: "t", tone: "plain" } })]) }]);
    expect(wb.model.media ?? []).toHaveLength(0);
    expect(bytes.includes(Buffer.from("signed.example"))).toBe(false);
    expect(bytes.includes(Buffer.from("xl/media/"))).toBe(false);
  });
  it("超长文本截断到 Excel 的单元格上限以内", async () => {
    const { wb } = await roundtrip([{ name: "s", columns: cols, rows: gen([row({ title: { text: "长".repeat(40000), tone: "plain" } })]) }]);
    expect(String(wb.getWorksheet("s")!.getRow(2).getCell(2).value).length).toBeLessThanOrEqual(32001);
  });
  it("行源中途抛错 → 写出中止并向上抛（不留一份看起来完整的文件）", async () => {
    async function* boom(): AsyncGenerator<ViewRow> { yield row({}); throw new Error("db_down"); }
    const sink = new PassThrough();
    sink.resume();
    await expect(writeWorkbook(sink, [{ name: "s", columns: cols, rows: boom() }])).rejects.toThrow("db_down");
  });
});
describe("exportFileName", () => {
  it("<活动计划名>-<判定计划别名>-<完成日期>-全量明细.xlsx；非法字符替换为 _", () => {
    expect(exportFileName("双11 种草挑战", "种草视频判定 · 抖音", "2026-11-18")).toBe("双11 种草挑战-种草视频判定 · 抖音-2026-11-18-全量明细.xlsx");
    expect(exportFileName('a/b:c*d?"e<f>g|h\\i', "x", "2026-11-18")).toBe("a_b_c_d__e_f_g_h_i-x-2026-11-18-全量明细.xlsx");
  });
});
