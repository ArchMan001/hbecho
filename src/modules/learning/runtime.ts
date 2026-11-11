// 装配：把 learning 模块接到访问控制的运行时（授权器、出口、审计）与云服务（OSS 课程桶、VOD）。
// 页面进程（src/app/_lib/learning.ts）和定时任务进程（worker/learning-main.ts）共用这一份，所以测试证明的就是生产接线。
// 凭证只从环境变量读，缺项只报键名。
import type { Logger } from "pino";
import type { Db } from "../../db/client";
import { createAuditWriter, createAuthorizer, createEgress, defaultRegistry, denialAuditor } from "../access-control";
import type { Clock } from "../raw-capture/ports";
import { DEFAULT_LEARNING_CONFIG } from "./config";
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
  accessKeyId: string;
  accessKeySecret: string;
  region: string;
  bucket: string;
  endpoint?: string;
}

/**
 * 凭证：HBECHO_LEARNING_ACCESS_KEY_ID / SECRET；未设置时回退到 OSS_ACCESS_KEY_ID / SECRET（2026-11-11 实测它能读写 hbecho-course）。
 * VOD 还需要该 RAM 身份有 ADR-0007 §6 列出的运行期动作，否则视频相关调用会返回 vod_unavailable。
 */
export function parseLearningEnv(env: Record<string, string | undefined>): LearningEnvConfig {
  const accessKeyId = env.HBECHO_LEARNING_ACCESS_KEY_ID || env.OSS_ACCESS_KEY_ID;
  const accessKeySecret = env.HBECHO_LEARNING_ACCESS_KEY_SECRET || env.OSS_ACCESS_KEY_SECRET;
  const region = env.HBECHO_COURSE_OSS_REGION || env.OSS_REGION;
  const missing = [!accessKeyId && "HBECHO_LEARNING_ACCESS_KEY_ID", !accessKeySecret && "HBECHO_LEARNING_ACCESS_KEY_SECRET", !region && "HBECHO_COURSE_OSS_REGION"].filter((x): x is string => !!x);
  if (missing.length) throw new LearningConfigError(missing);
  return {
    accessKeyId: accessKeyId!,
    accessKeySecret: accessKeySecret!,
    region: region!,
    bucket: env.HBECHO_COURSE_OSS_BUCKET || "hbecho-course",
    ...(env.HBECHO_COURSE_OSS_ENDPOINT ? { endpoint: env.HBECHO_COURSE_OSS_ENDPOINT } : {}),
  };
}

/** 首次调用时才加载 SDK 的 VodClient。 */
function lazyVod(cred: { accessKeyId: string; accessKeySecret: string }): VodClient {
  let client: Promise<VodClient> | undefined;
  const c = () => (client ??= createAliyunVodClient(cred));
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
    store: new OssCourseStore(cfg),
    vod: a.vod ?? lazyVod(cfg),
    config: DEFAULT_LEARNING_CONFIG,
    alert: (e) => a.logger?.warn({ alert: e }, "learning_alert"),
  };
}
