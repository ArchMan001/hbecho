import { describe, expect, it } from "vitest";
import { JUDGEMENT_ENV_KEYS, parseJudgementEnv } from "./env";
import { JudgementError } from "./errors";

const FULL: Record<string, string> = {
  HBECHO_JP_BLOCK_SIZE: "200", HBECHO_JP_SIGNAL_BATCH: "1000", HBECHO_JP_DEMAND_BATCH: "1000", HBECHO_JP_POLL_SECONDS: "30",
  HBECHO_JP_WAIT_SIGNAL_SECONDS: "600", HBECHO_JP_WAIT_DEMAND_SECONDS: "7200", HBECHO_JP_LEASE_SECONDS: "120", HBECHO_JP_TICK_BUDGET_MS: "5000",
  HBECHO_JP_PHASE_MAX_ATTEMPTS: "5", HBECHO_JP_MAX_ITEMS: "50", HBECHO_JP_MAX_KEYWORD_LENGTH: "64",
  HBECHO_JP_TRIAL_RETENTION_DAYS: "30", HBECHO_JP_KEEP_CONTENT_RUNS: "5", HBECHO_JP_FAILED_RETENTION_DAYS: "30",
};
const fail = (env: Record<string, string | undefined>): JudgementError => {
  try {
    parseJudgementEnv(env);
  } catch (e) {
    return e as JudgementError;
  }
  throw new Error("期望抛错");
};
describe("parseJudgementEnv（没有代码默认值）", () => {
  it("全部给出 → 解析成数字", () => {
    expect(parseJudgementEnv(FULL)).toMatchObject({ blockSize: 200, waitSignalSeconds: 600, keepContentRuns: 5 });
    expect(JUDGEMENT_ENV_KEYS).toHaveLength(14);
  });
  it("缺任一项都失败并指出缺哪一项（逐项）", () => {
    for (const key of JUDGEMENT_ENV_KEYS) {
      const { [key]: _gone, ...rest } = FULL;
      const e = fail(rest);
      expect(e.code).toBe("config_missing");
      expect(e.message).toContain(key);
    }
    expect(fail({}).message).toContain("HBECHO_JP_BLOCK_SIZE");
  });
  it("空串、非整数、负数、0（等待上限除外）、批大小超过 5000 都被拒", () => {
    expect(fail({ ...FULL, HBECHO_JP_BLOCK_SIZE: "" }).code).toBe("config_missing");
    for (const bad of ["abc", "-1", "1.5", "0"]) expect(fail({ ...FULL, HBECHO_JP_BLOCK_SIZE: bad }).code, bad).toBe("config_invalid");
    expect(fail({ ...FULL, HBECHO_JP_SIGNAL_BATCH: "5001" }).message).toContain("5000");
    expect(parseJudgementEnv({ ...FULL, HBECHO_JP_SIGNAL_BATCH: "5000" }).signalBatch).toBe(5000);
  });
  it("等待上限为 0 合法（所有在等的依赖立即 dependency_timeout）", () => {
    expect(parseJudgementEnv({ ...FULL, HBECHO_JP_WAIT_SIGNAL_SECONDS: "0", HBECHO_JP_WAIT_DEMAND_SECONDS: "0" })).toMatchObject({ waitSignalSeconds: 0, waitDemandSeconds: 0 });
  });
});
