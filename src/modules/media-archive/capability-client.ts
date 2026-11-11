// Python 能力服务的 Node 客户端（ADR-0012；契约见 services/capability/README.md）。Node 内置 fetch，无新依赖。
// 一个类同时实现 ImageConverter 与 CapabilityClient：它们是同一个服务的两个接口。
// 错误分类只看服务返回的 JSON `code` 与 HTTP 状态，不看消息文本：
//   服务不可用 / 超时 / 读不到来源（502）/ 5xx / 响应格式不对 → ConverterError("unavailable")，可重试；
//   convert_failed、请求本身不合法（4xx）→ ConverterError("unsupported")，终态；
//   no_audio_track → { kind: "no_audio_track" }（事实，不是错误）。
import { ConverterError, type AudioExtraction, type CapabilityClient, type ImageConverter, type NormalizedImage } from "./ports";

export interface HttpCapabilityOptions {
  /** 服务根地址，例如 http://capability:8080（compose 内网）。 */
  baseUrl: string;
  imageTimeoutMs?: number;
  audioTimeoutMs?: number;
  /** 测试注入点。 */
  fetch?: typeof fetch;
}

const IMAGE_TIMEOUT_MS = 45_000;
const AUDIO_TIMEOUT_MS = 150_000; // 略大于服务端 ffmpeg 的 120 秒上限

async function errorCode(res: Response): Promise<string | null> {
  try {
    const j = (await res.json()) as { code?: unknown };
    return typeof j.code === "string" ? j.code : null;
  } catch {
    return null;
  }
}

/** 缺失或不是非负整数 → null（Number(null) 是 0，不能直接转）。 */
function intHeader(res: Response, name: string): number | null {
  const v = res.headers.get(name);
  return v !== null && /^\d+$/.test(v) ? Number(v) : null;
}

export class HttpCapabilityClient implements ImageConverter, CapabilityClient {
  private readonly base: string;
  private readonly f: typeof fetch;
  constructor(private readonly opts: HttpCapabilityOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, "");
    this.f = opts.fetch ?? fetch;
  }

  private async post(path: string, init: { body: NonNullable<RequestInit["body"]>; headers: Record<string, string> }, timeoutMs: number): Promise<Response> {
    try {
      return await this.f(`${this.base}${path}`, { method: "POST", ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      // 连接失败、超时、DNS：服务暂时不可用，可重试。消息里不带 URL 以外的内容
      throw new ConverterError("unavailable", `能力服务不可达：${e instanceof Error ? e.name : "error"}`);
    }
  }

  /** 非 2xx 的统一翻译；返回值 "no_audio_track" 由调用方处理，其余一律抛出。 */
  private async fail(res: Response): Promise<"no_audio_track"> {
    const code = await errorCode(res);
    if (code === "no_audio_track") return "no_audio_track";
    if (res.status >= 500 || code === "source_unavailable") throw new ConverterError("unavailable", `能力服务暂不可用（HTTP ${res.status}${code ? ` ${code}` : ""}）`);
    throw new ConverterError("unsupported", `能力服务拒绝（HTTP ${res.status}${code ? ` ${code}` : ""}）`);
  }

  async toNormalizedJpeg(input: { bytes: Uint8Array; mimeType: string }): Promise<NormalizedImage> {
    const res = await this.post("/v1/image/normalize", { body: input.bytes as Uint8Array<ArrayBuffer>, headers: { "Content-Type": input.mimeType } }, this.opts.imageTimeoutMs ?? IMAGE_TIMEOUT_MS);
    if (!res.ok) {
      await this.fail(res);
      throw new ConverterError("unsupported", "图片接口不应返回 no_audio_track");
    }
    const width = intHeader(res, "X-Width");
    const height = intHeader(res, "X-Height");
    if (width === null || height === null || width < 1 || height < 1) throw new ConverterError("unavailable", "能力服务响应缺少合法的 X-Width / X-Height");
    return { bytes: new Uint8Array(await res.arrayBuffer()), width, height };
  }

  async extractAudio(input: { sourceUrl: string; maxBytes: number }): Promise<AudioExtraction> {
    const res = await this.post("/v1/audio/extract", { body: JSON.stringify({ source_url: input.sourceUrl, max_bytes: input.maxBytes }), headers: { "Content-Type": "application/json" } }, this.opts.audioTimeoutMs ?? AUDIO_TIMEOUT_MS);
    if (!res.ok) return { kind: await this.fail(res) };
    const declared = intHeader(res, "Content-Length");
    if (declared !== null && declared > input.maxBytes) throw new ConverterError("unsupported", "音频超过上限"); // 不读超限的响应体
    return { kind: "ok", bytes: new Uint8Array(await res.arrayBuffer()), durationMs: intHeader(res, "X-Duration-Ms") };
  }
}
