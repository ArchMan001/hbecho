// 有界下载：逐跳校验的重定向、大小上限、截断检测、状态码与类型分类。网络期间不持有数据库事务（调用方保证）。
import { MediaFailure } from "../media-failure";
import { checkMediaUrl, type MediaPolicy } from "./guard";
import type { MediaTransport } from "./ports";
import { sniffImage, type ImageMime } from "./sniff";

export interface Downloaded {
  bytes: Uint8Array;
  mimeType: ImageMime;
}

export async function downloadBounded(transport: MediaTransport, url: string, policy: MediaPolicy): Promise<Downloaded> {
  let current = checkMediaUrl(url, policy).toString();
  for (let hop = 0; hop <= policy.maxRedirects; hop++) {
    let res;
    try {
      res = await transport.get(current, { timeoutMs: policy.timeoutMs, maxBytes: policy.maxBytes });
    } catch (e) {
      if (e instanceof MediaFailure) throw e;
      throw new MediaFailure("transport_error", e instanceof Error ? e.message.slice(0, 200) : "transport error");
    }

    if (res.status >= 300 && res.status < 400 && res.location) {
      if (hop === policy.maxRedirects) throw new MediaFailure("too_many_redirects");
      // 目标可以是相对地址；每一跳都重新过守卫，不信任上一跳
      current = checkMediaUrl(new URL(res.location, current).toString(), policy).toString();
      continue;
    }
    if (res.status === 403 || res.status === 404 || res.status === 410) throw new MediaFailure("source_expired", `HTTP ${res.status}`);
    if (res.status === 429 || res.status >= 500) throw new MediaFailure("source_unavailable", `HTTP ${res.status}`);
    if (res.status !== 200) throw new MediaFailure("source_unavailable", `HTTP ${res.status}`);

    if (res.contentLength !== null && res.contentLength > policy.maxBytes) throw new MediaFailure("too_large");
    if (res.body.byteLength > policy.maxBytes) throw new MediaFailure("too_large");
    if (res.contentLength !== null && res.contentLength !== res.body.byteLength) throw new MediaFailure("truncated");

    const mimeType = sniffImage(res.body);
    if (mimeType === null) throw new MediaFailure("content_type_not_allowed", "字节不是受支持的图片");
    return { bytes: res.body, mimeType };
  }
  throw new MediaFailure("too_many_redirects");
}
