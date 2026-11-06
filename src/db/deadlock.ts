// InnoDB 死锁（ER_LOCK_DEADLOCK / 1213）的有界重试。
// 死锁时 MySQL 回滚整个事务；只要事务本身是幂等的整笔操作（列表整页投影、定稿都是），原样重跑就是正确做法。
// 规模演练里并发 worker 对 contents / content_snapshots 的「先查再插」会在唯一索引的间隙上互相死锁（约 5–9% 的页事务），
// 不重试的话整页作废、任务回队尾，下一次尝试还要再付一次供应商调用的钱——而响应早已落在 ODS 里，不需要再请求。
export function isDeadlock(e: unknown): boolean {
  for (let cur = e as { code?: unknown; errno?: unknown; cause?: unknown } | undefined; cur; cur = cur.cause as typeof cur) {
    if (cur.code === "ER_LOCK_DEADLOCK" || cur.errno === 1213) return true;
  }
  return false;
}
export async function retryOnDeadlock<T>(f: () => Promise<T>, o: { attempts?: number; onRetry?: (attempt: number) => void } = {}): Promise<T> {
  const attempts = o.attempts ?? 4;
  for (let i = 1; ; i++) {
    try {
      return await f();
    } catch (e) {
      if (!isDeadlock(e) || i >= attempts) throw e;
      o.onRetry?.(i);
      await new Promise((r) => setTimeout(r, 5 + Math.floor(Math.random() * 20 * i))); // 抖动，避免两个事务同步重撞
    }
  }
}
