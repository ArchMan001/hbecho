// `pnpm learning-worker`：学习域的定时任务进程（design §6、tasks 任务 11）。
//   每分钟：转码结果回填 + 待删除媒体重试；每小时：下架满 30 天归档 + 无引用残渣清理。
// 每一步独立，失败只记日志，不退出进程。凭证与数据库只从环境变量读（.env 由 Node 自带 loadEnvFile 载入）。
import { loadEnvFile } from "node:process";
import pino from "pino";
import { createDb, createPool } from "../db/client";
import { assembleLearning, LearningConfigError, runMaintenance } from "../modules/learning";

try {
  loadEnvFile(".env");
} catch (e) {
  if ((e as { code?: unknown }).code !== "ENOENT") throw e;
}
const logger = pino({ name: "learning-worker" }, pino.destination(2));
const url = process.env.HBECHO_DATABASE_URL;
if (!url) {
  logger.error("缺少 HBECHO_DATABASE_URL");
  process.exit(2);
}
const pool = createPool(url);
let deps;
try {
  deps = assembleLearning({ db: createDb(pool), clock: { now: () => new Date() }, env: process.env, logger });
} catch (e) {
  logger.error({ keys: e instanceof LearningConfigError ? e.keys : undefined }, e instanceof LearningConfigError ? "配置缺失" : "装配失败");
  process.exit(2);
}

const EVERY_MS = 60_000;
const SLOW_EVERY = 60; // 每 60 轮（约一小时）做一次归档与残渣清理
let tick = 0;
let running = false;
const once = async () => {
  if (running) return; // 上一轮还没结束就跳过，避免重叠
  running = true;
  try {
    const report = await runMaintenance(deps, { slow: tick % SLOW_EVERY === 0 });
    // 有步骤失败按错误级别记（运维靠它发现 VOD / OSS 不可用），否则一行 info
    if (report.errors.length > 0) logger.error(report, "learning_maintenance_errors");
    else logger.info(report, "learning_maintenance");
  } catch (e) {
    logger.error({ err: e instanceof Error ? e.name : typeof e }, "learning.maintenance_failed");
  } finally {
    tick += 1;
    running = false;
  }
};
void once();
const timer = setInterval(() => void once(), EVERY_MS);
const stop = async () => {
  clearInterval(timer);
  await pool.end();
  process.exit(0);
};
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
