// 能力服务 POST /v1/image/match 的 Node 客户端（design §7.8）。**signals 里唯一允许发网络请求的文件**（SG-16 护栏 ④）。
// 只做传输与错误分类：错误 → MatcherError(code, side)；是否重试、是否写 failed 结果行由任务 runner 按 code 与 side 决定。
// 错误消息统一脱敏（Python 的消息可能带签名 URL）；不记录请求里的 URL。
import { z } from "zod";
import { redactUrls } from "../redact";
import { MatcherError, type ImageMatcher, type MatchRequest, type MatchResult, type MatcherErrorCode } from "./ports";

const success = z.object({
  score: z.number().min(0).max(10),
  capability: z.object({ id: z.string().min(1), version: z.number().int().positive() }),
  evidence: z.record(z.string(), z.unknown()),
});
const errorBody = z.object({ code: z.string(), message: z.string().optional(), side: z.enum(["reference", "candidate"]).optional() });
const KNOWN: ReadonlySet<string> = new Set<MatcherErrorCode>(["invalid_request", "input_too_large", "unsupported_media_type", "convert_failed", "source_missing", "source_unavailable"]);

export interface HttpImageMatcherOptions {
  baseUrl: string;
  timeoutMs: number;
  /** 测试注入点；缺省用全局 fetch。 */
  fetch?: typeof fetch;
}

export class HttpImageMatcher implements ImageMatcher {
  constructor(private readonly opts: HttpImageMatcherOptions) {}

  async match(req: MatchRequest): Promise<MatchResult> {
    const doFetch = this.opts.fetch ?? fetch;
    let res: Response;
    try {
      res = await doFetch(new URL("/v1/image/match", this.opts.baseUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reference_url: req.referenceUrl, candidate_url: req.candidateUrl, mode: req.mode, max_bytes: req.maxBytes }),
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
    } catch (e) {
      const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      throw new MatcherError(timedOut ? "timeout" : "unavailable", timedOut ? "能力服务请求超时" : `能力服务不可用：${redactUrls(e instanceof Error ? e.message : String(e))}`);
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new MatcherError("unavailable", `能力服务返回了无法解析的响应（HTTP ${res.status}）`); // 反向代理的错误页等：按瞬时处理
    }
    if (res.ok) {
      const ok = success.safeParse(json);
      if (!ok.success) throw new MatcherError("unavailable", "能力服务的成功响应不符合契约");
      return ok.data;
    }
    const err = errorBody.safeParse(json);
    if (!err.success || !KNOWN.has(err.data.code)) throw new MatcherError("unavailable", `能力服务返回了未知错误（HTTP ${res.status}）`);
    throw new MatcherError(err.data.code as MatcherErrorCode, redactUrls(err.data.message ?? err.data.code), err.data.side);
  }
}
