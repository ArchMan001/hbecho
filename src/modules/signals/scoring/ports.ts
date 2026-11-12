// 图片匹配端口（design §7.8）。真实实现是调用 Python 能力服务 POST /v1/image/match 的 HttpImageMatcher（任务 7）；
// 默认测试用 FakeMatcher。参考图（reference）与候选图（candidate）都以短期签名 URL 传入，Python 不持有任何凭证。
export type MatchMode = "template" | "element";

export interface MatchRequest {
  referenceUrl: string;
  candidateUrl: string;
  mode: MatchMode;
  maxBytes: number;
}
export interface MatchResult {
  /** 0.00–10.00 */
  score: number;
  /** Python 端该能力的标识与版本；Node 校验与目录一致，防止「目录升了、镜像还是旧的」。 */
  capability: { id: string; version: number };
  /** 匹配点数量等原始度量；写入结果行证据前已不含 URL。 */
  evidence: Record<string, unknown>;
}

/** 能力服务的错误码（design §7.8 错误码表）；归类（瞬时 / 确定性 / 配置错误）由任务 8 的 runner 按 code 与 side 决定。 */
export type MatcherErrorCode =
  | "invalid_request"
  | "input_too_large"
  | "unsupported_media_type"
  | "convert_failed"
  | "source_missing"
  | "source_unavailable"
  | "unavailable"
  | "timeout";

export class MatcherError extends Error {
  constructor(
    readonly code: MatcherErrorCode,
    message: string,
    readonly side?: "candidate" | "reference",
  ) {
    super(message);
    this.name = "MatcherError";
  }
}

export interface ImageMatcher {
  match(req: MatchRequest): Promise<MatchResult>;
}
