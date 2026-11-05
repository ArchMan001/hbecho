// 1.0 授权入口（design §9）。B 域未实现前，调用方只有用途受限的服务身份；品牌范围必须显式声明，不缺省为全部品牌。
// 所有命令只经 assertAllowed 进入；Module 内部不读角色名。
import { MasterDataError } from "./errors";

export const CAP_IMPORT = "data.master_data.import";
export const CAP_STRUCTURE = "data.master_data.structure";

export interface ActorContext {
  /** 例：service:master-data-import */
  readonly actor: string;
  readonly capabilities: ReadonlySet<string>;
  /** 品牌编码集合，或 "all"（只有平台级身份）。 */
  readonly brandScope: ReadonlySet<string> | "all";
}

/** 结构类操作（bootstrap、structure 模式、改码）要求 data.master_data.structure 且品牌范围为 all。 */
export function assertStructure(actor: ActorContext): void {
  if (!actor.capabilities.has(CAP_STRUCTURE) || actor.brandScope !== "all") {
    throw new MasterDataError("authorization", "forbidden", `需要平台级 Capability ${CAP_STRUCTURE}`);
  }
}

/** 普通导入要求 data.master_data.import；structure 模式的操作者（超管）同样可以走 import。 */
export function assertImport(actor: ActorContext): void {
  if (!actor.capabilities.has(CAP_IMPORT) && !actor.capabilities.has(CAP_STRUCTURE)) {
    throw new MasterDataError("authorization", "forbidden", `缺少 Capability ${CAP_IMPORT}`);
  }
}

export function assertMode(actor: ActorContext, mode: "import" | "structure"): void {
  if (mode === "structure") assertStructure(actor);
  else {
    if (!actor.capabilities.has(CAP_IMPORT)) throw new MasterDataError("authorization", "forbidden", `缺少 Capability ${CAP_IMPORT}`);
  }
}

export function brandInScope(actor: ActorContext, brandCode: string): boolean {
  return actor.brandScope === "all" || actor.brandScope.has(brandCode);
}

/** 从环境变量构造服务身份；缺少 actor、capabilities 或 brand_scope 时启动失败（不退化成全部品牌）。 */
export function actorFromEnv(env: Record<string, string | undefined>): ActorContext {
  const actor = env.HBECHO_MD_ACTOR?.trim();
  const caps = env.HBECHO_MD_CAPABILITIES?.trim();
  const scope = env.HBECHO_MD_BRAND_SCOPE?.trim();
  if (!actor) throw new MasterDataError("configuration", "actor_missing", "缺少 HBECHO_MD_ACTOR");
  if (!caps) throw new MasterDataError("configuration", "capabilities_missing", "缺少 HBECHO_MD_CAPABILITIES（逗号分隔）");
  if (!scope) throw new MasterDataError("configuration", "brand_scope_missing", "缺少 HBECHO_MD_BRAND_SCOPE（all 或品牌编码逗号分隔）；不缺省为全部品牌");
  return {
    actor,
    capabilities: new Set(caps.split(",").map((s) => s.trim()).filter(Boolean)),
    brandScope: scope === "all" ? "all" : new Set(scope.split(",").map((s) => s.trim()).filter(Boolean)),
  };
}
