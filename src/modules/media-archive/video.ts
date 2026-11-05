// 视频下载（FS-11.5、FS-11.6、FS-11.10）：逐跳校验的流式下载，边写临时文件边算 SHA-256，内存只占一块。
// 网络期间不持有数据库事务（调用方保证）。字节不整文件进内存：超限中止并删除临时文件；声明长度与实际不符 → truncated。
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { MediaFailure } from "../media-failure";
import { checkMediaUrl, type MediaPolicy } from "./guard";
import type { VideoTransport } from "./ports";

/** 视频 CDN 域名取自 fixture 里出现的 download_urls（抖音 amemv / zjcdn，小红书 rednotecdn，快手 kwaicdn / ndcimgs）。 */
export const DEFAULT_VIDEO_POLICY: MediaPolicy = Object.freeze({
  allowedHostSuffixes: Object.freeze(["amemv.com", "zjcdn.com", "douyinpic.com", "rednotecdn.com", "kwaicdn.com", "ndcimgs.com"]),
  maxBytes: 2 * 1024 * 1024 * 1024,
  maxRedirects: 3,
  timeoutMs: 60_000,
});

export type VideoMime = "video/mp4" | "video/webm";
/** 按字节判断：MP4 / MOV 的 ftyp 盒子（偏移 4），WebM / Matroska 的 EBML 魔数。过期的签名 URL 常返回 200 + 错误页，不能当视频。 */
export function sniffVideo(head: Uint8Array): VideoMime | null {
  if (head.length >= 12 && String.fromCharCode(...head.subarray(4, 8)) === "ftyp") return "video/mp4";
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return "video/webm";
  return null;
}

export interface DownloadedVideo {
  sha256: string;
  byteLength: number;
  mimeType: VideoMime;
}

export async function downloadVideoToFile(transport: VideoTransport, url: string, policy: MediaPolicy, path: string): Promise<DownloadedVideo> {
  let current = checkMediaUrl(url, policy).toString();
  for (let hop = 0; hop <= policy.maxRedirects; hop++) {
    let res;
    try {
      res = await transport.stream(current, { timeoutMs: policy.timeoutMs, maxBytes: policy.maxBytes });
    } catch (e) {
      if (e instanceof MediaFailure) throw e;
      throw new MediaFailure("transport_error", e instanceof Error ? e.message.slice(0, 200) : "transport error");
    }
    if (res.status >= 300 && res.status < 400 && res.location) {
      if (hop === policy.maxRedirects) throw new MediaFailure("too_many_redirects");
      current = checkMediaUrl(new URL(res.location, current).toString(), policy).toString();
      continue;
    }
    if (res.status === 403 || res.status === 404 || res.status === 410) throw new MediaFailure("source_expired", `HTTP ${res.status}`);
    if (res.status !== 200) throw new MediaFailure("source_unavailable", `HTTP ${res.status}`);
    if (res.contentLength !== null && res.contentLength > policy.maxBytes) throw new MediaFailure("too_large");
    if (!res.body) throw new MediaFailure("source_unavailable", "没有响应体");

    const hash = createHash("sha256");
    const out = createWriteStream(path);
    let total = 0;
    let head = new Uint8Array(0);
    let mime: VideoMime | null = null;
    // 先等句柄关闭再删：createWriteStream 是异步打开的，立刻 rm 会让随后才打开的文件残留
    const discard = async () => {
      out.destroy();
      if (!out.closed) await once(out, "close");
      await rm(path, { force: true });
    };
    const abort = async (f: MediaFailure): Promise<never> => {
      await discard();
      throw f;
    };
    try {
      for await (const chunk of res.body) {
        total += chunk.byteLength;
        if (total > policy.maxBytes) return await abort(new MediaFailure("too_large")); // 中止读取，不把超限的字节写下去
        if (mime === null) {
          head = Uint8Array.from([...head, ...chunk.subarray(0, Math.max(0, 16 - head.length))]);
          if (head.length >= 12) {
            mime = sniffVideo(head);
            if (mime === null) return await abort(new MediaFailure("content_type_not_allowed", "字节不是受支持的视频"));
          }
        }
        hash.update(chunk);
        if (!out.write(chunk)) await once(out, "drain"); // 背压：写盘慢就不再拉取下一块
      }
    } catch (e) {
      if (e instanceof MediaFailure) throw e;
      await discard();
      throw new MediaFailure("transport_error", e instanceof Error ? e.message.slice(0, 200) : "stream error");
    }
    out.end();
    await once(out, "finish");
    if (mime === null) return abort(new MediaFailure("content_type_not_allowed", "字节不是受支持的视频"));
    if (res.contentLength !== null && res.contentLength !== total) return abort(new MediaFailure("truncated"));
    return { sha256: hash.digest("hex"), byteLength: total, mimeType: mime };
  }
  throw new MediaFailure("too_many_redirects");
}

/** 启动时清理：超过 olderThanMs 的 .part 临时文件（FS-17.4）。返回删除数。 */
export async function cleanStaleTmp(dir: string, olderThanMs: number, nowMs: number): Promise<number> {
  const { readdir, stat } = await import("node:fs/promises");
  let n = 0;
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (!name.endsWith(".part")) continue;
    const full = `${dir}/${name}`;
    const st = await stat(full).catch(() => null);
    if (st && nowMs - st.mtimeMs > olderThanMs) {
      await rm(full, { force: true });
      n++;
    }
  }
  return n;
}
