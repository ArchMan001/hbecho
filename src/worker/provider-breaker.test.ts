import { describe, expect, it } from "vitest";
import { createBreakerSet, createProviderBreaker } from "./provider-breaker";

function make(failures = 3, cooldownMs = 1000) {
  let now = 0;
  const changes: string[] = [];
  const b = createProviderBreaker("aimaster", { failures, cooldownMs, nowMs: () => now, onChange: (c) => changes.push(`${c.from}>${c.to}`) });
  return { b, changes, advance: (ms: number) => void (now += ms) };
}

describe("provider 熔断", () => {
  it("连续 K 次供应商级失败才打开；中间一次成功清零", () => {
    const { b } = make(3);
    b.recordProviderFailure();
    b.recordProviderFailure();
    b.recordSuccess();
    b.recordProviderFailure();
    b.recordProviderFailure();
    expect(b.state).toBe("closed");
    b.recordProviderFailure();
    expect(b.state).toBe("open");
    expect(b.tryAcquire()).toBe("no");
  });
  it("账号级失败是中性的：既不计数也不清零（RESULT_VALIDATION_FAILED 连续出现不触发熔断）", () => {
    const { b } = make(3);
    for (let i = 0; i < 100; i++) b.recordNeutral();
    expect(b.state).toBe("closed");
    b.recordProviderFailure();
    b.recordProviderFailure();
    b.recordNeutral();
    b.recordProviderFailure();
    expect(b.state).toBe("open"); // 夹在中间的账号级失败没有把计数清零
  });
  it("冷却期内不放行；冷却后只放行一个探测，探测在途时其余都不放行", () => {
    const { b, advance } = make(1, 1000);
    b.recordProviderFailure();
    advance(999);
    expect(b.tryAcquire()).toBe("no");
    advance(1);
    expect(b.tryAcquire()).toBe("probe");
    expect(b.state).toBe("half_open");
    expect(b.tryAcquire()).toBe("no");
    expect(b.tryAcquire()).toBe("no");
  });
  it("探测成功 → closed 并清零；探测失败 → open 并重新计时", () => {
    const { b, advance, changes } = make(1, 1000);
    b.recordProviderFailure();
    advance(1000);
    expect(b.tryAcquire()).toBe("probe");
    b.recordProviderFailure();
    expect(b.state).toBe("open");
    advance(500);
    expect(b.tryAcquire()).toBe("no"); // 重新计时：从探测失败那一刻起算
    advance(500);
    expect(b.tryAcquire()).toBe("probe");
    b.recordSuccess();
    expect(b.state).toBe("closed");
    expect(b.consecutiveFailures).toBe(0);
    expect(b.tryAcquire()).toBe("yes");
    expect(changes).toEqual(["closed>open", "open>half_open", "half_open>open", "open>half_open", "half_open>closed"]);
  });
  it("探测任务以账号级失败结束：只释放探测名额，仍在 half_open，下一个任务再探测", () => {
    const { b, advance } = make(1, 1000);
    b.recordProviderFailure();
    advance(1000);
    expect(b.tryAcquire()).toBe("probe");
    b.recordNeutral();
    expect(b.state).toBe("half_open");
    expect(b.tryAcquire()).toBe("probe");
  });
  it("参数非法在构造时报错；按 provider 分别熔断", () => {
    expect(() => createProviderBreaker("p", { failures: 0, cooldownMs: 1, nowMs: () => 0 })).toThrow();
    expect(() => createProviderBreaker("p", { failures: 1, cooldownMs: -1, nowMs: () => 0 })).toThrow();
    const set = createBreakerSet({ failures: 1, cooldownMs: 10, nowMs: () => 0 });
    set.get("a").recordProviderFailure();
    expect(set.get("a").state).toBe("open");
    expect(set.get("b").state).toBe("closed");
    expect(set.snapshot()).toEqual({ a: { state: "open", consecutiveFailures: 1 }, b: { state: "closed", consecutiveFailures: 0 } });
  });
});
