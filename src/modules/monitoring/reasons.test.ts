import { describe, expect, it } from "vitest";
import { firstExclusionReason, type MonitoringFacts } from "./reasons";

const ok: MonitoringFacts = {
  accountStatus: "active",
  intakeStatus: "normal",
  watchType: "staff",
  assignmentEnabled: true,
  brandStatus: "active",
  regionStatus: "active",
  branch: { status: "active", enabled: true },
  dealer: { status: "active", enabled: true },
  store: { status: "active", enabled: true },
  staff: { status: "active", enabled: true },
};
const with_ = (patch: Partial<MonitoringFacts>): MonitoringFacts => ({ ...ok, ...patch });

describe("firstExclusionReason：最上级优先", () => {
  it("全部有效 → null；unavailable 账号仍被采集", () => {
    expect(firstExclusionReason(ok)).toBeNull();
    expect(firstExclusionReason(with_({ accountStatus: "unavailable" }))).toBeNull();
  });
  it.each([
    ["账号 deleted", with_({ accountStatus: "deleted" }), "deleted"],
    ["疑似空账号", with_({ intakeStatus: "suspected_empty" }), "suspected_empty"],
    ["品牌无效", with_({ brandStatus: "inactive" }), "brand_inactive"],
    ["大区无效", with_({ regionStatus: "inactive" }), "region_inactive"],
    ["分公司无效", with_({ branch: { status: "inactive", enabled: true } }), "branch_inactive"],
    ["分公司关闭监控", with_({ branch: { status: "active", enabled: false } }), "branch_off"],
    ["经销商无效", with_({ dealer: { status: "inactive", enabled: true } }), "dealer_inactive"],
    ["经销商关闭监控", with_({ dealer: { status: "active", enabled: false } }), "dealer_off"],
    ["门店撤店", with_({ store: { status: "closed", enabled: true } }), "store_closed"],
    ["门店关闭监控", with_({ store: { status: "active", enabled: false } }), "store_off"],
    ["专员停用", with_({ staff: { status: "inactive", enabled: true } }), "staff_inactive"],
    ["专员关闭监控", with_({ staff: { status: "active", enabled: false } }), "staff_off"],
    ["账号关闭监控", with_({ assignmentEnabled: false }), "account_off"],
  ] as const)("%s → %s", (_n, facts, reason) => {
    expect(firstExclusionReason(facts)).toBe(reason);
  });
  it("同一级内：业务状态无效先于开关关闭", () => {
    expect(firstExclusionReason(with_({ branch: { status: "inactive", enabled: false } }))).toBe("branch_inactive");
    expect(firstExclusionReason(with_({ staff: { status: "inactive", enabled: false } }))).toBe("staff_inactive");
  });
  it("多个条件同时不满足：取最上级（品牌 > 大区 > 分公司 > 经销商 > 门店 > 专员 > 账号）", () => {
    const all = with_({
      brandStatus: "inactive",
      regionStatus: "inactive",
      branch: { status: "inactive", enabled: false },
      dealer: { status: "inactive", enabled: false },
      store: { status: "closed", enabled: false },
      staff: { status: "inactive", enabled: false },
      assignmentEnabled: false,
    });
    expect(firstExclusionReason(all)).toBe("brand_inactive");
    expect(firstExclusionReason({ ...all, brandStatus: "active" })).toBe("region_inactive");
    expect(firstExclusionReason({ ...all, brandStatus: "active", regionStatus: "active" })).toBe("branch_inactive");
    expect(firstExclusionReason(with_({ ...all, accountStatus: "deleted" }))).toBe("deleted");
    expect(firstExclusionReason(with_({ ...all, intakeStatus: "suspected_empty" }))).toBe("suspected_empty");
  });
  it("上级关闭时下级自身开关值不影响结论（不改写下级值，上级恢复后按原值继续）", () => {
    expect(firstExclusionReason(with_({ dealer: { status: "active", enabled: false }, staff: { status: "active", enabled: true } }))).toBe("dealer_off");
    expect(firstExclusionReason(with_({ dealer: { status: "active", enabled: true }, staff: { status: "active", enabled: true } }))).toBeNull();
  });
  it("external 型只受账号状态与自身开关约束，不受五级与品牌 / 大区影响", () => {
    const ext = with_({
      watchType: "external",
      brandStatus: null,
      regionStatus: null,
      branch: { status: null, enabled: null },
      dealer: { status: null, enabled: null },
      store: { status: null, enabled: null },
      staff: { status: null, enabled: null },
    });
    expect(firstExclusionReason(ext)).toBeNull();
    expect(firstExclusionReason({ ...ext, assignmentEnabled: false })).toBe("account_off");
    expect(firstExclusionReason({ ...ext, accountStatus: "deleted" })).toBe("deleted");
  });
  it("staff 型缺失的上级（连接不到）按无效处理，而不是默默放行", () => {
    expect(firstExclusionReason(with_({ dealer: { status: null, enabled: null } }))).toBe("dealer_inactive");
  });
});
