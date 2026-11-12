import { describe, expect, it } from "vitest";
import { HttpImageMatcher } from "./matcher-client";
import { MatcherError } from "./ports";

const REQ = { referenceUrl: "https://oss.example/ref?Signature=SECRET", candidateUrl: "https://oss.example/cand?Signature=SECRET2", mode: "template", maxBytes: 1000 } as const;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const client = (f: typeof fetch) => new HttpImageMatcher({ baseUrl: "http://capability:8080", timeoutMs: 50, fetch: f });
const err = async (p: Promise<unknown>): Promise<MatcherError> => p.then(() => Promise.reject(new Error("应当失败")), (e: unknown) => e as MatcherError);

describe("HttpImageMatcher", () => {
  it("请求体与路径：JSON，蛇形字段名；成功响应原样返回分数、能力与证据", async () => {
    let seen: { url: string; body: unknown; method: string } | undefined;
    const m = client(async (url, init) => {
      seen = { url: String(url), body: JSON.parse(String(init?.body)), method: String(init?.method) };
      return json(200, { score: 8.3, capability: { id: "image.template", version: 1 }, evidence: { inliers: 12 } });
    });
    expect(await m.match(REQ)).toEqual({ score: 8.3, capability: { id: "image.template", version: 1 }, evidence: { inliers: 12 } });
    expect(seen).toEqual({ url: "http://capability:8080/v1/image/match", method: "POST", body: { reference_url: REQ.referenceUrl, candidate_url: REQ.candidateUrl, mode: "template", max_bytes: 1000 } });
  });
  it.each([
    [400, "invalid_request", undefined],
    [413, "input_too_large", "candidate"],
    [415, "unsupported_media_type", "reference"],
    [422, "convert_failed", "candidate"],
    [422, "source_missing", "candidate"],
    [422, "source_missing", "reference"],
    [502, "source_unavailable", "candidate"],
  ] as const)("HTTP %i %s side=%s → 同码同侧的 MatcherError", async (status, code, side) => {
    const e = await err(client(async () => json(status, { code, message: "x", ...(side ? { side } : {}) })).match(REQ));
    expect(e).toBeInstanceOf(MatcherError);
    expect([e.code, e.side]).toEqual([code, side]);
  });
  it("错误消息里的签名 URL 被脱敏，不会流进任务详情或日志", async () => {
    const e = await err(client(async () => json(502, { code: "source_unavailable", message: "GET https://oss.example/cand?Signature=SECRET2 失败", side: "candidate" })).match(REQ));
    expect(e.message).toBe("GET <url> 失败");
    expect(e.message).not.toContain("SECRET");
  });
  it("超时 → timeout；连接失败 → unavailable（消息脱敏）", async () => {
    const slow = client((_u, init) => new Promise((_res, rej) => init?.signal?.addEventListener("abort", () => rej(init.signal!.reason))));
    expect((await err(slow.match(REQ))).code).toBe("timeout");
    const down = await err(client(async () => Promise.reject(new TypeError("fetch failed: connect ECONNREFUSED http://capability:8080/x"))).match(REQ));
    expect(down.code).toBe("unavailable");
    expect(down.message).not.toContain("capability:8080");
  });
  it("无法解析的响应（反向代理错误页）、未知错误码、不符合契约的成功体 → unavailable（瞬时，可重试）", async () => {
    expect((await err(client(async () => new Response("<html>502 Bad Gateway</html>", { status: 502 })).match(REQ))).code).toBe("unavailable");
    expect((await err(client(async () => json(500, { code: "something_new" })).match(REQ))).code).toBe("unavailable");
    expect((await err(client(async () => json(200, { score: 11, capability: { id: "image.template", version: 1 }, evidence: {} })).match(REQ))).code).toBe("unavailable");
    expect((await err(client(async () => json(200, { score: 5 })).match(REQ))).code).toBe("unavailable");
  });
});
