/** 退避：第 n 次失败后等待 min(max, base × 2^(n-1))；沿用 tracer 的 DEFAULT_RETRY。 */
export interface RetryConfig {
  baseBackoffMs: number;
  maxBackoffMs: number;
}
