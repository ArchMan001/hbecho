// 本模块服务函数共用的依赖与授权入口。授权只检查 Capability 与 B 的范围策略，不读角色名。
import type { Db } from "../../db/client";
import { isEmptyScope, type AuditWriter, type AuthContext, type Authorizer } from "../access-control";
import type { Clock, MediaObjectStore } from "../raw-capture/ports";
import { SquareError } from "./errors";

export const CAP_READ = "square.read";
/** 改品牌观看策略：沿用「系统配置」能力（只授予超管），不为一个开关新开 Capability。 */
export const CAP_POLICY = "config.manage";
export const RESOURCE = "content_square";

export type SquareAlert =
  | { code: "cover_sign_failed"; failed: number }
  | { code: "covers_unconfigured" };

export interface SquareDeps {
  db: Db;
  clock: Clock;
  authorizer: Authorizer;
  audit: AuditWriter;
  /** 正式媒资桶的签名器；null = 未配置，所有封面用占位。 */
  covers: Pick<MediaObjectStore, "signedGetUrl"> | null;
  coverTtlSeconds: number;
  alert?: (e: SquareAlert) => void;
}

/** 无 Capability / 对象越权 → auth；空范围也是 auth（不回退为全部，R1.3）。 */
export async function authorizeOrThrow(deps: Pick<SquareDeps, "authorizer">, ctx: AuthContext, capability: string, resource?: { key: string; ref?: unknown }): Promise<void> {
  const d = await deps.authorizer.authorize(ctx, { capability, ...(resource ? { resource } : {}) });
  if (!d.ok) throw new SquareError("auth", d.reason, "没有权限执行这个操作");
}

export const assertNonEmptyScope = (ctx: AuthContext): void => {
  if (isEmptyScope(ctx.scope)) throw new SquareError("auth", "scope_empty", "当前账号没有可见的品牌范围");
};
