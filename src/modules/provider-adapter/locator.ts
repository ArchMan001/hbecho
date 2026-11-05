// 主页入口：最小清洗 + 入口类型识别（A v1.10 §5.1、§11.2.1；R3.1–R3.4）。
// 只看 URL 路径特征，不解析平台 HTML、不跟跳转；短链与分享口令在本地无法判断，记 unknown 并照常发送。
// 「供应商返回非主页账号 → 终止」目前没有供应商样本，留在 capability 证据的 knownGaps 里（任务 9 smoke 补）。

import type { Platform } from "./contract";

export type LocatorDecision =
  | { action: "send"; kind: "home" | "unknown"; original: string; cleaned: string }
  | {
      action: "reject";
      kind: "video" | "note";
      original: string;
      cleaned: string;
      reason: "non_home_locator";
      retryable: false;
    };

// 只含 URL 允许的 ASCII 字符：空白、中文标点、引号等在此截断
const URL_RE = /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/;
const TRAILING_PUNCT_RE = /[.,;:!?)'\]]+$/;

const hostIs = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

const PLATFORM_DOMAINS: Record<Platform, readonly string[]> = {
  douyin: ["douyin.com", "iesdouyin.com"],
  xiaohongshu: ["xiaohongshu.com", "xhslink.com", "xhslink.cn"],
  kuaishou: ["kuaishou.com"], // 含 v.kuaishou.com 短链
};

function platformOfHost(host: string): Platform | null {
  for (const p of Object.keys(PLATFORM_DOMAINS) as Platform[]) {
    if (PLATFORM_DOMAINS[p].some((d) => hostIs(host, d))) return p;
  }
  return null;
}

export type PlatformCheck = { ok: true } | { ok: false; reason: "platform_mismatch"; detected: Platform };

/**
 * 入口里的链接必须属于命令的平台（R3.8）：识别出另一个平台就拒绝，不静默切换平台。
 * 只看第一个 URL 的主机名；无法识别（其他域名、纯口令）不算错配，照常发送，由供应商判断。
 * 响应里没有 platform 字段（raw3），所以「解析结果的平台」只能在发送前按入口判断（capability knownGaps 已记录）。
 */
export function checkLocatorPlatform(platform: Platform, original: string): PlatformCheck {
  const m = URL_RE.exec(original);
  if (!m) return { ok: true };
  let host: string;
  try {
    host = new URL(m[0].replace(TRAILING_PUNCT_RE, "")).hostname.toLowerCase();
  } catch {
    return { ok: true };
  }
  const detected = platformOfHost(host);
  return detected === null || detected === platform ? { ok: true } : { ok: false, reason: "platform_mismatch", detected };
}

function kindOfUrl(url: string): "home" | "video" | "note" | "unknown" {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "unknown";
  }
  const host = u.hostname.toLowerCase();
  const path = u.pathname;
  if (hostIs(host, "douyin.com") || hostIs(host, "iesdouyin.com")) {
    if (/\/video\/[^/]/.test(path)) return "video";
    if (/\/note\/[^/]/.test(path)) return "note";
    if (/^\/user\/[^/]/.test(path)) return "home";
    return "unknown";
  }
  if (hostIs(host, "xiaohongshu.com")) {
    if (/^\/explore\/[^/]/.test(path) || /^\/discovery\/item\/[^/]/.test(path)) return "note";
    if (/^\/user\/profile\/[^/]/.test(path)) return "home";
    return "unknown";
  }
  if (hostIs(host, "kuaishou.com")) {
    if (/^\/profile\/[^/]/.test(path)) return "home";
    if (/^\/short-video\/[^/]/.test(path)) return "video";
    return "unknown"; // v.kuaishou.com 短链等本地无法判断
  }
  return "unknown";
}

export function classifyLocator(original: string): LocatorDecision {
  const m = URL_RE.exec(original);
  if (!m) return { action: "send", kind: "unknown", original, cleaned: original };

  const trimmed = m[0].replace(TRAILING_PUNCT_RE, "");
  // 前缀分享文案保留（raw3 实测整段发送成功）；只截掉第一个 URL 之后的字符
  const cleaned = original.slice(0, m.index + trimmed.length);
  const kind = kindOfUrl(trimmed);
  if (kind === "video" || kind === "note") {
    return { action: "reject", kind, original, cleaned, reason: "non_home_locator", retryable: false };
  }
  return { action: "send", kind, original, cleaned };
}
