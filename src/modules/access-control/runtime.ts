// Web 进程里的访问控制运行时：读环境变量、建连接池和认证实例，进程内只建一次（跨 Next 的热更新也只建一次）。
// `src/app` 只经这里拿到 auth，不自己读环境变量、不碰数据库。
import type { Pool } from "mysql2/promise";
import pino from "pino";
import { createDb, createPool, type Db } from "../../db/client";
import { assembleAccess } from "./assemble";
import type { AccessAuth } from "./auth-instance";
import { AccessConfigError, parseAccessConfig, type AccessConfig } from "./config";
import { FakeSmsSender, type SmsSender } from "./sms";
import { AliyunSmsSender, createAliyunSmsClient, type AliyunSmsClient } from "./sms-aliyun";

export interface AccessRuntime {
  config: AccessConfig;
  pool: Pool;
  db: Db;
  auth: AccessAuth;
  sender: SmsSender;
}

/** 按模式选择发送器。生产（aliyun）缺任一配置在 parseAccessConfig 就已启动失败，不缺省为假发送器（AX-4）。 */
export function createSender(config: AccessConfig): SmsSender {
  if (config.smsMode === "fake") return new FakeSmsSender();
  const a = config.aliyun;
  if (!a) throw new AccessConfigError(["HBECHO_SMS_MODE"]);
  let client: Promise<AliyunSmsClient> | undefined; // 首次发送时才加载 SDK
  return new AliyunSmsSender({ sendSms: async (r) => (await (client ??= createAliyunSmsClient(a))).sendSms(r) }, { signName: a.signName, templates: a.templates });
}

export function createRuntime(env: Record<string, string | undefined>): AccessRuntime {
  const config = parseAccessConfig(env);
  const url = env.HBECHO_DATABASE_URL;
  if (!url) throw new AccessConfigError(["HBECHO_DATABASE_URL"]);
  const sender = createSender(config);
  const pool = createPool(url);
  const db = createDb(pool);
  // 日志写 stderr（结构化 JSON）。低风险审计写入失败、全局短信上限告警都经这里出来，运维可以直接抓
  const logger = pino({ name: "access-control" }, pino.destination(2));
  const { auth } = assembleAccess({
    db,
    config,
    clock: { now: () => new Date() },
    sender,
    logger,
    alert: (a) => logger.warn({ alert: a }, "access.alert"),
  });
  return { config, pool, db, sender, auth };
}

const KEY = Symbol.for("hbecho.access-control.runtime");

/** 进程内单例。读环境变量缺项会抛 AccessConfigError（只列键名）。 */
export function getAccessRuntime(env: Record<string, string | undefined> = process.env): AccessRuntime {
  const g = globalThis as unknown as Record<symbol, AccessRuntime | undefined>;
  return (g[KEY] ??= createRuntime(env));
}
