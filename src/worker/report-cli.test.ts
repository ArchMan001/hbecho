import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { AuthContext } from "../modules/access-control";
import { ReportError, type ReportDetail } from "../modules/report-detail";
import { runReportCli, type ReportCliDeps } from "./report-cli";

const ctx = { kind: "user", actor: "user:7" } as unknown as AuthContext;
const header = { planAlias: "计划", executionId: "11", videosAvailable: true, abilityResultsAvailable: true };
const cols = (...h: string[]) => h.map((header) => ({ key: header, header, kind: "fixed" as const }));
function harness(over: Partial<Record<"overview" | "view" | "prepareExport" | "startExport", unknown>> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: unknown[] = [];
  const fs = { opened: [] as string[], renamed: [] as Array<[string, string]>, removed: [] as string[] };
  const report = {
    overview: async () => [{ planId: "1", alias: "计划" }],
    view: async (_c: unknown, _p: string, a: { tab: string }) => (calls.push(a), { header, table: { columns: cols(a.tab === "videos" ? "品牌" : "粉丝数") } }),
    exportPreview: async () => ({}),
    prepareExport: async (_c: unknown, _p: string, a: unknown) => (calls.push(a), { plan: { fileName: "x-全量明细.xlsx", warnings: ["videos_pruned"], videoRows: 0, accountRows: 1 } }),
    startExport: async (_p: unknown, sink: Writable) => { sink.end("xlsx-bytes"); return { rowsBySheet: { 账号维度: 1 } }; },
    ...over,
  } as unknown as ReportDetail;
  const deps: ReportCliDeps = {
    report, ctx, stdout: (t) => out.push(t), stderr: (t) => err.push(t),
    openOut: (p) => (fs.opened.push(p), new Writable({ write(_c, _e, cb) { cb(); } })),
    rename: async (a, b) => void fs.renamed.push([a, b]), remove: async (p) => void fs.removed.push(p),
  };
  const run = async (...argv: string[]) => ({ code: await runReportCli(argv, deps), json: out.length ? JSON.parse(out.at(-1)!) : null, err, calls, fs });
  return run;
}
describe("pnpm report", () => {
  it("list：输出范围内的判定计划", async () => {
    const r = await harness()("list");
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ ok: true, plans: [{ planId: "1" }] });
  });
  it("columns：两张表的表头；--run 与筛选原样传给 Module", async () => {
    const r = await harness()("columns", "--plan", "1", "--run", "11");
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ ok: true, videos: ["品牌"], accounts: ["粉丝数"] });
    expect(r.calls[0]).toMatchObject({ executionId: "11" });
  });
  it("export：先写 .part，成功后改名为目标文件；输出文件名、行数、警告", async () => {
    const r = await harness()("export", "--plan", "1", "--out", "/tmp/a.xlsx", "--branch", "4", "--q", "老孙");
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ ok: true, file: "/tmp/a.xlsx", fileName: "x-全量明细.xlsx", warnings: ["videos_pruned"] });
    expect(r.fs.opened).toEqual(["/tmp/a.xlsx.part"]);
    expect(r.fs.renamed).toEqual([["/tmp/a.xlsx.part", "/tmp/a.xlsx"]]);
    expect(r.calls[0]).toMatchObject({ filter: { branchId: "4", staffQuery: "老孙" } });
  });
  it("export 失败（如行数超限）：不留半份文件，退出码 3", async () => {
    const run = harness({ startExport: async () => { throw new ReportError("conflict", "export_row_limit", "行数超过导出上限"); } });
    const r = await run("export", "--plan", "1", "--out", "/tmp/a.xlsx");
    expect(r.code).toBe(3);
    expect(r.json).toMatchObject({ ok: false, error: { code: "export_row_limit" } });
    expect(r.fs.removed).toEqual(["/tmp/a.xlsx.part"]);
    expect(r.fs.renamed).toEqual([]);
  });
  it("授权 → 2；不存在 → 4；输入错误 → 2；未知命令与缺参数 → 2；内部错误 → 1 且细节只在 stderr", async () => {
    const code = async (e: unknown) => (await harness({ prepareExport: async () => { throw e; } })("export", "--plan", "1", "--out", "/tmp/a")).code;
    expect(await code(new ReportError("auth", "capability_not_granted", "没有权限"))).toBe(2);
    expect(await code(new ReportError("not_found", "plan_not_found", "找不到"))).toBe(4);
    expect(await code(new ReportError("input", "invalid_filter", "筛选无效"))).toBe(2);
    const bad = await harness()("nope");
    expect(bad.code).toBe(2);
    expect((await harness()("columns")).code).toBe(2);
    expect((await harness()("export", "--plan", "1")).code).toBe(2);
    expect((await harness()("export", "--plan", "1", "--out", "/tmp/a", "--zzz", "1")).code).toBe(2);
    const internal = await harness({ prepareExport: async () => { throw new Error("db_down 内部细节"); } })("export", "--plan", "1", "--out", "/tmp/a");
    expect(internal.code).toBe(1);
    expect(JSON.stringify(internal.json)).not.toContain("内部细节");
    expect(internal.err.join("")).toContain("db_down");
  });
});
