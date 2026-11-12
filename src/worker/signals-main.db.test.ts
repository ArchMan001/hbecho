// 任务 12：真实入口 signals-main.ts 的启动校验与装配（子进程，不连 OSS 与能力服务）。
// 缺身份、缺必填数值配置、启用集写目录外标识都在连接数据库之前失败；`run` 缺 OSS / 能力服务配置直接失败，其余命令不受影响。
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { useTestDb } from "../../tests/harness/db";

useTestDb(); // 让迁移在测试库上就绪；子进程连同一个库
const URL = process.env.HBECHO_TEST_DATABASE_URL ?? "";
const NUMERIC = {
  HBECHO_SIGNALS_SCAN_INTERVAL_MS: "1000", HBECHO_SIGNALS_SCAN_BATCH: "100", HBECHO_SIGNALS_LOOKBACK_MS: "60000", HBECHO_SIGNALS_RECONCILE_INTERVAL_MS: "1000",
  HBECHO_SIGNALS_SCORE_CONCURRENCY: "4", HBECHO_SIGNALS_TASK_MAX_ATTEMPTS: "3", HBECHO_SIGNALS_RETRY_BACKOFF_MS: "1000", HBECHO_SIGNALS_LEASE_MS: "60000",
  HBECHO_SIGNALS_SIGNED_URL_TTL_S: "600", HBECHO_SIGNALS_MATCH_TIMEOUT_MS: "5000", HBECHO_SIGNALS_DEFER_INTERVAL_MS: "30000", HBECHO_SIGNALS_DEFER_MAX: "20", HBECHO_MEDIA_MAX_BYTES: "20971520",
};
const IDENTITY = { HBECHO_SIG_ACTOR: "user:ops", HBECHO_SIG_CAPABILITIES: "rule.definition.manage,rule.definition.read", HBECHO_SIG_BRAND_SCOPE: "all" };
const FULL = { HBECHO_DATABASE_URL: URL, ...IDENTITY, ...NUMERIC };

function main(args: string[], env: Record<string, string>) {
  // 不继承父进程环境：避免把本机的 OSS 凭证带进来，也保证“缺项”真的缺
  const r = spawnSync(process.execPath, ["--import", "tsx", "src/worker/signals-main.ts", ...args], { env: { PATH: process.env.PATH ?? "", ...env } as unknown as NodeJS.ProcessEnv, encoding: "utf8", timeout: 60_000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe("signals-main 启动", () => {
  it("缺 HBECHO_DATABASE_URL / 缺任一身份变量 / 缺任一数值配置 / 启用集写目录外标识：退出码 1 并点名", () => {
    expect(main(["catalog"], {})).toMatchObject({ code: 1, err: expect.stringContaining("HBECHO_DATABASE_URL") });
    const { HBECHO_SIG_ACTOR: _a, ...noActor } = FULL;
    expect(main(["catalog"], noActor)).toMatchObject({ code: 1, err: expect.stringContaining("HBECHO_SIG_ACTOR") });
    const { HBECHO_SIG_BRAND_SCOPE: _b, ...noScope } = FULL;
    expect(main(["catalog"], noScope)).toMatchObject({ code: 1, err: expect.stringContaining("HBECHO_SIG_BRAND_SCOPE") });
    const { HBECHO_SIGNALS_SCAN_BATCH: _c, ...noBatch } = FULL;
    expect(main(["catalog"], noBatch)).toMatchObject({ code: 1, err: expect.stringContaining("HBECHO_SIGNALS_SCAN_BATCH（缺失）") });
    expect(main(["catalog"], { ...FULL, HBECHO_SIGNALS_ENABLED: "image.nope" })).toMatchObject({ code: 1 });
  });

  it("完整配置：catalog、tasks list 不需要 OSS 与能力服务；用到它们的命令报“未配置”；run 缺配置直接失败并点名", () => {
    const cat = main(["catalog"], FULL);
    expect(cat.code).toBe(0);
    expect(JSON.parse(cat.out).signals).toHaveLength(12);
    const list = main(["tasks", "list"], FULL);
    expect(list.code).toBe(0);
    expect(JSON.parse(list.out)).toEqual({ ok: true, tasks: [] });
    const noOss = main(["segment", "check", "--plan", "1", "--version", "1"], FULL);
    expect(noOss.code).toBe(4); // 监控段不存在：check 不需要 OSS
    const run = main(["run"], FULL);
    expect(run.code).toBe(1);
    expect(run.err).toContain("OSS_BUCKET_SIGNALS");
  });
});
