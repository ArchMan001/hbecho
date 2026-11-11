import { describe, expect, it } from "vitest";
import { EXCLUSION_REASONS } from "../monitoring/reasons";
import { composeStatus, EXCLUSION_LABELS, type StatusFacts } from "./status";

const base: StatusFacts = { intakeStatus: "normal", exclusion: null, assignmentEnabled: true, closedReason: null, entryState: "in_roster" };
const st = (over: Partial<StatusFacts>) => composeStatus({ ...base, ...over });

describe("综合账号状态：六种取值", () => {
  it("正常采集", () => expect(st({})).toMatchObject({ code: "normal", label: "正常采集" }));
  it("链接无效（行结果 invalid）", () => expect(st({ rowOutcome: "invalid" })).toMatchObject({ code: "invalid_link" }));
  it("疑似空账号", () => expect(st({ intakeStatus: "suspected_empty", exclusion: "suspected_empty" })).toMatchObject({ code: "suspected_empty" }));
  it("XX 被关闭：取最上级原因", () => expect(st({ exclusion: "branch_off" })).toMatchObject({ code: "upstream_closed", label: "分公司被关闭", detail: "branch_off" }));
  it("被停止监控：区分人工与无引用", () => {
    expect(st({ exclusion: "account_off", assignmentEnabled: false, closedReason: "manual" })).toMatchObject({ code: "monitoring_stopped", detail: "人工停止" });
    expect(st({ exclusion: "account_off", assignmentEnabled: false, closedReason: "unreferenced_15d" })).toMatchObject({ code: "monitoring_stopped", detail: "无计划引用自动停采" });
  });
  it("已移出活动计划", () => expect(st({ entryState: "removed" })).toMatchObject({ code: "removed_from_plan" }));
});

describe("优先级冲突组合（A §11.6）：链接无效 > 疑似空 > XX 被关闭 > 被停止监控 > 已移出 > 正常", () => {
  it("逐级压过下一级", () => {
    const all: Partial<StatusFacts> = { rowOutcome: "invalid", intakeStatus: "suspected_empty", exclusion: "store_off", assignmentEnabled: false, closedReason: "manual", entryState: "removed" };
    expect(st(all).code).toBe("invalid_link");
    expect(st({ ...all, rowOutcome: null }).code).toBe("suspected_empty");
    expect(st({ ...all, rowOutcome: null, intakeStatus: "normal" }).code).toBe("upstream_closed");
    expect(st({ ...all, rowOutcome: null, intakeStatus: "normal", exclusion: "account_off" }).code).toBe("monitoring_stopped");
    expect(st({ ...all, rowOutcome: null, intakeStatus: "normal", exclusion: null, assignmentEnabled: true }).code).toBe("removed_from_plan");
  });
  it("账号自身开关关着但上级也关：以最上级为准", () => {
    expect(st({ exclusion: "dealer_off", assignmentEnabled: false, closedReason: "manual" }).code).toBe("upstream_closed");
  });
});

describe("explain 返回的全部排除原因都必须有文案（遗漏使测试失败）", () => {
  it.each([...EXCLUSION_REASONS])("%s", (reason) => {
    expect(EXCLUSION_LABELS[reason], reason).toBeTruthy();
    expect(EXCLUSION_LABELS[reason]).not.toMatch(/_/); // 界面不出现内部字段名
  });
  it("已停用 / 已撤店显示为业务状态文案", () => {
    expect(st({ exclusion: "staff_inactive" }).label).toBe("专员已停用");
    expect(st({ exclusion: "store_closed" }).label).toBe("门店已撤店");
    expect(st({ exclusion: "brand_inactive" }).label).toBe("品牌已停用");
    expect(st({ exclusion: "region_inactive" }).label).toBe("大区已停用");
  });
});
