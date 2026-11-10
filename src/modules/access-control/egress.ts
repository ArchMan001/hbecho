// 数据出口框架（design §7.13、AX-9）：十个出口同一套守卫；异步任务的范围只会收窄；撤权取消用户任务；交付前复查。
//   守卫只做通用部分（动作权限 + 数据范围 + 身份类型）；出口特有规则（导出格式、签名 URL 的具体签法）在所属域。
//   所属域的业务实现按 `guardExit` / `snapshotForJob` / `checkJobAtExecution` / `recheckDelivery` / `registerJobCanceller` 接入；
//   本模块自带 fake 出口的契约测试，各域复用。
import type { AuditWriter } from "./audit";
import type { AuthContext, Authorizer, AuthorizeRequest, Decision, DenyReason } from "./authorize";
import { deny } from "./authorize";
import type { Capability } from "./roles";
import { fingerprint, intersect, isEmptyScope, isSubset, type DataScope } from "./scope";

export type ExitNo = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
export const EXIT_KEYS: Record<ExitNo, string> = {
  1: "page_query",
  2: "manual_sync",
  3: "report",
  4: "export_file",
  5: "media_download",
  6: "raw_payload",
  7: "worker",
  8: "ai_tool",
  9: "notification",
  10: "learning_download",
};

interface ExitRule {
  /** 该出口接受的动作；缺省 = 不限制（页面查询、通知等由调用方给出业务动作）。 */
  capabilities?: readonly Capability[];
  /** 是否必须给出资源做数据范围检查。 */
  scope: boolean;
  /** 只允许用户身份（服务身份永不能把数据交给某个人）。 */
  userOnly?: boolean;
  /** 记审计（谁、何时、什么、结果）。 */
  audited?: boolean;
  /** 需要声明行数上限。 */
  rowLimit?: boolean;
}
const RULES: Record<ExitNo, ExitRule> = {
  1: { scope: true },
  2: { capabilities: ["data.sync.trigger"], scope: true, audited: true },
  3: { capabilities: ["report.read"], scope: true },
  4: { capabilities: ["data.export", "report.export"], scope: true, userOnly: true, audited: true },
  5: { capabilities: ["data.media.read"], scope: true, userOnly: true },
  6: { capabilities: ["data.raw_payload.read"], scope: true, userOnly: true, audited: true },
  7: { scope: false },
  8: { scope: true, audited: true, rowLimit: true },
  9: { scope: true },
  10: { capabilities: ["learning.read"], scope: true, userOnly: true, audited: true },
};

export interface ExitRequest extends AuthorizeRequest {
  /** 审计用：目标与补充信息（课程、文件标识、是否含手机号……）。手机号不逐条记，只在批量导出时由调用方标注。 */
  audit?: { targetType: string; targetId: string; detail?: Record<string, unknown> };
  /** 出口 8：本次取数的行数上限。 */
  rowLimit?: number;
}
export type ExitDecision = Decision | { ok: true; rowLimit?: number };

/** 导出物按**主结构**分类（PRD §10.1）：原始对象 → data.export；报表产物与点检表下钻明细 → report.export。 */
export const exportCapabilityFor = (primary: "raw_objects" | "report_artifact" | "report_drilldown"): Capability => (primary === "raw_objects" ? "data.export" : "report.export");

/** 签名链接的最长有效期（秒）。「短期有效」没有具体数字，这是我取的上限，可调。 */
export const MAX_SIGNED_LINK_TTL_SECONDS = 900;

// ---- 范围快照的序列化（各域把它存进自己的任务表）----------------------------------------------------------
export interface SerializedScope {
  brands: "all" | string[];
  branches: "all" | string[];
  self: { kind: "none" } | { kind: "resolved"; mediaStaffId: string; storeId: string } | { kind: "unresolved"; reason: string };
  level: 1 | 2 | 3;
}
const idsOf = (s: ReadonlySet<bigint> | "all"): "all" | string[] => (s === "all" ? "all" : [...s].map(String).sort());
export function serializeScope(s: DataScope): SerializedScope {
  const self =
    s.self.kind === "resolved"
      ? { kind: "resolved" as const, mediaStaffId: s.self.mediaStaffId.toString(), storeId: s.self.storeId.toString() }
      : s.self.kind === "unresolved"
        ? { kind: "unresolved" as const, reason: s.self.reason }
        : { kind: "none" as const };
  return { brands: idsOf(s.brands), branches: idsOf(s.branches), self, level: s.level };
}
export function parseScope(j: SerializedScope): DataScope {
  const set = (x: "all" | string[]): ReadonlySet<bigint> | "all" => (x === "all" ? "all" : new Set(x.map((v) => BigInt(v))));
  const self =
    j.self.kind === "resolved"
      ? ({ kind: "resolved", mediaStaffId: BigInt(j.self.mediaStaffId), storeId: BigInt(j.self.storeId) } as const)
      : j.self.kind === "unresolved"
        ? ({ kind: "unresolved", reason: j.self.reason as "no_binding" | "staff_inactive" | "ambiguous" } as const)
        : ({ kind: "none" } as const);
  return { brands: set(j.brands), branches: set(j.branches), self, level: j.level };
}

