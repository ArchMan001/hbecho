// 装配：授权器、出口、审计与正式媒资桶签名器（图片线上显示用；复用视频广场的环境变量，不新增配置）。
// 页面进程、CLI 与测试共用这一份，所以测试证明的就是生产接线。
import type { Logger } from "pino";
import type { Db } from "../../db/client";
import { createAuditWriter, createAuthorizer, createEgress, defaultRegistry, denialAuditor, type AccessRegistry } from "../access-control";
import { OssCourseStore } from "../learning";
import type { MediaObjectStore } from "../raw-capture";
import { parseSquareEnv } from "../video-square/assemble";
import { registerReportAuthz } from "./authz";
import { createReportDetail, type OutcomesPort, type ReportDetail } from "./read";

export function assembleReport(a: {
  db: Db;
  env: Record<string, string | undefined>;
  outcomes: OutcomesPort;
  logger?: Logger;
  clock?: { now(): Date };
  /** 测试注入：独立注册表 / 假签名器 / 行数上限。 */
  registry?: AccessRegistry;
  media?: Pick<MediaObjectStore, "signedGetUrl"> | null;
  limits?: { videoRows: number; accountRows: number };
}): ReportDetail {
  const registry = a.registry ?? defaultRegistry;
  registerReportAuthz(registry); // 先查再注册：e-metrics 之后复用同一份
  const audit = createAuditWriter({ db: a.db, clock: a.clock ?? { now: () => new Date() }, ...(a.logger ? { logger: a.logger } : {}) });
  const authorizer = createAuthorizer({ registry, onDenied: denialAuditor(audit) });
  const egress = createEgress({ authorizer, audit });
  const cfg = parseSquareEnv(a.env);
  const media = a.media !== undefined ? a.media : cfg ? new OssCourseStore({ credentials: cfg.credentials, region: cfg.region, bucket: cfg.bucket }) : null;
  return createReportDetail({
    db: a.db, authorizer, egress, outcomes: a.outcomes, media, mediaTtlSeconds: cfg?.ttlSeconds ?? 300, ...(a.limits ? { limits: a.limits } : {}),
    alert: (e) => a.logger?.warn({ alert: e }, "report_detail_alert"),
  });
}
