// `pnpm smoke run` 的真实依赖装配。
//
// 顺序是刻意的：**只有** runSmokeCli 在 preflight 全部门槛通过后才调用 `execute`，而 `execute` 才装配
// 数据库连接、OSS 客户端与 HTTP transport。所以「没有审批记录」这条路径上，连 SDK 构造函数都不会被调用，
// 更不会读 secret。
//
// 配置全部来自环境变量（`.env` 由 smoke-main 在启动时显式载入）；缺失即失败，错误只报变量名。
import { createDb, createPool, type Db } from "../db/client";
import type { Clock, ObjectStore, ProviderTransport } from "../modules/raw-capture";
import { HttpProviderTransport, OssObjectStore } from "../modules/raw-capture";
import { readSmokeSecrets, SMOKE_ENV_VARS, SmokeConfigError, runSmoke, type SmokeAuthorized, type SmokeDeps, type SmokeSecrets, type SmokeSummary } from "../modules/smoke";

export interface SmokeConnection {
  db: Db;
  close(): Promise<void>;
}

/** 装配过程中的可替换环节；默认实现构造真实 SDK，单测注入计数/假实现。 */
export interface SmokeWiringFactories {
  openDb(url: string): SmokeConnection;
  createStore(oss: SmokeSecrets["oss"]): ObjectStore;
  createTransport(input: { apiKey: string; baseUrl: string }): ProviderTransport;
  log(line: string): void;
  clock?: Clock;
}

export function defaultSmokeFactories(): SmokeWiringFactories {
  return {
    openDb: (url) => {
      const pool = createPool(url);
      return { db: createDb(pool), close: () => pool.end() };
    },
    createStore: (oss) => new OssObjectStore(oss),
    createTransport: ({ apiKey, baseUrl }) => new HttpProviderTransport({ baseUrl, apiKey }),
    log: (line) => void process.stderr.write(`${line}\n`),
  };
}

/**
 * 返回交给 runSmokeCli 的 execute。函数体在**获批之后**才第一次执行。
 * @param env 进程环境（已含 `.env`）
 * @param factories 默认构造真实依赖；测试注入
 */
export function makeSmokeExecutor(env: Record<string, string | undefined>, factories: SmokeWiringFactories = defaultSmokeFactories()): (auth: SmokeAuthorized) => Promise<SmokeSummary> {
  return async (auth) => {
    // 先校验全部配置，再碰任何有副作用的东西（连接池、SDK 构造）
    const secrets = readSmokeSecrets(env);
    const dbUrl = env[SMOKE_ENV_VARS.databaseUrl]?.trim();
    if (!dbUrl) throw new SmokeConfigError("missing_env", SMOKE_ENV_VARS.databaseUrl);

    const conn = factories.openDb(dbUrl);
    try {
      const deps: SmokeDeps = {
        db: conn.db,
        clock: factories.clock ?? { now: () => new Date() },
        store: factories.createStore(secrets.oss),
        location: { providerCode: "aliyun-oss", region: secrets.oss.region, bucket: secrets.oss.bucket },
        secrets: { apiKey: async () => secrets.apiKey },
        makeTransport: (apiKey) => factories.createTransport({ apiKey, baseUrl: secrets.baseUrl }),
        log: factories.log,
      };
      return await runSmoke(deps, auth);
    } finally {
      await conn.close();
    }
  };
}