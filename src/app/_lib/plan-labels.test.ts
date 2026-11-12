// 活动计划页面用语的覆盖守护：模块里出现的状态码 / 事件码 / 结果码，界面都必须有人话（遗漏使测试失败）。
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { IMPORT_STATUSES, PRECHECK_CLASSES, ROW_OUTCOMES } from "../../db/schema/import";
import { ACCOUNT_STATUS_TONE, bjt, BATCH_STATUS, changeText, OUTCOME_LABEL, PLAN_STATUS, PRECHECK_LABEL, sectorText } from "./plan-labels";
import { bjtToday, hrefWith, pageOf } from "./plan-url";

describe("用语覆盖", () => {
  it("批次状态、预检分类、行结果、综合状态、计划状态都有人话", () => {
    expect(IMPORT_STATUSES.filter((s) => !BATCH_STATUS[s])).toEqual([]);
    expect(PRECHECK_CLASSES.filter((s) => !PRECHECK_LABEL[s])).toEqual([]);
    expect(ROW_OUTCOMES.filter((s) => !OUTCOME_LABEL[s])).toEqual([]);
    expect(["collecting", "paused", "archived", "deleted"].filter((s) => !PLAN_STATUS[s])).toEqual([]);
    expect(["normal", "suspected_empty", "invalid_link", "upstream_closed", "monitoring_stopped", "removed_from_plan"].filter((s) => !ACCOUNT_STATUS_TONE[s])).toEqual([]);
  });

  it("模块写进变更记录的每一种事件码，变更记录标签页都有标题（不会显示内部事件码）", () => {
    const dir = join(__dirname, "../../modules");
    const files = ["activity-plan", "activity-plan/roster"].flatMap((d) => readdirSync(join(dir, d)).filter((f) => f.endsWith(".ts") && !f.includes(".test.")).map((f) => join(dir, d, f)));
    const events = new Set<string>(["owner_replaced"]); // owners.ts 里 type 是 current ? replaced : claimed，字面量不在 eventType: 后面
    for (const f of files) for (const m of readFileSync(f, "utf8").matchAll(/eventType:\s*"([a-z_]+)"/g)) events.add(m[1]!);
    expect(events.size).toBeGreaterThanOrEqual(10);
    expect([...events].filter((e) => changeText(e, null, null).title === e)).toEqual([]);
  });

  it("变更记录文案：状态变更与分公司退出带上具体数字", () => {
    expect(changeText("plan_status_changed", { from: "collecting", to: "paused" }, null)).toEqual({ title: "状态变更", text: "采集中 → 暂停" });
    expect(changeText("branch_exited", { roster_entries_removed: 3, owners_released: 2, accounts_closed: 1 }, "北京分公司").text).toBe("北京分公司：移出名单 3 项，释放负责人 2 个，关闭监控 1 个");
    expect(changeText("unknown_event", null, null)).toEqual({ title: "unknown_event", text: "" });
  });
});

describe("格式与 URL 状态", () => {
  it("时间按北京时间精确到分钟，缺失显示 —", () => {
    expect(bjt("2026-11-11T16:30:59.000Z")).toBe("2026-11-12 00:30");
    expect(bjt(null)).toBe("—");
    expect(sectorText(["home", "water", "x"])).toBe("家装、水机、x");
  });
  it("hrefWith：空值与 all 不进 URL，其余保留；pageOf 把页码夹在范围内", () => {
    expect(hrefWith("/plans", { brand: "HITACHI", status: "all" }, { page: "2" })).toBe("/plans?brand=HITACHI&page=2");
    expect(hrefWith("/plans", { brand: "HITACHI" }, { brand: undefined })).toBe("/plans");
    expect(pageOf("9", 41)).toEqual({ page: 3, pages: 3, offset: 40 });
    expect(pageOf(undefined, 0)).toEqual({ page: 1, pages: 1, offset: 0 });
    expect(pageOf("abc", 5)).toEqual({ page: 1, pages: 1, offset: 0 });
    expect(bjtToday()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
