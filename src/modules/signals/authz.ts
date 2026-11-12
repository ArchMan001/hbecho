// 授权入口（design §9、SG-14）。业务模块只调 assert，不读角色名，不自行放行。
// 顺序：Capability → actor 自带的品牌范围，二者都先于任何数据库读取。结构沿用 activity-plan/authz.ts。
// B 落地后 SignalActor 由会话经适配器构造，assert 退化为对 B authorize 的薄封装，调用方不变。
import { SignalError } from "./errors";

export const CAP_SEGMENT_MANAGE = "rule.definition.manage"; // 监控段写入、上传标准图、重算
export const CAP_SEGMENT_READ = "rule.definition.read"; // 读取口与证据读取（D 以服务身份调用）
export const CAP_SCORE_REQUEST = "rule.run.execute"; // requestScores
export const CAP_CONTENT_READ = "data.content.read"; // CLI show --content / --comment
export const CAP_ACCOUNT_READ = "data.account.read"; // CLI show --account

/** 扫描器、清理器、worker 使用的固定服务身份，不经用户范围。 */
export const SERVICE_ACTOR = "service:signals-worker";

export interface SignalActor {
  /** 审计主体，如 service:signals-worker / user:12 */
  readonly actor: string;
  readonly capabilities: ReadonlySet<string>;
  /** 品牌编码集合，或 "all"；仅用于重算范围展开。 */
  readonly brandScope: ReadonlySet<string> | "all";
}

export interface SignalResource {
  brandCode?: string;
  /** 越范围时的表现：reject（默认）；hide（已有对象，表现为未找到，不泄露存在性）。 */
  outOfScope?: "reject" | "hide";
}

export const brandInScope = (a: Pick<SignalActor, "brandScope">, brandCode: string): boolean => a.brandScope === "all" || a.brandScope.has(brandCode);

export function assert(actor: SignalActor, capability: string, resource: SignalResource = {}): void {
  if (!actor.capabilities.has(capability)) throw new SignalError("authorization", "forbidden", `缺少 Capability ${capability}`);
  if (resource.brandCode !== undefined && !brandInScope(actor, resource.brandCode)) {
    if (resource.outOfScope === "hide") throw new SignalError("not_found", "not_found", "未找到");
    throw new SignalError("authorization", "brand_out_of_scope", "品牌不在你的授权范围内");
  }
}

const list = (v: string): string[] => v.split(",").map((s) => s.trim()).filter(Boolean);

/** CLI 身份来自环境变量；缺任一项启动失败，不退化成「全部范围」。 */
export function actorFromEnv(env: Record<string, string | undefined>): SignalActor {
  const actor = env.HBECHO_SIG_ACTOR?.trim();
  const caps = env.HBECHO_SIG_CAPABILITIES?.trim();
  const brands = env.HBECHO_SIG_BRAND_SCOPE?.trim();
  if (!actor) throw new SignalError("configuration", "actor_missing", "缺少 HBECHO_SIG_ACTOR");
  if (!caps) throw new SignalError("configuration", "capabilities_missing", "缺少 HBECHO_SIG_CAPABILITIES（逗号分隔）");
  if (!brands) throw new SignalError("configuration", "brand_scope_missing", "缺少 HBECHO_SIG_BRAND_SCOPE（all 或品牌编码逗号分隔）；不缺省为全部品牌");
  return { actor, capabilities: new Set(list(caps)), brandScope: brands === "all" ? "all" : new Set(list(brands)) };
}
