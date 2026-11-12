import { describe, expect, it } from "vitest";
import { parseSignalsConfig } from "./config";
import { SignalError } from "./errors";

// 测试用取值，不是推荐值（推荐起始值在 design §14 第 14 项，由运维实测后写进 .env）
const FULL = {
  HBECHO_SIGNALS_SCAN_INTERVAL_MS: "1000",
  HBECHO_SIGNALS_SCAN_BATCH: "10",
  HBECHO_SIGNALS_LOOKBACK_MS: "2000",
  HBECHO_SIGNALS_RECONCILE_INTERVAL_MS: "3000",
  HBECHO_SIGNALS_SCORE_CONCURRENCY: "1",
  HBECHO_SIGNALS_TASK_MAX_ATTEMPTS: "3",
  HBECHO_SIGNALS_RETRY_BACKOFF_MS: "500",
  HBECHO_SIGNALS_LEASE_MS: "40000",
  HBECHO_SIGNALS_SIGNED_URL_TTL_S: "60",
  HBECHO_SIGNALS_MATCH_TIMEOUT_MS: "5000",
  HBECHO_SIGNALS_DEFER_INTERVAL_MS: "6000",
  HBECHO_SIGNALS_DEFER_MAX: "7",
  HBECHO_MEDIA_MAX_BYTES: "20971520",
};
const problems = (env: Record<string, string | undefined>): Array<{ name: string; problem: string }> => {
  try {
    parseSignalsConfig(env);
  } catch (e) {
    if (e instanceof SignalError) return (e.detail as Array<{ name: string; problem: string }>).map(({ name, problem }) => ({ name, problem }));
    throw e;
  }
  return [];
};

describe("parseSignalsConfig", () => {
  it("完整配置：解析为数值；启用集缺省只含文本类", () => {
    const c = parseSignalsConfig(FULL);
    expect(c).toMatchObject({ scanIntervalMs: 1000, scanBatch: 10, lookbackMs: 2000, leaseMs: 40000, signedUrlTtlSeconds: 60, deferMax: 7 });
    expect([...c.enabled].every((id) => id.startsWith("text."))).toBe(true);
  });
  for (const name of Object.keys(FULL)) {
    it(`缺 ${name}：启动失败并指出缺哪一项（没有代码默认值）`, () => {
      const env: Record<string, string | undefined> = { ...FULL };
      delete env[name];
      expect(problems(env)).toEqual([{ name, problem: "missing" }]);
    });
  }
  it("一次列出所有缺项与非法项", () => {
    expect(problems({ ...FULL, HBECHO_SIGNALS_SCAN_BATCH: "0", HBECHO_SIGNALS_LEASE_MS: "", HBECHO_SIGNALS_DEFER_MAX: "abc" })).toEqual([
      { name: "HBECHO_SIGNALS_SCAN_BATCH", problem: "invalid" },
      { name: "HBECHO_SIGNALS_LEASE_MS", problem: "missing" },
      { name: "HBECHO_SIGNALS_DEFER_MAX", problem: "invalid" },
    ]);
  });
  it("租约不大于匹配超时：启动失败（调用期间不续租约，会被别人接手而重复计算）", () => {
    expect(() => parseSignalsConfig({ ...FULL, HBECHO_SIGNALS_LEASE_MS: "5000" })).toThrowError(expect.objectContaining({ code: "lease_shorter_than_match_timeout" }));
    expect(() => parseSignalsConfig({ ...FULL, HBECHO_SIGNALS_LEASE_MS: "5001" })).not.toThrow();
  });
  it("启用集写目录外的能力标识：启动失败", () => {
    expect(() => parseSignalsConfig({ ...FULL, HBECHO_SIGNALS_ENABLED: "image.ocr" })).toThrowError(expect.objectContaining({ code: "enabled_unknown_capability" }));
  });
});
