// 真实的媒资 HTTP transport（FS-11.10）：node:http(s)，不跟随重定向，连接前解析 DNS 并拒绝非公网地址。
// 一个类同时实现 MediaTransport（图片，整体读入内存，有上限）与 VideoTransport（视频，按块流出）。
//
// 为什么用 lookup 而不是先解析再请求：先解析再连接有 DNS 重绑定窗口；把校验放进 http 的 lookup 回调，
// 校验过的地址就是连接用的地址。字面量 IP 不走 lookup，所以单独检查。
// 域名白名单、scheme、凭据、端口由 checkMediaUrl 在调用前负责；这里只负责「解析结果不能是内网」。
import dns from "node:dns";
import http, { type IncomingMessage } from "node:http";
import https from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { MediaFailure } from "../media-failure";
import type { MediaResponse, MediaTransport, VideoStreamResponse, VideoTransport } from "./ports";

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["2001:db8::", 32], ["64:ff9b::", 96]] as const) blocked.addSubnet(net, prefix, "ipv6");

/** 公网可路由地址才放行；IPv4 映射的 IPv6（::ffff:a.b.c.d）按其 IPv4 判断。 */
export function isPublicAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 0) return false;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return !blocked.check(mapped[1]!, "ipv4");
  return !blocked.check(ip, v === 4 ? "ipv4" : "ipv6");
}

/** 默认的 lookup：任何一个解析结果是非公网就整体拒绝。 */
export const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return callback(err, "", 0);
    const list = addrs as dns.LookupAddress[];
    if (list.length === 0 || list.some((a) => !isPublicAddress(a.address))) {
      return callback(new MediaFailure("url_rejected", "目标地址解析到非公网地址") as unknown as NodeJS.ErrnoException, "", 0);
    }
    if (options.all) (callback as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, list);
    else callback(null, list[0]!.address, list[0]!.family);
  });
};

export interface HttpMediaOptions {
  /** 测试注入点；生产用默认的 guardedLookup。 */
  lookup?: LookupFunction;
}

const header = (res: IncomingMessage, name: string): string | null => {
  const v = res.headers[name];
  return typeof v === "string" ? v : null;
};
const lengthOf = (res: IncomingMessage): number | null => {
  const v = header(res, "content-length");
  return v !== null && /^\d+$/.test(v) ? Number(v) : null;
};

export class HttpMediaTransport implements MediaTransport, VideoTransport {
  private readonly lookup: LookupFunction;
  constructor(opts: HttpMediaOptions = {}) {
    this.lookup = opts.lookup ?? guardedLookup;
  }

  private open(rawUrl: string, timeoutMs: number): Promise<IncomingMessage> {
    return new Promise((resolve, reject) => {
      const u = new URL(rawUrl);
      const host = u.hostname.replace(/^\[|\]$/g, "");
      if (isIP(host) !== 0 && !isPublicAddress(host)) return reject(new MediaFailure("url_rejected", "目标是非公网地址"));
      const req = (u.protocol === "https:" ? https : http).request(u, { method: "GET", lookup: this.lookup, headers: { accept: "*/*", "user-agent": "hbecho-media/1" }, timeout: timeoutMs }, resolve);
      // timeout 是套接字空闲超时：连接、等响应头、读响应体期间任何一段停住都会触发
      req.on("timeout", () => req.destroy(new MediaFailure("timeout")));
      req.on("error", (e) => reject(e instanceof MediaFailure ? e : e.cause instanceof MediaFailure ? e.cause : new MediaFailure("transport_error", e.message.slice(0, 200))));
      req.end();
    });
  }

  async get(url: string, opts: { timeoutMs: number; maxBytes: number }): Promise<MediaResponse> {
    const res = await this.open(url, opts.timeoutMs);
    const head = { status: res.statusCode ?? 0, contentType: header(res, "content-type"), contentLength: lengthOf(res), location: header(res, "location") };
    if (head.status < 200 || head.status >= 300) {
      res.destroy(); // 不需要错误页的内容
      return { ...head, body: new Uint8Array(0) };
    }
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      for await (const c of res) {
        total += (c as Buffer).length;
        if (total > opts.maxBytes) throw new MediaFailure("too_large");
        chunks.push(c as Buffer);
      }
    } catch (e) {
      res.destroy();
      throw e instanceof MediaFailure ? e : new MediaFailure("transport_error", e instanceof Error ? e.message.slice(0, 200) : "stream error");
    }
    return { ...head, body: new Uint8Array(Buffer.concat(chunks)) };
  }

  async stream(url: string, opts: { timeoutMs: number; maxBytes: number }): Promise<VideoStreamResponse> {
    const res = await this.open(url, opts.timeoutMs);
    const head = { status: res.statusCode ?? 0, contentType: header(res, "content-type"), contentLength: lengthOf(res), location: header(res, "location") };
    if (head.status < 200 || head.status >= 300) {
      res.destroy();
      return { ...head, body: null };
    }
    // IncomingMessage 本身就是按块产出的异步可迭代；消费方 break / return 时 Node 会销毁它，从而关闭连接
    return { ...head, body: res as AsyncIterable<Uint8Array> };
  }
}
