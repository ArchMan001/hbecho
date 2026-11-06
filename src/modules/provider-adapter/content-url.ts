// 详情 / 评论请求需要内容 url。抖音 / 小红书有样本；快手没有（design §14 第 2 项），smoke 证实前一律 unavailable，
// 不猜测 URL 形式（tasks「必须停下来问」第 10 条）。
import type { Platform } from "./contract";

export type ContentUrl =
  | { ok: true; url: string; form: "share_url" | "canonical" }
  | { ok: false; reason: "content_url_unavailable" };

export interface ContentUrlInput {
  /** 平台内容 ID 原文。 */
  postId: string;
  /** 最近快照观察到的分享页地址（抖音列表的 share_url）。 */
  shareUrl?: string | null | undefined;
}

const UNAVAILABLE: ContentUrl = { ok: false, reason: "content_url_unavailable" };
const isHttpUrl = (s: string) => /^https?:\/\/\S+$/.test(s);

export function buildContentUrl(platform: Platform, c: ContentUrlInput): ContentUrl {
  if (c.postId === "") return UNAVAILABLE;
  const id = encodeURIComponent(c.postId);
  switch (platform) {
    case "douyin":
      return c.shareUrl && isHttpUrl(c.shareUrl)
        ? { ok: true, url: c.shareUrl, form: "share_url" }
        : { ok: true, url: `https://www.douyin.com/video/${id}`, form: "canonical" };
    case "xiaohongshu":
      return { ok: true, url: `https://www.xiaohongshu.com/explore/${id}`, form: "canonical" };
    case "kuaishou":
      // 2026-11-06 真实 smoke 验证：www.kuaishou.com/short-video/{id} 与 v.m.chenzhongtech.com/fw/photo/{id} 可用，
      // c.kuaishou.com/fw/photo/{id}、m.gifshow.com/fw/photo/{id} 被供应商拒绝（RESULT_VALIDATION_FAILED）
      return { ok: true, url: `https://www.kuaishou.com/short-video/${id}`, form: "canonical" };
  }
}
