import { describe, expect, it } from "vitest";
import { POINTS, YUAN_PER_POINT, pointsOf } from "./index";

describe("点数表（A v1.10 §6.2）", () => {
  it("抖音 10 / 10，小红书 15 / 15；轮询与未登记 action 不计点", () => {
    expect(pointsOf("douyin", "media_user_info")).toBe(10);
    expect(pointsOf("douyin", "user_video_list")).toBe(10);
    expect(pointsOf("xiaohongshu", "media_user_info")).toBe(15);
    expect(pointsOf("xiaohongshu", "user_video_list")).toBe(15);
    expect(pointsOf("douyin", "task_lookup")).toBe(0);
    expect(pointsOf("kuaishou", "media_user_info")).toBe(0);
  });
  it("单价 0.02 元/点：一次抖音主页 + 一页列表 = 20 点 = 0.4 元", () => {
    expect((POINTS.douyin!.media_user_info! + POINTS.douyin!.user_video_list!) * YUAN_PER_POINT).toBeCloseTo(0.4, 10);
  });
});
