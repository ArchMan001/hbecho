// smoke 的真实依赖装配边界：
//  1) 配置缺失/不合法 → 只报变量名，且在构造任何客户端之前失败；
//  2) 没有审批记录 → 执行器根本不被调用，即使环境变量齐全也不会构造 transport / OSS / 连接池。
import { describe, expect, it } from "vitest";
import { jcsSha256Hex } from "../modules/canonical-json";
import { readSmokeSecrets, SMOKE_ENV_VARS, SMOKE_SWITCH_ENV, SMOKE_SWITCH_VALUE, SmokeConfigError } from "../modules/smoke";
import { runSmokeCli } from "./smoke-cli";
import { makeSmokeExecutor, type SmokeWiringFactories } from "./smoke-wiring";

const SECRET = "sk-FAKE-WIRING-TEST-0123456789";
const OSS_SECRET = "FAKE-OSS-WIRING-TEST-9876543210";

const fullEnv = (): Record<string, string> => ({
  [SMOKE_ENV_VARS.apiKey]: SECRET,
  [SMOKE_ENV_VARS.baseUrl]: "https://openapi.example.test",
  [SMOKE_ENV_VARS.ossAccessKeyId]: "LTAI-test-id",
  [SMOKE_ENV_VARS.ossAccessKeySecret]: OSS_SECRET,
  [SMOKE_ENV_VARS.ossRegion]: " cn-beijing ",
  [SMOKE_ENV_VARS.ossBucketOds]: "hbecho-ods",
  [SMOKE_ENV_VARS.databaseUrl]: "mysql://u:p@127.0.0.1:3306/hbecho_test",
  [SMOKE_SWITCH_ENV]: SMOKE_SWITCH_VALUE,
});

function counters() {
  const calls: string[] = [];
  const factories: SmokeWiringFactories = {
    openDb: () => {
      calls.push("openDb");
      throw new Error("不应被调用");
    },
    createStore: () => {
      calls.push("createStore");
      throw new Error("不应被调用");
    },
    createTransport: () => {
      calls.push("createTransport");
      throw new Error("不应被调用");
    },
    log: () => undefined,
  };
  return { calls, factories };
}

describe("readSmokeSecrets", () => {
  it("只报变量名，不回显值；region 会 trim", () => {
    const s = readSmokeSecrets(fullEnv());
    expect(s).toMatchObject({ apiKey: SECRET, oss: { region: "cn-beijing", bucket: "hbecho-ods" } });
    expect(s.oss.endpoint).toBeUndefined();
  });

  it("任一必填缺失 → missing_env，消息只含变量名", () => {
    for (const key of [SMOKE_ENV_VARS.apiKey, SMOKE_ENV_VARS.ossAccessKeySecret, SMOKE_ENV_VARS.ossBucketOds]) {
      const env = { ...fullEnv() };
      delete (env as Record<string, string | undefined>)[key];
      const err = (() => {
        try {
          readSmokeSecrets(env);
          return null;
        } catch (e) {
          return e;
        }
      })();
      expect(err).toBeInstanceOf(SmokeConfigError);
      expect(err).toMatchObject({ code: "missing_env", variable: key });
      expect(String((err as Error).message)).not.toContain(SECRET);
      expect(String((err as Error).message)).not.toContain(OSS_SECRET);
    }
  });

  it("非法 baseUrl / region / 桶名 → invalid_env", () => {
    expect(() => readSmokeSecrets({ ...fullEnv(), [SMOKE_ENV_VARS.baseUrl]: "nope" })).toThrow(/AIMASTER_BASE_URL 不合法/);
    expect(() => readSmokeSecrets({ ...fullEnv(), [SMOKE_ENV_VARS.ossRegion]: "北京" })).toThrow(/OSS_REGION 不合法/);
    expect(() => readSmokeSecrets({ ...fullEnv(), [SMOKE_ENV_VARS.ossBucketOds]: "Bad_Bucket" })).toThrow(/OSS_BUCKET_ODS 不合法/);
  });
});

describe("makeSmokeExecutor", () => {
  it("没有审批记录：即使环境变量齐全，也不会构造 transport / OSS / 连接池", async () => {
    const { calls, factories } = counters();
    const env = fullEnv();
    const out: string[] = [];
    const plan = {
      schema_version: "data-foundation-smoke-plan.v1",
      environment: "production",
      allowlist: [{ platform: "douyin", action: "media_user_info", mode: "synchronous", locator: "https://v.douyin.com/MPOAlEqWpec/" }],
      budget: { max_calls: 1, max_polls: 0, max_points: 10 },
      deadline_ms: 60_000,
    };
    const code = await runSmokeCli(["run", "--plan", "plan.json"], {
      readJson: async () => plan,
      env,
      now: () => new Date("2026-11-04T12:00:00.000Z"),
      stdout: (s) => out.push(s),
      stderr: () => undefined,
      execute: makeSmokeExecutor(env, factories),
    });
    expect(code).toBe(2);
    expect(JSON.parse(out.join(""))).toMatchObject({ ok: false, error: { code: "approval_missing" } });
    expect(calls).toEqual([]);
  });

  it("获批后先校验配置：缺 HBECHO_DATABASE_URL 时不打开任何连接", async () => {
    const { calls, factories } = counters();
    const env = fullEnv();
    delete (env as Record<string, string | undefined>)[SMOKE_ENV_VARS.databaseUrl];
    const execute = makeSmokeExecutor(env, factories);
    const err = await execute({} as never).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "missing_env", variable: "HBECHO_DATABASE_URL" });
    expect(calls).toEqual([]);
  });

  it("缺 secret 时同样在打开连接之前失败", async () => {
    const { calls, factories } = counters();
    const env = fullEnv();
    delete (env as Record<string, string | undefined>)[SMOKE_ENV_VARS.apiKey];
    const execute = makeSmokeExecutor(env, factories);
    await expect(execute({} as never)).rejects.toMatchObject({ code: "missing_env", variable: SMOKE_ENV_VARS.apiKey });
    expect(calls).toEqual([]);
  });
});