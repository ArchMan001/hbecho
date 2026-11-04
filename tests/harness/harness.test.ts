// 测试挂具自身的验收：禁网、fixture transport、fake clock、fake OSS。
// 对应 tasks 任务 1「固定测试 harness」与 R16.1/R16.2。
import { createHash } from "node:crypto";
import http from "node:http";
import net from "node:net";
import { describe, expect, it } from "vitest";
import { FakeClock } from "./fake-clock";
import { FakeObjectStore } from "./fake-oss";
import { FixtureTransport, UnregisteredFixtureRequestError } from "./fixture-transport";
import { NetworkDeniedError, drainDeniedAttempts } from "./network-deny";

describe("network-deny（R16.1/R16.2：真实请求即失败）", () => {
  it("fetch 外部地址被拒绝，且记录尝试", async () => {
    await expect(fetch("https://openapi.fieldshortcut.com/openapi/v1/media_user_info")).rejects.toBeInstanceOf(
      NetworkDeniedError,
    );
    const attempts = drainDeniedAttempts();
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toContain("openapi.fieldshortcut.com");
  });

  it("net.connect 外部地址同步抛出 NetworkDeniedError", () => {
    expect(() => net.connect({ host: "203.0.113.7", port: 443 })).toThrow(NetworkDeniedError);
    expect(drainDeniedAttempts()).toHaveLength(1);
  });

  it("http.get 外部地址失败（同步抛出或 error 事件，二者都是 NetworkDeniedError）", async () => {
    const err = await new Promise<Error>((resolve) => {
      try {
        const req = http.get("http://example.com/", () => resolve(new Error("不应收到响应")));
        req.on("error", resolve);
      } catch (e) {
        resolve(e as Error);
      }
    });
    expect(err).toBeInstanceOf(NetworkDeniedError);
    expect(drainDeniedAttempts()).toHaveLength(1);
  });

  it("回环地址放行（后续任务连本机一次性 MySQL 容器要用）", async () => {
    const server = net.createServer((s) => s.end("ok"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as net.AddressInfo).port;
    const data = await new Promise<string>((resolve, reject) => {
      const c = net.connect({ host: "127.0.0.1", port });
      let buf = "";
      c.on("data", (d) => (buf += d.toString()));
      c.on("end", () => resolve(buf));
      c.on("error", reject);
    });
    server.close();
    expect(data).toBe("ok");
    expect(drainDeniedAttempts()).toHaveLength(0);
  });
});

describe("FixtureTransport", () => {
  const req = { method: "POST", path: "/openapi/v1/media_user_info", query: { async: "false" }, body: null } as const;

  it("已登记请求返回 fixture 并计数", async () => {
    const t = new FixtureTransport();
    t.register({ path: req.path, query: { async: "false" } }, { httpStatus: 200, body: new TextEncoder().encode("{}") });
    const res = await t.send(req);
    expect(res.httpStatus).toBe(200);
    expect(t.calls).toHaveLength(1);
  });

  it("未登记请求立即失败，不计入已发送调用", async () => {
    const t = new FixtureTransport();
    await expect(t.send(req)).rejects.toBeInstanceOf(UnregisteredFixtureRequestError);
    expect(t.calls).toHaveLength(0);
    expect(t.rejected).toHaveLength(1);
  });
});

describe("FakeClock", () => {
  it("可设置并推进，推进一年后差值精确", () => {
    const c = new FakeClock(new Date("2026-11-04T00:00:00.000Z"));
    c.advance(365 * 24 * 3600 * 1000);
    expect(c.now().toISOString()).toBe("2027-11-04T00:00:00.000Z");
  });

  it("now() 返回副本，外部修改不影响时钟", () => {
    const c = new FakeClock(new Date("2026-11-04T00:00:00.000Z"));
    c.now().setFullYear(1999);
    expect(c.now().getUTCFullYear()).toBe(2026);
  });
});

describe("FakeObjectStore", () => {
  it("put 返回整字节 SHA-256 与长度，get 取回相同字节", async () => {
    const s = new FakeObjectStore();
    const bytes = new TextEncoder().encode("hello");
    const r = await s.put("ods/a", bytes);
    expect(r).toEqual({ sha256: createHash("sha256").update(bytes).digest("hex"), byteLength: 5 });
    expect(await s.get("ods/a")).toEqual(bytes);
    expect(await s.get("ods/none")).toBeNull();
  });

  it("存入的是副本：事后修改入参不改变已存对象", async () => {
    const s = new FakeObjectStore();
    const bytes = new Uint8Array([1, 2, 3]);
    await s.put("k", bytes);
    bytes[0] = 9;
    expect((await s.get("k"))?.[0]).toBe(1);
  });
});
