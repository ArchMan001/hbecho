// 装配：把视频广场接到访问控制的运行时（授权器、审计）与正式媒资桶（只用来给封面签短期读取地址）。
// 页面进程（src/app/_lib/square.ts）、CLI（worker/square-main.ts）与测试共用这一份，所以测试证明的就是生产接线。
import type { Logger } from "pino";
import type { Db } from "../../db/client";
import { createAuditWriter, createAuthorizer, defaultRegistry, denialAuditor, type AccessRegistry } from "../access-control";
import { OssObjectStore, type Clock, type MediaObjectStore } from "../raw-capture";
import type { SquareDeps } from "./deps";
import { createSquareStrategy } from "./policy";

export interface SquareEnvConfig {
  accessKeyId: string;
  accessKeySecret: string;
  region: string;
  bucket: string;
  ttlSeconds: number;
}

/**
 * 封面签名所需配置；缺任一项返回 null（封面全部用占位，不让页面起不来）。
 * 凭证：HBECHO_SQUARE_ACCESS_KEY_ID / SECRET，缺省回退 OSS_ACCESS_KEY_ID / SECRET；只需要 OSS_BUCKET_MEDIA 的读权限。
 * 不读 OSS_ENDPOINT：它可能是内网地址，签出来的 URL 浏览器打不开；这里用 SDK 默认的公网地址。
 */
export function parseSquareEnv(env: Record<string, string | undefined>): SquareEnvConfig | null {
  const accessKeyId = env.HBECHO_SQUARE_ACCESS_KEY_ID || env.OSS_ACCESS_KEY_ID;
  const accessKeySecret = env.HBECHO_SQUARE_ACCESS_KEY_SECRET || env.OSS_ACCESS_KEY_SECRET;
  const region = env.OSS_REGION;
  const bucket = env.OSS_BUCKET_MEDIA;
  if (!accessKeyId || !accessKeySecret || !region || !bucket) return null;
  const ttl = Number(env.HBECHO_SQUARE_COVER_TTL_S ?? 900);
  return { accessKeyId, accessKeySecret, region, bucket, ttlSeconds: Number.isInteger(ttl) && ttl >= 60 && ttl <= 3600 ? ttl : 900 };
}

export function assembleSquare(a: {
  db: Db;
  clock: Clock;
  env: Record<string, string | undefined>;
  logger?: Logger;
  /** 测试注入：独立注册表 / 假签名器。 */
  registry?: AccessRegistry;
  covers?: Pick<MediaObjectStore, "signedGetUrl"> | null;
}): SquareDeps {
  const cfg = parseSquareEnv(a.env);
  const registry = a.registry ?? defaultRegistry;
  // 进程级默认注册表只注册一次（热更新时不重复注册）
  if (!registry.scopeStrategy("content_square")) registry.registerScopeStrategy("content_square", createSquareStrategy(a.db) as never);
  const audit = createAuditWriter({ db: a.db, clock: a.clock, ...(a.logger ? { logger: a.logger } : {}) });
  const authorizer = createAuthorizer({ registry, onDenied: denialAuditor(audit) });
  const covers = a.covers !== undefined ? a.covers : cfg ? new OssObjectStore({ accessKeyId: cfg.accessKeyId, accessKeySecret: cfg.accessKeySecret, region: cfg.region, bucket: cfg.bucket }) : null;
  return {
    db: a.db,
    clock: a.clock,
    authorizer,
    audit,
    covers,
    coverTtlSeconds: cfg?.ttlSeconds ?? 900,
    alert: (e) => a.logger?.warn({ alert: e }, "square_alert"),
  };
}
