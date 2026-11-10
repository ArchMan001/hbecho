// 登录失败锁定（design §7.7、AX-4、B-D14～D16）。
//   - 只保留**账号维度**：同一规范化手机号连续 5 次密码失败 → 锁定 15 分钟；没有 IP 维度
//   - 计数键是手机号，不论是否对应用户：存在 / 待激活 / 不存在的响应与计数完全一致，不暴露账号存在性
//   - 「连续」按字面实现：成功、重置密码成功、或锁定期满后的下一次失败才清零；没有滑动时间窗口（PRD 无）
//   - 只限制密码登录；短信验证码登录不经过它
//   - 不提供手动解锁与超管豁免；短信重置密码成功是唯一的提前解锁路径（B-D16）
import { eq, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import { accessLoginFailures } from "../../db/schema";
import type { Clock } from "../raw-capture/ports";

export const MAX_FAILURES = 5;
export const LOCK_MINUTES = 15;

export interface LoginGuard {
  /** 当前是否被锁定。锁定期间不得校验密码（正确密码也不放行）。 */
  check(phone: string): Promise<{ locked: boolean; lockedUntil: Date | null }>;
  /** 记一次失败；达到上限时开始锁定。 */
  fail(phone: string): Promise<{ failCount: number; lockedUntil: Date | null }>;
  /** 登录成功 / 重置密码成功：清零并解锁。 */
  clear(phone: string): Promise<void>;
}

export function createLoginGuard(deps: { db: Db; clock: Clock }): LoginGuard {
  const { db, clock } = deps;
  return {
    async check(phone) {
      const [row] = await db.select().from(accessLoginFailures).where(eq(accessLoginFailures.phoneNorm, phone)).limit(1);
      const now = clock.now();
      const lockedUntil = row?.lockedUntil ?? null;
      return { locked: lockedUntil !== null && lockedUntil > now, lockedUntil };
    },

    async fail(phone) {
      const now = clock.now();
      // 单语句 upsert：并发失败各自原子递增，不丢计数。锁定期已满的行先清零（当作新一轮的第 1 次失败）。
      await db.execute(sql`
        INSERT INTO access_login_failures (phone_norm, fail_count, locked_until, updated_at)
        VALUES (${phone}, 1, NULL, ${now})
        ON DUPLICATE KEY UPDATE
          fail_count   = IF(locked_until IS NOT NULL AND locked_until <= ${now}, 1, fail_count + 1),
          locked_until = IF(locked_until IS NOT NULL AND locked_until <= ${now}, NULL, locked_until),
          updated_at   = ${now}`);
      const until = new Date(now.getTime() + LOCK_MINUTES * 60_000);
      await db.execute(sql`
        UPDATE access_login_failures SET locked_until = ${until}
        WHERE phone_norm = ${phone} AND fail_count >= ${MAX_FAILURES} AND locked_until IS NULL`);
      const [row] = await db.select().from(accessLoginFailures).where(eq(accessLoginFailures.phoneNorm, phone)).limit(1);
      return { failCount: row?.failCount ?? 0, lockedUntil: row?.lockedUntil ?? null };
    },

    async clear(phone) {
      await db.delete(accessLoginFailures).where(eq(accessLoginFailures.phoneNorm, phone));
    },
  };
}
