import { describe, expect, it } from "vitest";
import type { ProviderRequest, ProviderTransport } from "../modules/raw-capture";
import { createTokenBucket, rateLimitedTransport } from "./token-bucket";

function clockWithSleep() {
  let t = 0;
  const slept: number[] = [];
  return { nowMs: () => t, sleep: async (ms: number) => void (slept.push(ms), (t += ms)), slept, advance: (ms: number) => void (t += ms) };
}

describe("令牌桶（间隔限速）", () => {
  it("QPS=2：首次立即放行，随后每次至少间隔 500ms；并发到达的调用者按顺序排队", async () => {
    const slept: number[] = [];
    // 时钟不动、只记录等待：四个调用者在同一毫秒到达
    const b = createTokenBucket({ ratePerSec: 2, nowMs: () => 0, sleep: async (ms) => void slept.push(ms) });
    // 四个调用者同时到达：同步预定的等待时间依次是 0（立即）、500、1000、1500
    await Promise.all([1, 2, 3, 4].map(() => b.acquire()));
    expect(slept).toEqual([500, 1000, 1500]);
  });
  it("空闲一段时间后不会攒出突发：之后仍然按间隔放行", async () => {
    const c = clockWithSleep();
    const b = createTokenBucket({ ratePerSec: 1, nowMs: c.nowMs, sleep: c.sleep });
    await b.acquire();
    c.advance(10_000);
    const before = c.nowMs();
    await b.acquire();
    await b.acquire();
    expect(c.nowMs() - before).toBe(1000);
  });
  it("非法速率在构造时报错（没有默认值，不静默放行）", () => {
    for (const r of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createTokenBucket({ ratePerSec: r, nowMs: () => 0, sleep: async () => {} })).toThrow();
    }
  });
  it("rateLimitedTransport：每次真实请求前都取令牌，请求与响应原样透传", async () => {
    const c = clockWithSleep();
    const seen: number[] = [];
    const inner: ProviderTransport = { send: async (r: ProviderRequest) => (seen.push(c.nowMs()), { httpStatus: 200, body: r.body ?? new Uint8Array() }) };
    const t = rateLimitedTransport(inner, createTokenBucket({ ratePerSec: 4, nowMs: c.nowMs, sleep: c.sleep }));
    const req: ProviderRequest = { method: "POST", path: "/x", query: {}, body: new TextEncoder().encode("{}") };
    const r = await t.send(req);
    await t.send(req);
    expect(r.httpStatus).toBe(200);
    expect(seen).toEqual([0, 250]);
  });
});
