import { describe, expect, it } from "vitest";
import { decideRow } from "./settle";

const root = (over: Partial<Parameters<typeof decideRow>[0]> = {}) => ({ status: "succeeded", stopReason: null, lastErrorCode: null, lastErrorCategory: null, entryOutcome: "normal", accountCreated: true, ...over });
describe("根任务终态 → 行结果（design §7.6 映射表）", () => {
  it("成功：新建账号 → imported；已存在 → unchanged/existing_account_referenced；都建名单项", () => {
    expect(decideRow(root())).toEqual({ outcome: "imported", referenced: true });
    expect(decideRow(root({ accountCreated: false }))).toMatchObject({ outcome: "unchanged", reason: "existing_account_referenced", referenced: true });
  });
  it("疑似空账号：名单项存在", () => {
    expect(decideRow(root({ entryOutcome: "suspected_empty", stopReason: "suspected_empty" }))).toMatchObject({ outcome: "suspected_empty", referenced: true });
  });
  it("失败：归属冲突 / 名额冲突 → conflict，不建名单项", () => {
    expect(decideRow(root({ status: "failed", stopReason: "assignment_conflict", entryOutcome: null }))).toMatchObject({ outcome: "conflict", reason: "assignment_conflict", referenced: false });
    expect(decideRow(root({ status: "failed", stopReason: "staff_platform_slot_taken", entryOutcome: null }))).toMatchObject({ outcome: "conflict", reason: "staff_platform_slot_taken", referenced: false });
  });
  it("入口无效（非主页 / 平台不符 / 解析耗尽）→ invalid，原因取根任务错误码", () => {
    for (const code of ["non_home_locator", "platform_mismatch", "result_validation_exhausted"]) {
      expect(decideRow(root({ status: "failed", stopReason: "invalid_link", entryOutcome: "invalid_link", lastErrorCode: code }))).toMatchObject({ outcome: "invalid", reason: code, referenced: false });
    }
  });
  it("技术失败 / 取消 → resolve_failed，不是 invalid", () => {
    expect(decideRow(root({ status: "failed", stopReason: null, entryOutcome: null, lastErrorCategory: "provider_auth" }))).toMatchObject({ outcome: "resolve_failed", reason: "root_failed" });
    expect(decideRow(root({ status: "dead", entryOutcome: null }))).toMatchObject({ outcome: "resolve_failed", reason: "root_failed" });
    expect(decideRow(root({ status: "cancelled", entryOutcome: null }))).toMatchObject({ outcome: "resolve_failed", reason: "root_cancelled" });
  });
});
