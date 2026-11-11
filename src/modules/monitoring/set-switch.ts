// 五级监控开关的写入（FS-14.4、FS-14.6；design §9）。分公司 / 经销商 / 门店 / 专员 / 账号各自一个开关，
// 上级关闭不改写下级的值（有效目标集由 resolver 逐级求交，见 FS-2）。
// 影响面不止一个对象的层级（除账号外）默认只预览，--apply 才写；账号级关闭写 monitoring_closed_reason='manual'。
// 不从 monitoring/index.ts 再导出：它依赖 sync-schedule（错误 / 审计 / 授权），而 sync-schedule 依赖 monitoring。
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../../db/client";
import { branches, dealers, externalAccounts, mediaStaff, platforms, sectors, staffAccountAssignments as aa, stores } from "../../db/schema";
import type { Clock } from "../raw-capture";
import { CAP_MONITORING_MANAGE, type ActorContext } from "../tracer-command";
import type { SyncAuditEvent, SyncAuditSink } from "../sync-schedule/audit";
import { inPlatformScope, inStaffScope, requireCap, requireFullScope, requirePlatformAdmin } from "../sync-schedule/authz";
import { SyncError } from "../sync-schedule/errors";
import { markGrace } from "../plan-references";

export const SWITCH_LEVELS = ["branch", "dealer", "store", "staff", "account"] as const;
export type SwitchLevel = (typeof SWITCH_LEVELS)[number];
const input = z.strictObject({
  level: z.enum(SWITCH_LEVELS),
  id: z.string().regex(/^[1-9]\d*$/, "必须是不带前导零的正十进制整数 string"),
  enabled: z.boolean(),
  apply: z.boolean().default(false),
});
export type SetSwitchResult =
  | { kind: "preview"; level: SwitchLevel; id: string; enabled: boolean; currentEnabled: boolean; affectedAccounts: number; examples: string[]; hint: string }
  | { kind: "applied"; level: SwitchLevel; id: string; enabled: boolean; previousEnabled: boolean; affectedAccounts: number }
  | { kind: "noop"; level: SwitchLevel; id: string; enabled: boolean };

const EXAMPLES = 20;

