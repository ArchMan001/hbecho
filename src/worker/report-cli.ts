// CLI：`pnpm report <命令>`（e-metrics-lite T7）。页面确认之前、以及 ECS 上核对时用：不开浏览器就能看列头、导出一份文件。
// 只调用 Module，不直接读写库；权限只来自环境变量里的用户身份（沿用 HBECHO_JP_ACTOR=user:<id>，与 `pnpm judgement` 同一个入口），
// 走与页面相同的 authorize；没有任何旁路。退出码与 judgement-cli 同一套：0 成功 / 2 输入、授权 / 3 冲突 / 4 不存在 / 1 其他。
import { createWriteStream } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { parseArgs } from "node:util";
import type { Writable } from "node:stream";
import type { AuthContext } from "../modules/access-control";
import { isReportError, type ReportDetail, type ReportError, type ReportFilterInput } from "../modules/report-detail";

export interface ReportCliDeps {
  report: Pick<ReportDetail, "overview" | "view" | "exportPreview" | "prepareExport" | "startExport">;
  ctx: AuthContext;
  /** 打开输出文件（测试注入内存写入器）；先写 <out>.part，成功后改名，失败删除，不留半份文件 */
  openOut?: (path: string) => Writable;
  rename?: (from: string, to: string) => Promise<void>;
  remove?: (path: string) => Promise<void>;
  stdout(text: string): void;
  stderr(text: string): void;
}
const USAGE = [
  "用法：",
  "  report list                                              # 范围内可见的判定计划与最近一次完成的执行",
  "  report columns --plan <id> [--run <执行id>]              # 视频明细与账号维度的表头（含能力列）",
  "  report export --plan <id> --out <文件.xlsx> [--run <执行id>] [--region <id>] [--branch <id>] [--sector <id>] [--store <id>] [--q <专员姓名/门店编码>]",
].join("\n");
const exitOf = (e: ReportError): number => (e.kind === "auth" || e.kind === "input" ? 2 : e.kind === "conflict" ? 3 : e.kind === "not_found" ? 4 : 1);
const sanitize = (_k: string, x: unknown) => (typeof x === "bigint" ? x.toString() : x);

export async function runReportCli(argv: string[], deps: ReportCliDeps): Promise<number> {
  const { report, ctx } = deps;
  const print = (v: unknown) => deps.stdout(`${JSON.stringify(v, sanitize)}\n`);
  const fail = (code: string, message: string, exit: number): number => (print({ ok: false, error: { code, message } }), exit);
  const [cmd, ...rest] = argv;
  try {
    if (cmd === "list") {
      print({ ok: true, plans: await report.overview(ctx) });
      return 0;
    }
    const { values } = parseArgs({ args: rest, strict: true, allowPositionals: false, options: { plan: { type: "string" }, run: { type: "string" }, out: { type: "string" }, region: { type: "string" }, branch: { type: "string" }, sector: { type: "string" }, store: { type: "string" }, q: { type: "string" } } });
    if (!values.plan) return fail("invalid_input", `需要 --plan\n${USAGE}`, 2);
    const filter: ReportFilterInput = { ...(values.region ? { regionId: values.region } : {}), ...(values.branch ? { branchId: values.branch } : {}), ...(values.sector ? { sectorId: values.sector } : {}), ...(values.store ? { storeId: values.store } : {}), ...(values.q ? { staffQuery: values.q } : {}) };
    const run = values.run ? { executionId: values.run } : {};
    if (cmd === "columns") {
      const v = await report.view(ctx, values.plan, { tab: "videos", ...run, filter, page: 1 });
      const a = await report.view(ctx, values.plan, { tab: "accounts", ...run, filter, page: 1 });
      print({ ok: true, execution: v.header, videosAvailable: v.header.videosAvailable, abilityResultsAvailable: v.header.abilityResultsAvailable, videos: v.table.columns.map((c) => c.header), accounts: a.table.columns.map((c) => c.header) });
      return 0;
    }
    if (cmd === "export") {
      if (!values.out) return fail("invalid_input", `需要 --out\n${USAGE}`, 2);
      const prep = await report.prepareExport(ctx, values.plan, { ...run, filter });
      const part = `${values.out}.part`;
      const sink = deps.openOut ? deps.openOut(part) : createWriteStream(part);
      const finished = new Promise<void>((res, rej) => { sink.once("finish", res); sink.once("error", rej); });
      try {
        const r = await report.startExport(prep, sink);
        await finished;
        await (deps.rename ?? rename)(part, values.out);
        print({ ok: true, file: values.out, fileName: prep.plan.fileName, rows: r.rowsBySheet, warnings: prep.plan.warnings });
        return 0;
      } catch (e) {
        sink.destroy();
        await (deps.remove ?? ((p: string) => rm(p, { force: true })))(part);
        throw e;
      }
    }
    return fail("invalid_input", `不认识的命令：${cmd ?? "(空)"}\n${USAGE}`, 2);
  } catch (e) {
    if (isReportError(e)) return fail(e.code, e.message, exitOf(e));
    if (e instanceof TypeError && /Unknown option|argument/i.test(e.message)) return fail("invalid_input", `${e.message}\n${USAGE}`, 2);
    deps.stderr(`${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
    return fail("internal_error", "内部错误，详情见 stderr", 1);
  }
}
