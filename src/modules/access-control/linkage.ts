// MediaStaff 联动与每日维护（design §5.3、§7.10；AX-5）。独立实现，**不依赖 OSS**：没有 OSS 配置的装配里也照常调度。
//   懒执行        authenticate 发现绑定专员停用 → disableIfStaffInactive（请求路径上的第一道）
//   步骤 1 补偿   对所有非停用的 store_staff，专员已停用 → 同样停用（覆盖从未登录的用户）
//   步骤 2 恢复   因专员停用而自动停用的，专员恢复有效后条件恢复；同号 / 专员被占用 → 保持停用 + 质量问题；人工停用的不碰
//   步骤 3 审计到期清理   任务 9 接入（deps.purgeAudit）
//   步骤 4 清理   access_sms_sends / access_login_failures / access_bootstrap_tokens 的增长型行
// 四步各自 try/catch、幂等；一步失败不影响其它步骤。
import { and, eq, inArray, isNotNull, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import { accessBootstrapTokens, accessLoginFailures, accessSmsSends, accessUsers, mediaStaff } from "../../db/schema";
import type { Clock } from "../raw-capture/ports";
import { AccessError } from "./errors";
import type { AuditWriter } from "./audit";
import { ISSUE_AUTO_RESTORE_BLOCKED, ISSUE_AUTO_RESTORE_STAFF_BOUND, recordAccessIssue } from "./quality";
import type { OrgDirectory } from "./scope";
import { disableCore, loadStaffPlacements, loadUserRecord, restoreCore } from "./users/shared";

export const ACCESS_WORKER_ACTOR = "service:access-worker";
const DAY = 86_400_000;
const BJT_OFFSET_MS = 8 * 3_600_000;
/** 清理的保留期（design §7.10）。 */
export const RETENTION = { smsSendsDays: 35, loginFailureZeroDays: 7, loginFailureStaleDays: 90, bootstrapTokenDays: 30 } as const;

export interface LinkageDeps {
  db: Db;
  clock: Clock;
  audit: AuditWriter;
  dir: OrgDirectory;
  /** 步骤 3（任务 9）：审计到期清理。 */
  purgeAudit?: () => Promise<unknown>;
  /** 自动停用提交**之后**调用（取消该用户触发的未完成异步任务，与人工停用同一出口）；失败不回滚、不抛。 */
  onRevoked?(userActor: string): Promise<void>;
  config?: { afterMinuteBjt?: number; maxPerRun?: number; retryAfterMs?: number };
  log?: (event: Record<string, unknown>, msg: string) => void;
}

export interface MaintainReport {
  compensated: number;
  acksCleared: number;
  restored: number;
  restoreBlocked: number;
  cleaned: { smsSends: number; loginFailures: number; bootstrapTokens: number } | null;
  /** 失败的步骤名（只有名字，不带异常内容）。 */
  failedSteps: string[];
}
export type RunDailyResult = { ran: false; reason: "not_due" | "already_done" | "backoff" } | { ran: true; ok: boolean; report: MaintainReport };

const bjtDay = (d: Date): string => new Date(d.getTime() + BJT_OFFSET_MS).toISOString().slice(0, 10);
const bjtMinuteOfDay = (d: Date): number => {
  const x = new Date(d.getTime() + BJT_OFFSET_MS);
  return x.getUTCHours() * 60 + x.getUTCMinutes();
};

export function createStaffLinkage(deps: LinkageDeps) {
  const { db, clock } = deps;
  const afterMinute = deps.config?.afterMinuteBjt ?? 270; // 北京时间 04:30
  const maxPerRun = deps.config?.maxPerRun ?? 2000;
  const retryAfterMs = deps.config?.retryAfterMs ?? 600_000;
  const log = deps.log ?? (() => {});
  const userDeps = { db, clock, audit: deps.audit, dir: deps.dir };

  /**
   * 绑定的专员不是 active → 停用该用户（撤销会话、墓碑、审计 media_staff_disabled）。幂等。
   * 跳过：用户已停用 / 没有绑定 / 专员其实有效 / 管理员人工恢复时已知情（binding_ack_staff_id 等于当前绑定）。
   */
  async function disableIfStaffInactive(userId: bigint): Promise<"disabled" | "skipped"> {
    const r = await disableIfStaffInactiveTx(userId);
    if (r === "disabled") {
      try {
        await deps.onRevoked?.(`user:${userId}`);
      } catch {
        // 取消任务失败不改变停用结果（各域任务自带过期与交付前复查兜底）
      }
    }
    return r;
  }
  async function disableIfStaffInactiveTx(userId: bigint): Promise<"disabled" | "skipped"> {
    return db.transaction(async (tx) => {
      const u = await loadUserRecord(tx, userId, { forUpdate: true });
      if (!u || u.status === "disabled" || u.mediaStaffId === null) return "skipped";
      if (u.bindingAckStaffId === u.mediaStaffId) return "skipped";
      const p = (await loadStaffPlacements(tx, [u.mediaStaffId])).get(u.mediaStaffId);
      if (!p || p.status === "active") return "skipped";
      const changed = await disableCore(tx, userDeps, {
        userId,
        byActor: ACCESS_WORKER_ACTOR,
        byUserId: null,
        reason: "media_staff_disabled",
        autoStaffId: u.mediaStaffId,
      });
      return changed ? "disabled" : "skipped";
    });
  }

  /** 步骤 1：补偿。一次最多处理 maxPerRun 个，剩余留给下一次。 */
  async function compensate(): Promise<number> {
    const rows = await db
      .select({ userId: accessUsers.userId })
      .from(accessUsers)
      .innerJoin(mediaStaff, eq(mediaStaff.staffId, accessUsers.mediaStaffId))
      .where(
        and(
          eq(accessUsers.roleCode, "store_staff"),
          ne(accessUsers.status, "disabled"),
          ne(mediaStaff.status, "active"),
          or(isNull(accessUsers.bindingAckStaffId), ne(accessUsers.bindingAckStaffId, accessUsers.mediaStaffId)),
        ),
      )
      .orderBy(accessUsers.userId)
      .limit(maxPerRun);
    let n = 0;
    for (const r of rows) if ((await disableIfStaffInactive(r.userId)) === "disabled") n++;
    return n;
  }

  /** 步骤 2 的前半：专员重新有效后，清掉「管理员已知情」标记（AX-D30），否则之后再次停用时会被误豁免。 */
  async function clearStaleAcks(): Promise<number> {
    const activeStaff = db.select({ id: mediaStaff.staffId }).from(mediaStaff).where(eq(mediaStaff.status, "active"));
    const [r] = await db
      .update(accessUsers)
      .set({ bindingAckStaffId: null, updatedAt: clock.now() })
      .where(and(isNotNull(accessUsers.bindingAckStaffId), inArray(accessUsers.bindingAckStaffId, activeStaff)));
    return r.affectedRows;
  }

  /** 步骤 2：条件恢复。只恢复 disabled_reason='media_staff_disabled' 且对应专员已有效的用户。 */
  async function conditionalRestore(): Promise<{ restored: number; blocked: number }> {
    const rows = await db
      .select({ userId: accessUsers.userId, staffId: mediaStaff.staffId })
      .from(accessUsers)
      .innerJoin(mediaStaff, eq(mediaStaff.staffId, accessUsers.autoDisabledStaffId))
      .where(and(eq(accessUsers.status, "disabled"), eq(accessUsers.disabledReason, "media_staff_disabled"), eq(mediaStaff.status, "active")))
      .orderBy(accessUsers.userId)
      .limit(maxPerRun);
    let restored = 0;
    let blocked = 0;
    for (const r of rows) {
      try {
        await db.transaction((tx) => restoreCore(tx, userDeps, { userId: r.userId, byActor: ACCESS_WORKER_ACTOR, byUserId: null }));
        restored++;
      } catch (e) {
        const code = e instanceof AccessError ? e.code : null;
        if (code !== "phone_in_use" && code !== "staff_already_bound") throw e;
        blocked++; // 事务已回滚，用户保持停用；每次运行都会再试，问题只累加次数
        await recordAccessIssue(db, {
          code: code === "phone_in_use" ? ISSUE_AUTO_RESTORE_BLOCKED : ISSUE_AUTO_RESTORE_STAFF_BOUND,
          severity: "warning",
          entityType: "access_user",
          entityId: r.userId,
          discriminator: `staff:${r.staffId}`,
          detail: { mediaStaffId: r.staffId.toString(), reason: code },
          now: clock.now(),
        });
      }
    }
    return { restored, blocked };
  }

  /** 步骤 4：增长型表清理（随机手机号请求写入的行因此有上界）。锁定中的行不清理。 */
  async function cleanup(): Promise<{ smsSends: number; loginFailures: number; bootstrapTokens: number }> {
    const now = clock.now();
    const ago = (days: number) => new Date(now.getTime() - days * DAY);
    const [sms] = await db.delete(accessSmsSends).where(lt(accessSmsSends.requestedAt, ago(RETENTION.smsSendsDays)));
    const [lf] = await db.delete(accessLoginFailures).where(
      or(
        and(eq(accessLoginFailures.failCount, 0), lt(accessLoginFailures.updatedAt, ago(RETENTION.loginFailureZeroDays))),
        // 90 天没有更新、且当前没有生效的锁定：包括 fail_count = 5 且锁定早已过期的行（否则匿名请求可以让这张表无限增长）
        and(or(isNull(accessLoginFailures.lockedUntil), lte(accessLoginFailures.lockedUntil, now)), lt(accessLoginFailures.updatedAt, ago(RETENTION.loginFailureStaleDays))),
      ),
    );
    const cut = ago(RETENTION.bootstrapTokenDays);
    const [tk] = await db.delete(accessBootstrapTokens).where(or(lt(accessBootstrapTokens.consumedAt, cut), and(isNull(accessBootstrapTokens.consumedAt), lt(accessBootstrapTokens.expiresAt, cut))));
    return { smsSends: sms.affectedRows, loginFailures: lf.affectedRows, bootstrapTokens: tk.affectedRows };
  }

  let lastDoneDay: string | null = null;
  let retryAt = 0;

  /** 立刻运行一轮（`access maintain` 用）。每一步独立 try/catch。 */
  async function runNow(): Promise<{ ok: boolean; report: MaintainReport }> {
    const report: MaintainReport = { compensated: 0, acksCleared: 0, restored: 0, restoreBlocked: 0, cleaned: null, failedSteps: [] };
    const step = async <T>(name: string, f: () => Promise<T>): Promise<T | null> => {
      try {
        return await f();
      } catch (e) {
        report.failedSteps.push(name);
        log({ step: name, err: e instanceof Error ? e.name : typeof e }, "access maintenance step failed");
        return null;
      }
    };
    report.acksCleared = (await step("clear_stale_acks", clearStaleAcks)) ?? 0;
    report.compensated = (await step("compensate", compensate)) ?? 0;
    const r = await step("conditional_restore", conditionalRestore);
    if (r) {
      report.restored = r.restored;
      report.restoreBlocked = r.blocked;
    }
    if (deps.purgeAudit) await step("purge_audit", deps.purgeAudit);
    report.cleaned = await step("cleanup_growth_tables", cleanup);
    const ok = report.failedSteps.length === 0;
    log({ ok, ...report }, "access maintenance finished");
    return { ok, report };
  }

  /** 北京时间 04:30 之后每个自然日成功运行一次；失败退避后重试。每次 tick 都可调用。 */
  async function runDaily(now: Date = clock.now()): Promise<RunDailyResult> {
    if (bjtMinuteOfDay(now) < afterMinute) return { ran: false, reason: "not_due" };
    if (lastDoneDay === bjtDay(now)) return { ran: false, reason: "already_done" };
    if (now.getTime() < retryAt) return { ran: false, reason: "backoff" };
    const { ok, report } = await runNow();
    if (ok) lastDoneDay = bjtDay(now);
    else retryAt = now.getTime() + retryAfterMs;
    return { ran: true, ok, report };
  }

  return { disableIfStaffInactive, compensate, conditionalRestore, cleanup, runNow, runDaily };
}

export type StaffLinkage = ReturnType<typeof createStaffLinkage>;
