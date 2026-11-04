// 真实 HTTP transport 的单元测试：不联网。证明请求形状、认证头注入位置、响应字节原样转发，
// 以及传输失败如何分类（可安全重试 vs 结果未知）。任何错误信息都不得夹带 apiKey。
import { describe, expect, it } from "vitest";
import { TransportFailure } from "./ports";
import { HttpProviderTransport } from "./http-transport";

const API_KEY = "sk-FAKE-TRANSPORT-TEST-0123456789";
const BASE = "https://openapi.example.test";
const body = (s: string) => new TextEncoder().encode(s);

function harness(responder: (url: string, init: RequestInit) => Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const t = new HttpProviderTransport({
    baseUrl: BASE,
    apiKey: API_KEY,
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return responder(String(input), init ?? {});
    }) as typeof fetch,
  });
  return { t, calls };
}

describe("HttpProviderTransport", () => {
  it("POST：拼路径与 query，注入 X-Api-Key 与请求体字节，原样返回响应字节", async () => {
    const { t, calls } = harness(async () => new Response(body('{"ok":true}'), { status: 200 }));
    const res = await t.send({ method: "POST", path: "/openapi/v1/media_user_info", query: { async: "false" }, body: body('{"url":"x"}') });
    expect(res.httpStatus).toBe(200);
    expect(new TextDecoder().decode(res.body)).toBe('{"ok":true}');
    expect(calls[0]!.url).toBe(`${BASE}/openapi/v1/media_user_info?async=false`);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["X-Api-Key"]).toBe(API_KEY);
    expect(headers["Content-Type"]).toBe("application/json");
    expect(new TextDecoder().decode(calls[0]!.init.body as Uint8Array)).toBe('{"url":"x"}');
  });

  it("GET 轮询：不带 body、不带 Content-Type，query 按键名排序", async () => {
    const { t, calls } = harness(async () => new Response("{}", { status: 200 }));
    await t.send({ method: "GET", path: "/openapi/v1/tasks/abc", query: { b: "2", a: "1" }, body: null });
    expect(calls[0]!.url).toBe(`${BASE}/openapi/v1/tasks/abc?a=1&b=2`);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBeUndefined();
    expect(calls[0]!.init.body).toBeUndefined();
  });

  it("4xx/5xx 是「已捕获的响应」，不是传输失败", async () => {
    const { t } = harness(async () => new Response('{"code":"bad"}', { status: 500 }));
    await expect(t.send({ method: "GET", path: "/x", query: {}, body: null })).resolves.toMatchObject({ httpStatus: 500 });
  });

  it("连接被拒 → network + delivered=no（可安全按新 attempt 重试）", async () => {
    const { t } = harness(async () => {
      throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    });
    const err = await t.send({ method: "GET", path: "/x", query: {}, body: null }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransportFailure);
    expect(err).toMatchObject({ kind: "network", delivered: "no" });
    expect(String((err as Error).message)).not.toContain(API_KEY);
  });

  it("超时 → timeout + delivered=unknown（远端是否执行未知）", async () => {
    const { t } = harness(async () => {
      throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    });
    const err = await t.send({ method: "GET", path: "/x", query: {}, body: null }).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: "timeout", delivered: "unknown" });
    expect(String((err as Error).message)).not.toContain(API_KEY);
  });

  it("响应体读到一半失败 → truncated，并保留已到达的 httpStatus", async () => {
    const { t } = harness(async () => {
      const res = new Response("x", { status: 200 });
      Object.defineProperty(res, "arrayBuffer", { value: async () => Promise.reject(new Error("aborted")) });
      return res;
    });
    const err = await t.send({ method: "GET", path: "/x", query: {}, body: null }).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: "truncated", delivered: "unknown", opts: { httpStatus: 200 } });
  });

  it("构造时就拒绝非法 baseUrl 与空 apiKey", () => {
    expect(() => new HttpProviderTransport({ baseUrl: "not a url", apiKey: API_KEY })).toThrow(/AIMASTER_BASE_URL/);
    expect(() => new HttpProviderTransport({ baseUrl: BASE, apiKey: "" })).toThrow(/apiKey/);
  });
});