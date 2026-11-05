// 账号采集 Runner（fetch_profile / fetch_content_list）的注入依赖。
import { eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { platforms } from "../../db/schema";
import type { Platform } from "../provider-adapter";
import type { PlatformStrategy } from "../orchestrator";
import type { ContentListProjector } from "../projection";
import type { CallEnv } from "./call";

/** 测试用崩溃 / 抢占点：钩子抛出的异常不会被吞掉。 */
export interface AccountRunnerHooks {
  /** 列表页已落 ODS 并解码，页事务之前。 */
  beforePageProjection?(): Promise<void> | void;
  /** 页事务已提交之后（进程可能在此处丢失）。 */
  afterPageProjection?(): Promise<void> | void;
  /** 封口事务之前（判定已落进度）。 */
  beforeSeal?(): Promise<void> | void;
}

export interface AccountRunnerDeps extends CallEnv {
  strategies?: Readonly<Record<string, PlatformStrategy>>;
  hooks?: AccountRunnerHooks;
  /** 默认是真实的整页投影；测试用来注入「第 N 条失败」。 */
  projector?: ContentListProjector;
}

export async function platformCodeOf(db: Db, platformId: bigint): Promise<Platform | null> {
  const [p] = await db.select({ code: platforms.platformCode }).from(platforms).where(eq(platforms.platformId, platformId));
  return (p?.code as Platform | undefined) ?? null;
}
