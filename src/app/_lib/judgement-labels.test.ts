import { describe, expect, it } from "vitest";
import { parseConfig } from "../../modules/judgement/config";
import { configChips, runErrorText, runStatus, timeText, wizardHref } from "./judgement-labels";

describe("judgement-labels", () => {
  it("等待采集 / 等待识别只在 waiting 且有依赖时显示；其余按运行状态", () => {
    expect(runStatus({ status: "waiting", waitingOn: "demand" }).label).toBe("等待采集");
    expect(runStatus({ status: "waiting", waitingOn: "signals" }).label).toBe("等待识别");
    expect(runStatus({ status: "waiting", waitingOn: null }).label).toBe("执行中");
    expect(runStatus({ status: "running", waitingOn: null }).label).toBe("执行中");
    expect(runStatus({ status: "planned", waitingOn: null }).label).toBe("排队中");
    expect(runStatus({ status: "completed", waitingOn: "demand" }).label).toBe("已完成");
    expect(runStatus({ status: "something_new", waitingOn: null }).label).toBe("something_new"); // 未登记的原样回退
  });
  it("向导页码：草稿 → 1，已圈定 → 2，已比对 → 3；未知回到 1", () => {
    expect(wizardHref("7", "draft")).toBe("/judgement/7/wizard/1");
    expect(wizardHref("7", "circled")).toBe("/judgement/7/wizard/2");
    expect(wizardHref("7", "compared")).toBe("/judgement/7/wizard/3");
    expect(wizardHref("7", "x")).toBe("/judgement/7/wizard/1");
  });
  it("失败原因：已登记的说人话，未登记的统一「运行失败」，空值为 null", () => {
    expect(runErrorText(null)).toBeNull();
    expect(runErrorText("no_staff_assignment")).toContain("没有归属专员");
    expect(runErrorText("whatever")).toBe("运行失败");
  });
  it("时间按北京时间显示，空值为破折号", () => {
    expect(timeText(null)).toBe("—");
    expect(timeText(new Date("2026-11-16T16:05:00Z"))).toBe("11-17 00:05");
  });
  it("配置摘要：只含时间窗与形态时是两项，不预置任何能力", () => {
    const c = parseConfig({ window: { from: "2026-06-01" }, kinds: ["video", "image"] });
    expect(configChips(c)).toEqual(["时间窗 2026-06-01 ~ 执行时", "形态 视频 / 图文"]);
  });
});
