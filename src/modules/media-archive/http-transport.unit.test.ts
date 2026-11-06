// 真实 HTTP transport 对回环假服务的测试。默认 lookup 会拒绝回环地址（这正是要证明的），成功路径注入不设防的 lookup。
import dns from "node:dns";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { MediaFailure } from "../media-failure";
import { HttpMediaTransport, isPublicAddress } from "./http-transport";

const servers: Array<ReturnType<typeof createServer>> = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
});
async function serve(handler: Parameters<typeof createServer>[1]) {
  const hits = { n: 0, closed: 0 };
  const s = createServer((req, res) => {
    hits.n++;
    res.on("close", () => hits.closed++);
    handler!(req, res);
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return { hits, url: `http://localhost:${(s.address() as AddressInfo).port}/v.mp4` };
}
// 测试里让 localhost 通过：直接用系统解析，不设防
const open = new HttpMediaTransport({ lookup: (h, o, cb) => dns.lookup(h, o as dns.LookupOptions, cb as never) });
const guarded = new HttpMediaTransport();
const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e instanceof MediaFailure ? e.code : `other:${String(e)}`;
  }
  return null;
};
const OPTS = { timeoutMs: 1000, maxBytes: 1000 };

describe("isPublicAddress", () => {
  it("私网 / 回环 / 链路本地 / CGNAT / 保留 / 组播 / IPv4 映射的内网 → false；公网 → true", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "::1", "::", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "not-an-ip"]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
    for (const ip of ["8.8.8.8", "172.32.0.1", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) expect(isPublicAddress(ip), ip).toBe(true);
  });
});

describe("连接前的 DNS 守卫", () => {
  it("域名解析到回环 → url_rejected，且从未连接服务器；字面量内网 IP 同样被拒", async () => {
    const s = await serve((_q, res) => res.end("x"));
    expect(await codeOf(guarded.get(s.url, OPTS))).toBe("url_rejected");
    expect(await codeOf(guarded.stream(s.url, OPTS))).toBe("url_rejected");
    expect(await codeOf(guarded.get("http://169.254.169.254/latest/meta-data", OPTS))).toBe("url_rejected");
    expect(await codeOf(guarded.stream("http://[::1]:1/x", OPTS))).toBe("url_rejected");
    expect(s.hits.n).toBe(0);
  });
});

describe("get（图片：整体读入，有上限）", () => {
  it("200：状态、类型、声明长度和字节；3xx 不跟随，只给 location；非 2xx 不读体", async () => {
    const ok = await serve((_q, res) => (res.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": "3" }), res.end(Buffer.from([1, 2, 3]))));
    expect(await open.get(ok.url, OPTS)).toEqual({ status: 200, contentType: "image/jpeg", contentLength: 3, location: null, body: Uint8Array.from([1, 2, 3]) });
    const redir = await serve((_q, res) => (res.writeHead(302, { Location: "https://elsewhere.test/x" }), res.end()));
    expect(await open.get(redir.url, OPTS)).toMatchObject({ status: 302, location: "https://elsewhere.test/x", body: new Uint8Array(0) });
    expect(redir.hits.n).toBe(1);
    const gone = await serve((_q, res) => (res.writeHead(404), res.end("<html>nope</html>")));
    expect(await open.get(gone.url, OPTS)).toMatchObject({ status: 404, body: new Uint8Array(0) });
  });
  it("超过 maxBytes 就中止读取（too_large），连接被关闭", async () => {
    const big = await serve((_q, res) => (res.writeHead(200), res.write(Buffer.alloc(600)), res.write(Buffer.alloc(600)), setTimeout(() => res.end(Buffer.alloc(10_000_000)), 20)));
    expect(await codeOf(open.get(big.url, OPTS))).toBe("too_large");
    await new Promise((r) => setTimeout(r, 100));
    expect(big.hits.closed).toBe(1);
  });
  it("服务器不响应 → timeout；连接被拒 → transport_error", async () => {
    const hang = await serve(() => {});
    expect(await codeOf(open.get(hang.url, { timeoutMs: 100, maxBytes: 10 }))).toBe("timeout");
    expect(await codeOf(open.get("http://localhost:1/x", OPTS))).toBe("transport_error");
  });
});

describe("stream（视频：按块流出）", () => {
  it("按块产出；消费方提前停止 → 连接被关闭", async () => {
    const s = await serve((_q, res) => {
      res.writeHead(200, { "Content-Type": "video/mp4" });
      const t = setInterval(() => res.write(Buffer.alloc(1000)), 5);
      res.on("close", () => clearInterval(t));
    });
    const r = await open.stream(s.url, OPTS);
    expect(r).toMatchObject({ status: 200, contentType: "video/mp4", contentLength: null });
    let n = 0;
    for await (const c of r.body!) {
      n += c.byteLength;
      if (n >= 3000) break;
    }
    await new Promise((x) => setTimeout(x, 100));
    expect(s.hits.closed).toBe(1);
  });
  it("非 2xx → body 为 null；3xx 带 location", async () => {
    const e = await serve((_q, res) => (res.writeHead(403), res.end()));
    expect(await open.stream(e.url, OPTS)).toMatchObject({ status: 403, body: null });
    const r = await serve((_q, res) => (res.writeHead(301, { Location: "https://cdn.test/v.mp4" }), res.end()));
    expect(await open.stream(r.url, OPTS)).toMatchObject({ status: 301, location: "https://cdn.test/v.mp4", body: null });
  });
});
