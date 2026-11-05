import { describe, expect, it } from "vitest";
import { SyncConfigError, parseSyncWorkerConfig } from "./sync-config";

const FULL = {
  HBECHO_DATABASE_URL: "mysql://u:p@127.0.0.1:3306/db_test",
  HBECHO_SYNC_PROFILE_MODE: "synchronous",
  HBECHO_SYNC_LIST_MODE: "synchronous",
  HBECHO_SYNC_DETAIL_MODE: "synchronous",
  HBECHO_SYNC_COMMENTS_MODE: "synchronous",
  HBECHO_SYNC_CONCURRENCY: "4",
  HBECHO_SYNC_PROVIDER_QPS: "2",
  HBECHO_SYNC_MEDIA_CONCURRENCY: "2",
  HBECHO_SYNC_BREAKER_FAILURES: "10",
  HBECHO_SYNC_BREAKER_COOLDOWN_MS: "300000",
  HBECHO_SYNC_BATCH_MAX_CALLS: "25000",
  HBECHO_SYNC_BATCH_MAX_POINTS: "210000",
  HBECHO_MEDIA_TMP_DIR: "/var/tmp/hbecho-media",
  HBECHO_MEDIA_MAX_BYTES: "2147483648",
  HBECHO_MEDIA_BATCH_MAX_BYTES: "53687091200",
  HBECHO_CAPABILITY_URL: "http://capability:8080",
};
const without = (...keys: string[]) => Object.fromEntries(Object.entries(FULL).filter(([k]) => !keys.includes(k)));
const problems = (env: Record<string, string | undefined>) => {
  try {
    parseSyncWorkerConfig(env);
  } catch (e) {
    if (e instanceof SyncConfigError) return e.problems;
    throw e;
  }
  return null;
};

describe("worker 配置（缺失即启动失败）", () => {
  it("完整配置解析成功；非花钱的旋钮有默认值，环境缺省为 production（fail closed）", () => {
    const c = parseSyncWorkerConfig(FULL);
    expect(c).toMatchObject({
      environment: "production",
      concurrency: 4,
      providerQps: 2,
      mediaConcurrency: 2,
      breaker: { failures: 10, cooldownMs: 300000 },
      batchBudget: { maxCalls: 25000, maxPoints: 210000 },
      media: { tmpDir: "/var/tmp/hbecho-media", maxBytes: 2147483648, batchMaxBytes: 53687091200, capabilityUrl: "http://capability:8080" },
      leaseMs: 120_000,
      graceMs: 30_000,
      idlePollMs: 5_000,
    });
  });
  it("缺少任一必需变量都失败，且一次列出所有缺项（含熔断阈值与冷却期）", () => {
    for (const key of Object.keys(FULL)) expect(problems(without(key))?.map((p) => p.name), key).toEqual([key]);
    const many = problems(without("HBECHO_SYNC_BREAKER_FAILURES", "HBECHO_SYNC_BREAKER_COOLDOWN_MS", "HBECHO_SYNC_PROVIDER_QPS"));
    expect(many?.map((p) => [p.name, p.problem]).sort()).toEqual([
      ["HBECHO_SYNC_BREAKER_COOLDOWN_MS", "missing"],
      ["HBECHO_SYNC_BREAKER_FAILURES", "missing"],
      ["HBECHO_SYNC_PROVIDER_QPS", "missing"],
    ]);
  });
  it("空字符串等同缺失；非法值标为 invalid（0 并发、负 QPS、非整数）", () => {
    expect(problems({ ...FULL, HBECHO_SYNC_CONCURRENCY: "" })).toEqual([expect.objectContaining({ name: "HBECHO_SYNC_CONCURRENCY", problem: "missing" })]);
    for (const [k, v] of [["HBECHO_SYNC_CONCURRENCY", "0"], ["HBECHO_SYNC_PROVIDER_QPS", "-1"], ["HBECHO_SYNC_BATCH_MAX_POINTS", "1.5"], ["HBECHO_SYNC_PROFILE_MODE", "batch"], ["HBECHO_CAPABILITY_URL", "ftp://x"], ["HBECHO_MEDIA_MAX_BYTES", "0"]] as const) {
      expect(problems({ ...FULL, [k]: v })?.[0], k).toMatchObject({ name: k, problem: "invalid" });
    }
  });
  it("staging 被拒绝：它没有任何 capability 行，启动后所有任务都会被拒绝", () => {
    expect(problems({ ...FULL, HBECHO_ENV: "staging" })?.[0]).toMatchObject({ name: "HBECHO_ENV", problem: "invalid" });
    expect(parseSyncWorkerConfig({ ...FULL, HBECHO_ENV: "test" }).environment).toBe("test");
  });
  it("错误信息只含变量名，不含取值（数据库口令不会进日志）", () => {
    try {
      parseSyncWorkerConfig({ ...FULL, HBECHO_DATABASE_URL: "mysql://u:topsecret@h/db", HBECHO_SYNC_CONCURRENCY: "x" });
    } catch (e) {
      expect((e as Error).message).not.toContain("topsecret");
    }
  });
});
