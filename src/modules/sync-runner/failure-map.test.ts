import { describe, expect, it } from "vitest";
import { FAILURE_SPECS, specOf, transitionFor, type FailureCode } from "./failure-map";

const NOW = new Date("2026-11-08T18:00:00Z");
const RETRY = { baseBackoffMs: 1000, maxBackoffMs: 8000 };
const task = (attemptCount: number, maxAttempts = 3) => ({ attemptCount, maxAttempts });

describe("失败 → 任务去向（FS-12.2）", () => {
  it("可重试：attempt+1，指数退避，封顶；进入 retry_wait", () => {
    const t = (n: number) => transitionFor(task(n, 10), "rate_limited", NOW, RETRY);
    expect(t(0)).toEqual({ status: "retry_wait", attemptCount: 1, nextAttemptAt: new Date(NOW.getTime() + 1000) });
    expect(t(1)).toMatchObject({ attemptCount: 2, nextAttemptAt: new Date(NOW.getTime() + 2000) });
    expect(t(3)).toMatchObject({ attemptCount: 4, nextAttemptAt: new Date(NOW.getTime() + 8000) });
    expect(t(8)).toMatchObject({ attemptCount: 9, nextAttemptAt: new Date(NOW.getTime() + 8000) }); // 封顶
  });
  it("供应商给了 Retry-After 时取更长的那个，不会比退避更短", () => {
    expect(transitionFor(task(0), "rate_limited", NOW, RETRY, 30_000)).toMatchObject({ nextAttemptAt: new Date(NOW.getTime() + 30_000) });
    expect(transitionFor(task(0), "rate_limited", NOW, RETRY, 10)).toMatchObject({ nextAttemptAt: new Date(NOW.getTime() + 1000) });
  });
  it("额度用尽 → dead（死信），attempt_count 等于 max_attempts，不超过", () => {
    expect(transitionFor(task(2), "provider_server_error", NOW, RETRY)).toEqual({ status: "dead", attemptCount: 3 });
    expect(transitionFor(task(3), "provider_server_error", NOW, RETRY)).toEqual({ status: "dead", attemptCount: 3 });
  });
  it("不可重试 → failed，仍消耗这次尝试", () => {
    expect(transitionFor(task(0), "provider_input_inaccessible", NOW, RETRY)).toEqual({ status: "failed", attemptCount: 1 });
    expect(transitionFor(task(3), "profile_uid_mismatch", NOW, RETRY)).toEqual({ status: "failed", attemptCount: 3 });
  });
  it("没有发出调用的失败不消耗额度：预算耗尽、能力未启用、平台不支持、URL 无法构造", () => {
    for (const code of ["budget_exhausted", "capability_disabled", "unsupported_platform", "content_url_unavailable", "unsupported_action", "locator_unavailable", "task_parameters_invalid"] as const) {
      expect(transitionFor(task(1), code, NOW, RETRY), code).toEqual({ status: "failed", attemptCount: 1 });
    }
  });
  it("监控资格失效 → cancelled（不是失败），不消耗额度", () => {
    expect(transitionFor(task(0), "monitoring_closed", NOW, RETRY)).toEqual({ status: "cancelled", attemptCount: 0 });
  });
});

describe("失败码分类（design §7.5.1、§8）", () => {
  it("只有供应商级失败计入熔断：429、5xx、传输、超时、ambiguous", () => {
    const counted = (Object.keys(FAILURE_SPECS) as FailureCode[]).filter((c) => specOf(c).breaker).sort();
    expect(counted).toEqual(["ambiguous_unresolved", "provider_server_error", "rate_limited", "transport_failure", "transport_timeout"]);
  });
  it("RESULT_VALIDATION_FAILED、HTTP 400、身份不符、字段缺失、解析失败都不计入熔断", () => {
    for (const c of ["provider_validation_failed", "provider_null_result", "provider_task_failed", "provider_request_rejected", "profile_uid_mismatch", "profile_fields_missing", "invalid_response", "schema_drift"] as const) {
      expect(specOf(c).breaker, c).toBe(false);
    }
  });
  it("RESULT_VALIDATION_FAILED 一类可重试（可能是供应商间歇失败），耗尽后才是稳定失败", () => {
    expect(specOf("provider_validation_failed").retry).toBe(true);
    expect(specOf("provider_input_inaccessible").retry).toBe(false);
  });
  it("认证 / 输入被拒绝（400、401、403）不重试：配置修好之前重试只是浪费", () => {
    expect(specOf("provider_request_rejected").retry).toBe(false);
    expect(specOf("provider_auth").retry).toBe(false);
  });
  it("每个失败码都有完整的规格；终态只有 failed 或 cancelled", () => {
    for (const [code, s] of Object.entries(FAILURE_SPECS)) {
      expect(["failed", "cancelled"], code).toContain(s.terminal);
      if (s.terminal === "cancelled") expect(s.retry).toBe(false);
      if (s.breaker) expect(s.retry, code).toBe(true); // 供应商级故障总是值得重试
    }
  });
});
