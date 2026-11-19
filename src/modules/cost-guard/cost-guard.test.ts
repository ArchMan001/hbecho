import { describe, expect, it } from "vitest";
import { POINTS, YUAN_PER_POINT, pointsOf } from "./index";

describe("点数表（A §6.2、计费点数表.md；FS-16.3）", () => {
  it("详情与评论：抖音 10 / 5，小红书 15 / 15，快手 10 / —（评论不支持）", () => {
    expect(pointsOf("douyin", "media_stats_number")).toBe(10);
    expect(pointsOf("douyin", "post_comments_list")).toBe(5);
    expect(pointsOf("xiaohongshu", "media_stats_number")).toBe(15);
    expect(pointsOf("xiaohongshu", "post_comments_list")).toBe(15);
    expect(pointsOf("kuaishou", "media_user_info")).toBe(10);
    expect(pointsOf("kuaishou", "user_video_list")).toBe(10);
    expect(pointsOf("kuaishou", "media_stats_number")).toBe(10);
    expect(pointsOf("kuaishou", "post_comments_list")).toBe(0);
  });
  it("抖音 10 / 10，小红书 15 / 15；轮询与未登记 action 不计点", () => {
    expect(pointsOf("douyin", "media_user_info")).toBe(10);
    expect(pointsOf("douyin", "user_video_list")).toBe(10);
    expect(pointsOf("xiaohongshu", "media_user_info")).toBe(15);
    expect(pointsOf("xiaohongshu", "user_video_list")).toBe(15);
    expect(pointsOf("douyin", "task_lookup")).toBe(0);
    expect(pointsOf("wechat_channels", "media_user_info")).toBe(0);
  });
  it("单价 0.01 元/点：一次抖音主页 + 一页列表 = 20 点 = 0.2 元", () => {
    expect((POINTS.douyin!.media_user_info! + POINTS.douyin!.user_video_list!) * YUAN_PER_POINT).toBeCloseTo(0.2, 10);
  });
});
