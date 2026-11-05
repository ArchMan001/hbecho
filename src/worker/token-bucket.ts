// provider 速率上限（FS-3.8、design §7.5）：相邻两次放行至少间隔 1/QPS，先到先得。
// 套在 ProviderTransport 外面，所以提交、轮询、翻页的每一次真实请求都被限速；数值来自配置，没有默认值。
import type { ProviderRequest, ProviderResponse, ProviderTransport } from "../modules/raw-capture";

export interface TokenBucket {
  /** 等到可以发下一次请求为止。 */
  acquire(): Promise<void>;
}

export interface TokenBucketDeps {
  ratePerSec: number;
  /** 当前毫秒时间；测试注入 fake clock。 */
  nowMs(): number;
  /** 等待；测试注入立即推进 fake clock 的实现。 */
  sleep(ms: number): Promise<void>;
}

/** ponytail: 单进程、burst=1 的间隔限速；多进程要共享限流（MySQL 令牌行或外部）后才能水平扩展。 */
export function createTokenBucket(d: TokenBucketDeps): TokenBucket {
  if (!(d.ratePerSec > 0) || !Number.isFinite(d.ratePerSec)) throw new RangeError("ratePerSec 必须是正数");
  const interval = 1000 / d.ratePerSec;
  let nextFree = 0;
  return {
    async acquire() {
      const now = d.nowMs();
      const start = Math.max(now, nextFree);
      nextFree = start + interval; // 同步预定，保证并发调用者按到达顺序排队
      if (start > now) await d.sleep(start - now);
    },
  };
}

export function rateLimitedTransport(inner: ProviderTransport, bucket: TokenBucket): ProviderTransport {
  return {
    async send(request: ProviderRequest): Promise<ProviderResponse> {
      await bucket.acquire();
      return inner.send(request);
    },
  };
}
