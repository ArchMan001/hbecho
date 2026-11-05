// 视频下载来源选择（纯函数）。候选集全部保留在引用里；这里只决定「这一次先试哪一个」。
// 抖音：api-play.amemv.com → api.amemv.com → 其余，且排除列表的 video.url（它不是可下载来源，D-48）。
// 小红书 / 快手：详情 download_urls 的第一个；快手 SHALL NOT 用列表 video.url。
import type { Platform } from "./contract";

const DOUYIN_HOST_PRIORITY = ["api-play.amemv.com", "api.amemv.com"] as const;

function hostOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** 返回按尝试顺序排列的可用来源（去掉非 http(s)、被排除项、重复项）；第一个即「首选」。 */
export function rankVideoSources(platform: Platform, candidates: readonly string[], excluded: readonly string[] = []): string[] {
  const skip = new Set(excluded);
  const usable = [...new Set(candidates)].filter((u) => !skip.has(u) && hostOf(u) !== null);
  if (platform !== "douyin") return usable;
  const rank = (u: string) => {
    const i = DOUYIN_HOST_PRIORITY.indexOf(hostOf(u) as (typeof DOUYIN_HOST_PRIORITY)[number]);
    return i === -1 ? DOUYIN_HOST_PRIORITY.length : i;
  };
  return usable.map((u, i) => ({ u, i })).sort((a, b) => rank(a.u) - rank(b.u) || a.i - b.i).map((x) => x.u);
}

export const pickVideoSource = (platform: Platform, candidates: readonly string[], excluded: readonly string[] = []): string | null =>
  rankVideoSources(platform, candidates, excluded)[0] ?? null;