export function createMonitoringSwitch(deps: { db: Db; clock: Clock; audit: SyncAuditSink }) {
  const { db, clock, audit } = deps;
  const emit = (e: Omit<SyncAuditEvent, "at" | "event" | "action">) => audit.record({ at: clock.now().toISOString(), event: "sync.command", action: "monitoring_set", ...e });

  /** 节点本身（当前开关值）。 */
  async function node(level: Exclude<SwitchLevel, "account">, id: bigint): Promise<boolean | null> {
    const t = level === "branch" ? branches : level === "dealer" ? dealers : level === "store" ? stores : mediaStaff;
    const idCol = level === "branch" ? branches.branchId : level === "dealer" ? dealers.dealerId : level === "store" ? stores.storeId : mediaStaff.staffId;
    const [r] = await db.select({ on: t.monitoringEnabled }).from(t).where(eq(idCol, id));
    return r ? r.on : null;
  }
  /** 节点之下的账号（自有型、未释放名额）；external 没有组织链，不在任何节点之下。 */
  async function accountsUnder(level: Exclude<SwitchLevel, "account">, id: bigint): Promise<bigint[]> {
    const cond = level === "branch" ? eq(sectors.branchId, id) : level === "dealer" ? eq(stores.dealerId, id) : level === "store" ? eq(stores.storeId, id) : eq(mediaStaff.staffId, id);
    const rows = await db
      .select({ accountId: aa.accountId })
      .from(aa)
      .innerJoin(mediaStaff, eq(mediaStaff.staffId, aa.staffId))
      .innerJoin(stores, eq(stores.storeId, mediaStaff.storeId))
      .innerJoin(sectors, eq(sectors.sectorId, stores.sectorId))
      .where(and(eq(aa.watchType, "staff"), sql`${aa.slotReleasedAt} IS NULL`, cond))
      .orderBy(aa.accountId);
    return rows.map((r) => r.accountId);
  }

  async function set(raw: unknown, actor: ActorContext): Promise<SetSwitchResult> {
    try {
      const parsed = input.safeParse(raw);
      if (!parsed.success) throw new SyncError("invalid_input", parsed.error.issues.map((i) => `${i.path.join(".") || "$"}: ${i.message}`).join("; "));
      const { level, enabled, apply } = parsed.data;
      const id = BigInt(parsed.data.id);
      requireCap(actor, CAP_MONITORING_MANAGE);
      if (level === "dealer") requirePlatformAdmin(actor, "经销商级监控开关"); // 经销商是全局表，关闭会影响所有品牌的门店
      if (level !== "account") requireFullScope(actor, "组织级监控开关"); // 1.0 没有品牌集合范围：影响多个账号的开关只给全范围身份

      if (level === "account") {
        const [a] = await db
          .select({ on: aa.monitoringEnabled, staffId: aa.staffId, platformCode: platforms.platformCode, status: externalAccounts.status })
          .from(aa)
          .innerJoin(platforms, eq(platforms.platformId, aa.platformId))
          .innerJoin(externalAccounts, eq(externalAccounts.accountId, aa.accountId))
          .where(eq(aa.accountId, id));
        if (!a) throw new SyncError("not_found", "账号不存在或没有归属");
        if (!inPlatformScope(actor, a.platformCode) || !inStaffScope(actor, a.staffId)) throw new SyncError("out_of_scope", "账号超出调用方范围");
        if (a.on === enabled) {
          emit({ outcome: "noop", actorId: actor.actorId, detail: { level, id: id.toString(), enabled } });
          return { kind: "noop", level, id: id.toString(), enabled };
        }
        // 账号级只影响一个对象：直接写。关闭写 manual（CHECK 要求关闭必须有原因）；开启清空原因
        // 开启时在同一事务里给无引用账号重置 15 天宽限起点（a-activity-plan design §10.3），免得下一次扫描立即再关
        const now = clock.now();
        await db.transaction(async (tx) => {
          await tx
            .update(aa)
            .set({ monitoringEnabled: enabled, monitoringClosedReason: enabled ? null : "manual", updatedAt: now })
            .where(eq(aa.accountId, id));
          if (enabled) await markGrace(tx, id, now, actor.actorId);
        });
        emit({ outcome: "applied", actorId: actor.actorId, detail: { level, id: id.toString(), enabled, previous_enabled: a.on } });
        return { kind: "applied", level, id: id.toString(), enabled, previousEnabled: a.on, affectedAccounts: 1 };
      }

      const current = await node(level, id);
      if (current === null) throw new SyncError("not_found", "节点不存在");
      const accounts = await accountsUnder(level, id);
      if (!apply) {
        emit({ outcome: "previewed", actorId: actor.actorId, detail: { level, id: id.toString(), enabled, affected_accounts: accounts.length } });
        return {
          kind: "preview",
          level,
          id: id.toString(),
          enabled,
          currentEnabled: current,
          affectedAccounts: accounts.length,
          examples: accounts.slice(0, EXAMPLES).map(String),
          hint: "加 --apply 才会写入；只改这一级自己的开关，不改下级的值",
        };
      }
      if (current === enabled) {
        emit({ outcome: "noop", actorId: actor.actorId, detail: { level, id: id.toString(), enabled } });
        return { kind: "noop", level, id: id.toString(), enabled };
      }
      const now = clock.now();
      if (level === "branch") await db.update(branches).set({ monitoringEnabled: enabled, updatedAt: now }).where(eq(branches.branchId, id));
      else if (level === "dealer") await db.update(dealers).set({ monitoringEnabled: enabled, updatedAt: now }).where(eq(dealers.dealerId, id));
      else if (level === "store") await db.update(stores).set({ monitoringEnabled: enabled, updatedAt: now }).where(eq(stores.storeId, id));
      else await db.update(mediaStaff).set({ monitoringEnabled: enabled, updatedAt: now }).where(eq(mediaStaff.staffId, id));
      emit({ outcome: "applied", actorId: actor.actorId, detail: { level, id: id.toString(), enabled, previous_enabled: current, affected_accounts: accounts.length } });
      return { kind: "applied", level, id: id.toString(), enabled, previousEnabled: current, affectedAccounts: accounts.length };
    } catch (e) {
      if (e instanceof SyncError) emit({ outcome: "rejected", code: e.code, actorId: actor.actorId });
      throw e;
    }
  }
  return { set };
}
export type MonitoringSwitch = ReturnType<typeof createMonitoringSwitch>;
