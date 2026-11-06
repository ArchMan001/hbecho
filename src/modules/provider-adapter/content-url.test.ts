import { describe, expect, it } from "vitest";
import { buildContentUrl } from "./content-url";

describe("ContentUrlBuilder", () => {
  it.each([
    ["抖音：优先用列表观察到的 share_url", "douyin", { postId: "76", shareUrl: "https://www.iesdouyin.com/share/video/76/" }, { ok: true, url: "https://www.iesdouyin.com/share/video/76/", form: "share_url" }],
    ["抖音：没有 share_url 回退到规范地址", "douyin", { postId: "7676403385372904742" }, { ok: true, url: "https://www.douyin.com/video/7676403385372904742", form: "canonical" }],
    ["抖音：share_url 不是 http(s) 地址时不用", "douyin", { postId: "76", shareUrl: "复制此链接" }, { ok: true, url: "https://www.douyin.com/video/76", form: "canonical" }],
    ["小红书：explore 规范地址（raw6 评论样本用过）", "xiaohongshu", { postId: "634ed0b300000000070362c6" }, { ok: true, url: "https://www.xiaohongshu.com/explore/634ed0b300000000070362c6", form: "canonical" }],
    ["快手：short-video 规范地址（2026-11-06 smoke 验证；不使用列表里的短链）", "kuaishou", { postId: "3x29z4cn3ygqdsc", shareUrl: "https://v.kuaishou.com/abc" }, { ok: true, url: "https://www.kuaishou.com/short-video/3x29z4cn3ygqdsc", form: "canonical" }],
    ["内容 ID 为空", "douyin", { postId: "" }, { ok: false, reason: "content_url_unavailable" }],
    ["内容 ID 中的特殊字符被转义，不能拼出另一个路径", "xiaohongshu", { postId: "a/../b?x=1" }, { ok: true, url: "https://www.xiaohongshu.com/explore/a%2F..%2Fb%3Fx%3D1", form: "canonical" }],
  ] as const)("%s", (_n, platform, input, expected) => {
    expect(buildContentUrl(platform, input)).toEqual(expected);
  });
});
