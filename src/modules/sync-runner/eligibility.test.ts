import { describe, expect, it } from "vitest";
import { checkEligibility } from "./eligibility";

const resolver = (effective: boolean, reason: string | null = null) => ({ explain: async () => ({ effective, reason: reason as never }) });

describe("领取时资格复核", () => {
  it("需要复核的动作：账号有效 → 通过；失效 → 带原因码拒绝", async () => {
    expect(await checkEligibility(resolver(true), { requestedAction: "fetch_profile", accountId: 1n })).toEqual({ ok: true });
    expect(await checkEligibility(resolver(false, "store_closed"), { requestedAction: "fetch_content_list", accountId: 1n })).toEqual({ ok: false, reason: "store_closed" });
  });
  it("详情与评论同样复核（按需任务也不能对已关闭监控的账号调用供应商）", async () => {
    for (const a of ["fetch_content_detail", "fetch_comments"]) {
      expect(await checkEligibility(resolver(false, "account_off"), { requestedAction: a, accountId: 2n }), a).toEqual({ ok: false, reason: "account_off" });
    }
  });
  it("需要复核却没有 account_id → fail closed，不放行", async () => {
    for (const a of ["fetch_profile", "fetch_content_list", "fetch_content_detail", "fetch_comments"]) {
      expect(await checkEligibility(resolver(true), { requestedAction: a, accountId: null }), a).toEqual({ ok: false, reason: "no_account_reference" });
    }
  });
  it("媒资下载不调供应商，不复核（也不需要 account_id）", async () => {
    expect(await checkEligibility(resolver(false, "account_off"), { requestedAction: "download_media", accountId: null })).toEqual({ ok: true });
  });
});
