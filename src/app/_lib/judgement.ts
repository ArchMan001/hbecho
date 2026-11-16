// 页面进程里的判定计划装配：进程内只建一次，复用访问控制运行时的数据库连接（与 _lib/plan.ts 同一做法）。
// 页面进程不装配需求（demand）：圈定 / 试跑 / 执行的后台推进由 `pnpm judgement serve` 完成；页面只提交与查看。
// 数值配置（HBECHO_JP_* 与 C 的 HBECHO_SIGNALS_*）缺项时装配抛 JudgementError(config_missing)，页面显示「尚未完成部署配置」，不当作无数据。
import pino from "pino";
import { getAccessRuntime } from "../../modules/access-control/runtime";
import type { Judgement } from "../../modules/judgement/assemble";
import { buildJudgementRuntime } from "../../worker/judgement-wiring";
const KEY = Symbol.for("hbecho.judgement.web");
function build(): Judgement {
  const logger = pino({ name: "judgement-web" }, pino.destination(2));
  return buildJudgementRuntime({ db: getAccessRuntime().db, env: process.env, logger, strict: false }).judgement;
}
export function judgement(): Judgement {
  const g = globalThis as unknown as Record<symbol, Judgement | undefined>;
  return (g[KEY] ??= build());
}
/** 页面与动作里「判定计划 ID」的解析：只接受十进制，其余当作不存在。 */
export const parsePlanId = (id: string): bigint | null => (/^[1-9]\d{0,18}$/.test(id) ? BigInt(id) : null);
