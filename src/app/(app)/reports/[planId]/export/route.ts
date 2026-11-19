// 导出：GET ?preview=1 返回预览 JSON（文件名、行数、警告、表头）；否则流式返回 .xlsx（两个 sheet，无图）。
// 授权与出口守卫（出口 4，记审计）、行数上限、并发上限都在 report-detail 模块里；这里只做 HTTP 映射。
// 范围按提交这一刻的会话：撤权 / 范围收缩后下一次请求就按新范围；没有「先排队、以后再生成」的路径。
import { headers } from "next/headers";
import { PassThrough, Readable } from "node:stream";
import pino from "pino";
import { isReportError, type ReportError, type ReportFilterInput } from "../../../../../modules/report-detail";
import { reportQueryOf, toFilter, parseId } from "../../../../_lib/report-url";
import { reports } from "../../../../_lib/reports";
import { web } from "../../../../_lib/session";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const log = pino({ name: "report-export" }, pino.destination(2));
const STATUS: Record<string, number> = { auth: 403, not_found: 404, input: 400, unavailable: 503 };
const statusOf = (e: ReportError): number => (e.code === "export_busy" ? 429 : (STATUS[e.kind] ?? 409));
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

export async function GET(req: Request, { params }: { params: Promise<{ planId: string }> }) {
  const r = await web().authenticate(await headers());
  if (!r.ok) return json(r.kind === "unavailable" ? 503 : 401, { code: r.kind === "unavailable" ? "auth_unavailable" : "unauthenticated" });
  const ctx = r.ctx;
  const { planId } = await params;
  if (!parseId(planId)) return json(404, { code: "plan_not_found", message: "找不到这个判定计划" });
  const url = new URL(req.url);
  const q = reportQueryOf(Object.fromEntries(url.searchParams));
  const args: { executionId?: string; filter: ReportFilterInput } = { ...(q.run ? { executionId: q.run } : {}), filter: toFilter(q) };
  try {
    if (url.searchParams.get("preview") === "1") return json(200, await reports().exportPreview(ctx, planId, args));
    const prep = await reports().prepareExport(ctx, planId, args);
    const sink = new PassThrough();
    const done = reports().startExport(prep, sink); // 并发已满在这里同步抛 export_busy：此时还没有字节
    done.then(
      (res) => log.info({ planId, execution: prep.exec.executionId.toString(), rows: res.rowsBySheet }, "export_done"),
      (e) => {
        log.error({ planId, execution: prep.exec.executionId.toString(), err: String(e) }, "export_failed");
        sink.destroy(e instanceof Error ? e : new Error(String(e))); // 中途失败：终止连接，客户端得到下载失败而不是一份「看起来完整」的文件
      },
    );
    const name = prep.plan.fileName;
    return new Response(Readable.toWeb(sink) as ReadableStream, {
      headers: {
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": `attachment; filename="report.xlsx"; filename*=UTF-8''${encodeURIComponent(name)}`,
        "cache-control": "no-store",
        ...(prep.plan.warnings.length ? { "x-report-warning": prep.plan.warnings.join(",") } : {}),
      },
    });
  } catch (e) {
    if (isReportError(e)) return json(statusOf(e), { code: e.code, message: e.message });
    log.error({ err: String(e) }, "export_error");
    return json(500, { code: "internal_error" });
  }
}
