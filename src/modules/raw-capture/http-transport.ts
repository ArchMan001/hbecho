// 真实供应商 HTTP 传输（只给已批准的 smoke 与部署用）。
// 职责边界很窄：拼 URL、注入 X-Api-Key、把完整响应字节原样交回。
// **不做**重试、不解析 JSON、不判断业务成败——那些归 RawCaptureGateway 与版本化适配器。
// 错误信息里不出现 apiKey、完整请求头或请求体。
import { TransportFailure, type ProviderRequest, type ProviderResponse, type ProviderTransport } from "./ports";

export interface HttpTransportOptions {
  /** 例如 https://openapi.fieldshortcut.com；末尾斜杠可有可无。 */
  baseUrl: string;
  /** 只在构造时保存，只用于 X-Api-Key 请求头。 */
  apiKey: string;
  timeoutMs?: number;
  /** 测试注入点。 */
  fetchImpl?: typeof fetch;
}

// 90 秒：2026-11-06 真实 smoke 里快手同步的主页 / 列表调用有 19–27 秒的，30 秒时有 6 次超时变成 ambiguous（可能已计费但结果丢失）；
// 超时后调用只能当作结果不明，所以宁可多等，也不要让慢响应变成不明调用
const DEFAULT_TIMEOUT_MS = 90_000;

/** 有证据表明请求没到远端：可以安全地当作新 attempt 重试。 */
const NOT_DELIVERED_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ERR_INVALID_URL",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  // undici 的连接超时：TCP 都没建起来，请求字节一定没发出（与 UND_ERR_HEADERS_TIMEOUT 不同，后者已连接、结果未知）
  "UND_ERR_CONNECT_TIMEOUT",
]);

function causeCode(e: unknown): string | null {
  for (let cur = e as { code?: unknown; cause?: unknown; name?: unknown } | undefined; cur; cur = cur.cause as typeof cur) {
    // AbortSignal.timeout 抛的是 DOMException（name=TimeoutError），undici 抛的是 UND_ERR_CONNECT_TIMEOUT
    if (cur.name === "TimeoutError" || cur.name === "AbortError") return "TIMEOUT";
    if (typeof cur.code === "string" && cur.code.length <= 64) return cur.code;
  }
  return null;
}

function classify(e: unknown): TransportFailure {
  const code = causeCode(e);
  const kind = code !== null && /TIMEOUT/i.test(code) ? "timeout" : "network";
  const delivered = code !== null && NOT_DELIVERED_CODES.has(code) ? "no" : "unknown";
  return new TransportFailure(kind, delivered, `供应商请求失败（${kind}${code === null ? "" : `/${code}`}）`);
}

export class HttpProviderTransport implements ProviderTransport {
  private readonly base: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: HttpTransportOptions) {
    if (!opts.apiKey) throw new Error("HttpProviderTransport 需要非空 apiKey");
    let parsed: URL;
    try {
      parsed = new URL(opts.baseUrl);
    } catch {
      throw new Error("AIMASTER_BASE_URL 不是合法 URL");
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("AIMASTER_BASE_URL 必须是 http(s)");
    this.base = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async send(request: ProviderRequest): Promise<ProviderResponse> {
    const q = new URLSearchParams(Object.entries(request.query).sort(([a], [b]) => a.localeCompare(b))).toString();
    const url = `${this.base}${request.path}${q ? `?${q}` : ""}`;
    const headers: Record<string, string> = { "X-Api-Key": this.apiKey };
    if (request.body !== null) headers["Content-Type"] = "application/json";

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: request.method,
        headers,
        ...(request.body === null ? {} : { body: request.body }),
        redirect: "manual",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw classify(e);
    }

    let body: Uint8Array;
    try {
      body = new Uint8Array(await res.arrayBuffer());
    } catch (e) {
      throw new TransportFailure("truncated", "unknown", `响应体接收中断（status=${res.status}）`, { httpStatus: res.status });
    }
    return { httpStatus: res.status, body };
  }
}