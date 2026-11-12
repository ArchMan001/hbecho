// 页面进程里的主数据导入装配：进程内只建一次，复用访问控制运行时的数据库连接（与 _lib/plan.ts 同一做法）。
// 授权：页面把 AuthContext 适配成 ActorContext（toMasterDataActor）后交给 Module，Module 自己再做 Capability 与品牌范围检查。
import { cache } from "react";
import pino from "pino";
import { createAuditWriter, fromMasterDataAudit, toMasterDataActor, type AuthContext } from "../../modules/access-control";
import { getAccessRuntime } from "../../modules/access-control/runtime";
import { createLogAudit, createMasterData, MasterDataError, type ActorContext, type MasterData } from "../../modules/master-data-import";

const KEY = Symbol.for("hbecho.master-data.web");
export function masterData(): MasterData {
  const g = globalThis as unknown as Record<symbol, MasterData | undefined>;
  if (g[KEY]) return g[KEY];
  const { db } = getAccessRuntime();
  const clock = { now: () => new Date() };
  const logger = pino({ name: "master-data-web" }, pino.destination(2));
  const audit = fromMasterDataAudit(createAuditWriter({ db, clock, logger }), createLogAudit(logger));
  return (g[KEY] = createMasterData(db, clock, audit));
}

/** AuthContext → 主数据导入的 ActorContext。没有导入 Capability 或品牌映射不到编码时拒绝（不降级）。同一请求内只算一次。 */
export const mdActorOf = cache(async (ctx: AuthContext): Promise<ActorContext> => {
  const r = await toMasterDataActor(ctx, { db: getAccessRuntime().db });
  if (!r.ok) {
    throw r.reason === "no_import_capability"
      ? new MasterDataError("authorization", "forbidden", "当前角色没有主数据导入权限")
      : new MasterDataError("configuration", "scope_unmappable", "你的品牌范围无法解释，请联系管理员");
  }
  return r.actor;
});