export interface JobSnapshot {
  /** 提交者规范主体；任务继承它，不用服务身份。 */
  actor: string;
  userId: bigint;
  capability: Capability;
  submittedScope: DataScope;
  submittedScopeFingerprint: string;
}

export type JobDecision =
  | { action: "run"; scope: DataScope; narrowed: boolean }
  | { action: "cancel"; reason: "user_not_active" | "capability_revoked" | "scope_empty" };

export interface EgressDeps {
  authorizer: Authorizer;
  audit: AuditWriter;
  alert?: (e: { code: "job_canceller_failed"; name: string; userActor: string }) => void;
}

export function createEgress(deps: EgressDeps) {
  const cancellers = new Map<string, (userActor: string) => Promise<number>>();

  const record = (ctx: AuthContext, exit: ExitNo, req: ExitRequest, outcome: "succeeded" | "denied", reason: DenyReason | null) =>
    deps.audit.write(
      {
        actor: ctx.actor,
        actorUserId: ctx.userId,
        eventType: `egress.${EXIT_KEYS[exit]}`,
        outcome,
        reasonCode: reason ?? "egress_allowed",
        ...(req.audit ? { targetType: req.audit.targetType, targetId: req.audit.targetId } : {}),
        detail: { exit, capability: req.capability, resource: req.resource?.key ?? null, ...(req.audit?.detail ?? {}) },
      },
      { risk: "low" },
    );

  /** 出口守卫：动作权限 + 数据范围 + 出口自己的通用规则；需要审计的出口，允许和拒绝都记。 */
  async function guardExit(exit: ExitNo, ctx: AuthContext, req: ExitRequest): Promise<ExitDecision> {
    const rule = RULES[exit];
    const finish = async (d: ExitDecision): Promise<ExitDecision> => {
      if (rule.audited) await record(ctx, exit, req, d.ok ? "succeeded" : "denied", d.ok ? null : d.reason);
      return d;
    };
    if (exit === 7) {
      // 后台 Worker：服务身份不是用户，不能带角色（不伪造超管）；用户触发的任务继承提交者，走普通授权
      if (ctx.kind === "service" && ctx.role !== null) return finish(deny("forbidden", "service_principal_forbidden"));
    } else if (rule.userOnly && ctx.kind !== "user") {
      return finish(deny("forbidden", "service_principal_forbidden"));
    }
    if (rule.capabilities && !(rule.capabilities as readonly string[]).includes(req.capability)) return finish(deny("forbidden", "exit_not_allowed"));
    if (rule.scope && !req.resource) return finish(deny("forbidden", "scope_required"));
    let rowLimit: number | undefined;
    if (rule.rowLimit) {
      if (!Number.isInteger(req.rowLimit) || (req.rowLimit ?? 0) <= 0) return finish(deny("forbidden", "row_limit_required"));
      rowLimit = req.rowLimit;
    }
    const d = await deps.authorizer.authorize(ctx, req);
    if (!d.ok) return finish(d);
    return finish(rowLimit === undefined ? d : { ok: true, rowLimit });
  }

  // ---- 异步任务：范围只收窄 -------------------------------------------------------------------------------
  /** 提交时调用：记下提交者当时的范围。后续扩权不会扩大这个任务。 */
  function snapshotForJob(ctx: AuthContext, capability: Capability): JobSnapshot {
    if (ctx.kind !== "user" || ctx.userId === null) throw new Error("只有用户身份能提交用户触发的任务；计划任务用固定服务身份，不走快照");
    if (!ctx.capabilities.has(capability)) throw new Error(`提交者没有 ${capability}`);
    return { actor: ctx.actor, userId: ctx.userId, capability, submittedScope: ctx.scope, submittedScopeFingerprint: fingerprint(ctx.scope) };
  }

  /** 有效范围 = 提交时快照 ∩ 执行时主体当前范围。 */
  const effectiveScope = (submitted: DataScope, ctx: AuthContext): DataScope => intersect(submitted, ctx.scope);

  /**
   * 执行时 / 交付前的检查：用提交者**当前**的 ctx（调用方用 authenticator.contextForUser 现建；用户已停用则传 null）。
   * 用户非有效 / 不再持有该 Capability / 有效范围为空 → 取消（范围为空时写审计 delivery_scope_shrunk）。
   */
  async function checkJobAtExecution(snapshot: JobSnapshot, now: AuthContext | null): Promise<JobDecision> {
    const cancel = async (reason: Extract<JobDecision, { action: "cancel" }>["reason"]): Promise<JobDecision> => {
      await deps.audit.write(
        {
          actor: snapshot.actor,
          actorUserId: snapshot.userId,
          eventType: "egress.job_cancelled",
          outcome: "denied",
          reasonCode: reason === "scope_empty" ? "delivery_scope_shrunk" : reason,
          targetType: "user",
          targetId: snapshot.userId.toString(),
          detail: { capability: snapshot.capability, submittedScopeFingerprint: snapshot.submittedScopeFingerprint },
        },
        { risk: "low" },
      );
      return { action: "cancel", reason };
    };
    if (now === null || now.kind !== "user" || now.userId !== snapshot.userId) return cancel("user_not_active");
    if (!now.capabilities.has(snapshot.capability)) return cancel("capability_revoked");
    const scope = effectiveScope(snapshot.submittedScope, now);
    if (isEmptyScope(scope)) return cancel("scope_empty");
    return { action: "run", scope, narrowed: fingerprint(scope) !== snapshot.submittedScopeFingerprint };
  }

  /**
   * 交付前复查：产物范围 ⊆ 当前范围 → deliver；不⊆但可按新范围重建 → rebuild；否则 deny。
   * 当前范围为空（撤权后）不会 rebuild：没有可重建的内容。
   */
  function recheckDelivery(artifact: { scope: DataScope; rebuildable: boolean }, ctx: AuthContext): "deliver" | "rebuild" | "deny" {
    if (isSubset(artifact.scope, ctx.scope)) return "deliver";
    return artifact.rebuildable && !isEmptyScope(ctx.scope) ? "rebuild" : "deny";
  }

  // ---- 撤权取消 ---------------------------------------------------------------------------------------------
  function registerJobCanceller(name: string, fn: (userActor: string) => Promise<number>): void {
    if (cancellers.has(name)) throw new Error(`JobCanceller ${name} 已注册`);
    cancellers.set(name, fn);
  }

  /**
   * 停用 / 撤权事务**提交之后**调用：取消该用户触发的未完成异步任务。计划任务（服务身份）不受影响。
   * 任一 canceller 失败 → 告警 + 审计，不抛、不回滚（各域任务自带过期与交付前复查兜底）。
   */
  async function cancelUserJobs(userActor: string): Promise<{ byName: Record<string, number>; failed: string[] }> {
    const byName: Record<string, number> = {};
    const failed: string[] = [];
    if (!userActor.startsWith("user:")) return { byName, failed }; // 服务身份的计划任务不取消
    for (const [name, fn] of cancellers) {
      try {
        byName[name] = await fn(userActor);
      } catch {
        failed.push(name);
        try {
          deps.alert?.({ code: "job_canceller_failed", name, userActor });
        } catch {
          // 告警出口失败不改变结果
        }
      }
    }
    await deps.audit.write(
      {
        actor: "service:access-worker",
        eventType: "egress.jobs_cancelled",
        outcome: failed.length === 0 ? "succeeded" : "failed",
        reasonCode: "job_cancelled_on_revoke",
        targetType: "user",
        targetId: userActor.slice("user:".length),
        detail: { byName, failed },
      },
      { risk: "low" },
    );
    return { byName, failed };
  }

  // ---- 签名链接（出口 5）----------------------------------------------------------------------------------
  /**
   * 签发短期链接：每次签发（含续签）都重新过出口 5 的守卫，所以撤权后不能续签；有效期有上限。
   * 具体怎么签（OSS 签名、路径）由所属域通过 `sign` 提供。
   */
  async function issueSignedLink(
    ctx: AuthContext,
    req: ExitRequest,
    sign: (ttlSeconds: number) => Promise<string> | string,
    ttlSeconds: number,
    now: Date,
  ): Promise<{ ok: true; url: string; expiresAt: Date } | { ok: false; reason: DenyReason | "ttl_invalid" }> {
    if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > MAX_SIGNED_LINK_TTL_SECONDS) return { ok: false, reason: "ttl_invalid" };
    const d = await guardExit(5, ctx, req);
    if (!d.ok) return { ok: false, reason: d.reason };
    return { ok: true, url: await sign(ttlSeconds), expiresAt: new Date(now.getTime() + ttlSeconds * 1000) };
  }

  return { guardExit, snapshotForJob, effectiveScope, checkJobAtExecution, recheckDelivery, registerJobCanceller, cancelUserJobs, issueSignedLink };
}
export type Egress = ReturnType<typeof createEgress>;
