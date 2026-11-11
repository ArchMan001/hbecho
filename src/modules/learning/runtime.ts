// 装配：把 learning 模块接到访问控制的运行时（授权器、出口、审计）与云服务（OSS 课程桶、VOD）。
// 页面进程（src/app/_lib/learning.ts）和定时任务进程（worker/learning-main.ts）共用这一份，所以测试证明的就是生产接线。
// 凭证只从环境变量读，缺项只报键名。
import type { Logger } from "pino";
import type { Db } from "../../db/client";
import { createAuditWriter, createAuthorizer, createEgress, defaultRegistry, denialAuditor } from "../access-control";
import type { Clock } from "../raw-capture/ports";
import { DEFAULT_LEARNING_CONFIG } from "./config";
import { ecsRoleCredentials, staticCredentials, type CredentialSource } from "./credentials";
import type { LearningDeps } from "./deps";
import { OssCourseStore } from "./oss-course-store";
import type { VodClient } from "./vod";
import { createAliyunVodClient } from "./vod-aliyun";
import { learningCourseStrategy } from "./visibility";

export class LearningConfigError extends Error {
  constructor(readonly keys: string[]) {
    super(`学习模块缺少配置：${keys.join("、")}`);
    this.name = "LearningConfigError";
  }
}

export interface LearningEnvConfig {
  credentials: CredentialSource;
  /** 凭证来源的说明，只用于日志，不含密钥：`ecs_role` / `env_access_key`。 */
  credentialsKind: "ecs_role" | "env_access_key";
  region: string;
  bucket: string;
  endpoint?: string;
}

/**
 * 凭证：
 *   HBECHO_LEARNING_CREDENTIALS=ecs_role → ECS 实例 RAM 角色（生产首选，runbook §7.7，免长期 AccessKey）；
 *   否则固定 AccessKey：HBECHO_LEARNING_ACCESS_KEY_ID / SECRET，缺省回退 OSS_ACCESS_KEY_ID / SECRET。
 *   注意回退：本机 .env 里的 OSS_* 可能是 setup 身份，权限远大于运行期需要——生产不要依赖这个回退。
 * 不论哪种，身份需要：hbecho-course 桶读写删列（hbecho-oss-rw 已含）+ VOD 运行期动作（hbecho-vod-runtime，见 ADR-0007 补记）。
 */
export function parseLearningEnv(env: Record<string, string | undefined>, opts: { fetchImpl?: typeof fetch } = {}): LearningEnvConfig {
  const region = env.HBECHO_COURSE_OSS_REGION || env.OSS_REGION;
  const base = {
    region: region ?? "",
    bucket: env.HBECHO_COURSE_OSS_BUCKET || "hbecho-course",
    ...(env.HBECHO_COURSE_OSS_ENDPOINT ? { endpoint: env.HBECHO_COURSE_OSS_ENDPOINT } : {}),
  };
  if (env.HBECHO_LEARNING_CREDENTIALS === "ecs_role") {
    if (!region) throw new LearningConfigError(["HBECHO_COURSE_OSS_REGION"]);
    return { ...base, credentials: ecsRoleCredentials(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}), credentialsKind: "ecs_role" };
  }
  if (env.HBECHO_LEARNING_CREDENTIALS && env.HBECHO_LEARNING_CREDENTIALS !== "access_key") throw new LearningConfigError(["HBECHO_LEARNING_CREDENTIALS（只能是 ecs_role 或 access_key）"]);
  const accessKeyId = env.HBECHO_LEARNING_ACCESS_KEY_ID || env.OSS_ACCESS_KEY_ID;
  const accessKeySecret = env.HBECHO_LEARNING_ACCESS_KEY_SECRET || env.OSS_ACCESS_KEY_SECRET;
  const missing = [!accessKeyId && "HBECHO_LEARNING_ACCESS_KEY_ID", !accessKeySecret && "HBECHO_LEARNING_ACCESS_KEY_SECRET", !region && "HBECHO_COURSE_OSS_REGION"].filter((x): x is string => !!x);
  if (missing.length) throw new LearningConfigError(missing);
  return { ...base, credentials: staticCredentials({ accessKeyId: accessKeyId!, accessKeySecret: accessKeySecret! }), credentialsKind: "env_access_key" };
}

/** 首次调用时才加载 SDK；凭证变了（STS 轮换）就重建客户端。 */
function lazyVod(source: CredentialSource): VodClient {
  let cur: { key: string; client: Promise<VodClient> } | undefined;
  const c = async (): Promise<VodClient> => {
    const cred = await source();
    const key = `${cred.accessKeyId}:${cred.securityToken ?? ""}`;
    if (cur?.key !== key) cur = { key, client: createAliyunVodClient(cred) };
    return cur.client;
  };
  return {
    createUpload: async (i) => (await c()).createUpload(i),
    getVideo: async (id) => (await c()).getVideo(id),
    getPlayAuth: async (id) => (await c()).getPlayAuth(id),
    deleteVideo: async (id) => (await c()).deleteVideo(id),
    updateTitle: async (id, t) => (await c()).updateTitle(id, t),
    listVideosBefore: async (d) => (await c()).listVideosBefore(d),
  };
}

export function assembleLearning(a: { db: Db; clock: Clock; env: Record<string, string | undefined>; logger?: Logger; vod?: VodClient }): LearningDeps {
  const cfg = parseLearningEnv(a.env);
  // 进程级默认注册表只注册一次（热更新 / 页面与 worker 同进程时不重复注册）
  if (!defaultRegistry.scopeStrategy("learning_course")) defaultRegistry.registerScopeStrategy("learning_course", learningCourseStrategy as never);
  const audit = createAuditWriter({ db: a.db, clock: a.clock, ...(a.logger ? { logger: a.logger } : {}) });
  const authorizer = createAuthorizer({ onDenied: denialAuditor(audit) });
  return {
    db: a.db,
    clock: a.clock,
    authorizer,
    egress: createEgress({ authorizer, audit }),
    audit,
    store: new OssCourseStore({ credentials: cfg.credentials, region: cfg.region, bucket: cfg.bucket, ...(cfg.endpoint ? { endpoint: cfg.endpoint } : {}) }),
    vod: a.vod ?? lazyVod(cfg.credentials),
    config: DEFAULT_LEARNING_CONFIG,
    alert: (e) => a.logger?.warn({ alert: e }, "learning_alert"),
  };
}
