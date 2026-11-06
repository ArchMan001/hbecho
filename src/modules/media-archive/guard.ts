// 下载前的 URL 守卫（R12.7、design §12.3）：scheme / host 白名单 / 凭据 / 端口 / IP 字面量。
// 域名解析到内网的情况由真实 transport 在连接前处理（见 ports.ts）。
import { MediaFailure } from "../media-failure";

export interface MediaPolicy {
  /** 允许的域名后缀（含子域）。取自 fixture 中出现的 CDN 域名（design §18 P0-11）。 */
  allowedHostSuffixes: readonly string[];
  /** 单张图片上限（design §18 P0-11：20 MB）。 */
  maxBytes: number;
  maxRedirects: number;
  timeoutMs: number;
}

export const DEFAULT_MEDIA_POLICY: MediaPolicy = Object.freeze({
  allowedHostSuffixes: Object.freeze(["douyinpic.com", "rednotecdn.com", "kwimgs.com"]), // kwimgs.com：快手封面（raw12 / raw13）
  maxBytes: 20 * 1024 * 1024,
  maxRedirects: 3,
  timeoutMs: 15_000,
});

export function checkMediaUrl(raw: string, policy: MediaPolicy): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new MediaFailure("url_rejected", "不是合法 URL");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new MediaFailure("url_rejected", "只允许 http(s)");
  if (u.username !== "" || u.password !== "") throw new MediaFailure("url_rejected", "URL 不能带凭据");
  if (u.port !== "") throw new MediaFailure("url_rejected", "不允许非默认端口");
  const host = u.hostname.toLowerCase();
  const allowed = policy.allowedHostSuffixes.some((s) => host === s || host.endsWith(`.${s}`));
  if (!allowed) throw new MediaFailure("url_rejected", "主机不在白名单"); // 同时挡住 IP 字面量、localhost、内网名
  return u;
}
