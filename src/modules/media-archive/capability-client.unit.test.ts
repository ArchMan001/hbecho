// HttpCapabilityClient 对本机回环 HTTP 假服务的契约测试（回环地址，不联网，不依赖 Python 服务）。
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ConverterError } from "./ports";
import { HttpCapabilityClient } from "./capability-client";

type Handler = (req: IncomingMessage, body: Buffer, res: ServerResponse) => void;
const servers: Array<ReturnType<typeof createServer>> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});
async function serve(handler: Handler) {
  const seen: Array<{ url: string; headers: IncomingMessage["headers"]; body: Buffer }> = [];
  const s = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      seen.push({ url: req.url ?? "", headers: req.headers, body });
      handler(req, body, res);
    });
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return { seen, client: new HttpCapabilityClient({ baseUrl: `http://127.0.0.1:${(s.address() as AddressInfo).port}/`, imageTimeoutMs: 2000, audioTimeoutMs: 2000 }) };
}
const json = (res: ServerResponse, status: number, code: string) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ code, message: "m" }));
};
const kind = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e instanceof ConverterError ? e.kind : `other:${String(e)}`;
  }
  return "no error";
};
const img = { bytes: Uint8Array.from([1, 2, 3]), mimeType: "image/heic" };

describe("toNormalizedJpeg", () => {
  it("二进制 body + Content-Type 原样发送；X-Width / X-Height 解析为宽高", async () => {
    const { client, seen } = await serve((_r, _b, res) => {
      res.writeHead(200, { "Content-Type": "image/jpeg", "X-Width": "540", "X-Height": "960" });
      res.end(Buffer.from([0xff, 0xd8, 0xff, 9]));
    });
    const out = await client.toNormalizedJpeg(img);
    expect(out).toEqual({ bytes: Uint8Array.from([0xff, 0xd8, 0xff, 9]), width: 540, height: 960 });
    expect(seen[0]).toMatchObject({ url: "/v1/image/normalize", body: Buffer.from([1, 2, 3]) });
    expect(seen[0]!.headers["content-type"]).toBe("image/heic");
  });
  it("convert_failed / 4xx → unsupported（终态）；5xx / 502 → unavailable（可重试）", async () => {
    for (const [status, code, expected] of [
      [422, "convert_failed", "unsupported"],
      [413, "input_too_large", "unsupported"],
      [415, "unsupported_media_type", "unsupported"],
      [400, "invalid_request", "unsupported"],
      [502, "source_unavailable", "unavailable"],
      [500, "internal", "unavailable"],
      [503, "busy", "unavailable"],
    ] as const) {
      const { client } = await serve((_r, _b, res) => json(res, status, code));
      expect(await kind(client.toNormalizedJpeg(img)), `${status} ${code}`).toBe(expected);
    }
  });
  it("响应头缺宽高 / 非 JSON 的错误页 → unavailable（服务缺陷，可重试）", async () => {
    const noDims = await serve((_r, _b, res) => (res.writeHead(200), res.end("x")));
    expect(await kind(noDims.client.toNormalizedJpeg(img))).toBe("unavailable");
    const html = await serve((_r, _b, res) => (res.writeHead(502, { "Content-Type": "text/html" }), res.end("<html>bad gateway</html>")));
    expect(await kind(html.client.toNormalizedJpeg(img))).toBe("unavailable");
  });
});

describe("extractAudio", () => {
  it("JSON 请求；m4a 字节与 X-Duration-Ms", async () => {
    const { client, seen } = await serve((_r, _b, res) => {
      res.writeHead(200, { "Content-Type": "audio/mp4", "X-Duration-Ms": "1234" });
      res.end(Buffer.from("m4a"));
    });
    const out = await client.extractAudio({ sourceUrl: "https://oss.test/v?sig=1", maxBytes: 100 });
    expect(out).toEqual({ kind: "ok", bytes: new TextEncoder().encode("m4a"), durationMs: 1234 });
    expect(JSON.parse(seen[0]!.body.toString())).toEqual({ source_url: "https://oss.test/v?sig=1", max_bytes: 100 });
  });
  it("no_audio_track 是事实不是错误；缺 X-Duration-Ms → durationMs 为 null", async () => {
    const none = await serve((_r, _b, res) => json(res, 422, "no_audio_track"));
    expect(await none.client.extractAudio({ sourceUrl: "https://x/y", maxBytes: 1 })).toEqual({ kind: "no_audio_track" });
    const nodur = await serve((_r, _b, res) => (res.writeHead(200), res.end("a")));
    expect(await nodur.client.extractAudio({ sourceUrl: "https://x/y", maxBytes: 10 })).toMatchObject({ kind: "ok", durationMs: null });
  });
  it("错误分类与图片接口一致；声明长度超过上限时不读响应体", async () => {
    const gone = await serve((_r, _b, res) => json(res, 502, "source_unavailable"));
    expect(await kind(gone.client.extractAudio({ sourceUrl: "https://x/y", maxBytes: 10 }))).toBe("unavailable");
    const bad = await serve((_r, _b, res) => json(res, 422, "convert_failed"));
    expect(await kind(bad.client.extractAudio({ sourceUrl: "https://x/y", maxBytes: 10 }))).toBe("unsupported");
    const big = await serve((_r, _b, res) => (res.writeHead(200, { "Content-Length": "50" }), res.end(Buffer.alloc(50))));
    expect(await kind(big.client.extractAudio({ sourceUrl: "https://x/y", maxBytes: 10 }))).toBe("unsupported");
  });
});

describe("服务不可达", () => {
  it("连接被拒绝 / 超时 → unavailable，错误信息不带 URL", async () => {
    const down = await serve(() => {});
    const port = new URL((down.client as unknown as { base: string }).base).port;
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r)))); // 关掉：连接被拒
    const refused = new HttpCapabilityClient({ baseUrl: `http://127.0.0.1:${port}`, imageTimeoutMs: 500 });
    let msg = "";
    try {
      await refused.toNormalizedJpeg(img);
    } catch (e) {
      expect(e).toBeInstanceOf(ConverterError);
      expect((e as ConverterError).kind).toBe("unavailable");
      msg = (e as Error).message;
    }
    expect(msg).not.toContain(port);
    const hang = await serve(() => {}); // 收到请求但不回应
    const slow = new HttpCapabilityClient({ baseUrl: (hang.client as unknown as { base: string }).base, imageTimeoutMs: 100 });
    expect(await kind(slow.toNormalizedJpeg(img))).toBe("unavailable");
  });
});
