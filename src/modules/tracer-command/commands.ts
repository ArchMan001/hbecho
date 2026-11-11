// AccountTracerCommandModule：受控提交、幂等根任务、取消（R1、R14.6、R18.6）。
// 一个 tracer 命令 = 一个 manual SyncBatch + 一个根 resolve_account SyncTask；root_task_id 即根任务 task_id（v2 §9.3）。
// 本模块不做任何网络 IO；数据库事务只包住几条短写入。
import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import type { Db, DbTx } from "../../db/client";
import { mediaStaff, platforms, syncBatches, syncSettings, syncTasks } from "../../db/schema";
import { jcsSha256, jcsSha256Hex } from "../canonical-json";
import { UnsupportedCapabilityError, capabilityGate, type Platform } from "../provider-adapter";
import type { Clock } from "../raw-capture";
import { inScope, requireCapability, type ActorContext } from "./actor";
import type { AuditEvent, AuditSink } from "./audit";
import { buildCommandV1, buildRosterTaskParameters, buildTaskParameters, commandDigest, decimalId, rosterCommandDigest, sha256Of } from "./canonical";
import { DEFAULT_CONFIG, ONE_YEAR_MS, type TracerConfig } from "./config";
import { TracerError } from "./errors";
import { ACTIVE_STATUSES, createTracerStatusQuery, parseRootId, type TracerStatusFound } from "./status";

const submitInput = z.strictObject({
  platform: z.string().min(1).max(64),
  mediaStaffId: decimalId,
  homeLocator: z.string().min(1).max(2048).refine((s) => s.isWellFormed(), "含孤立代理项"),
  idempotencyKey: z.string().min(1).max(200),
  initialContentLimit: z.number().int().min(1).max(20).optional(),
});

export interface SubmitOutcome {
  rootTaskId: string;
  /** 同一 actor + key + payload 命中了一年窗口内的原 root。 */
  deduplicated: boolean;
  /** 不同 key 但同一命令已有活动任务，复用了它（R1.8）。 */
  reusedActiveTask: boolean;
}

export interface TracerCommands {
  submit(input: unknown, actor: ActorContext): Promise<SubmitOutcome>;
  /**
   * 外部监控账号的入口根任务（FS-13.5；没有 MediaStaff，subject_type='external'）。**不做授权**：调用方（sync-ops.externalAdd）
   * 必须先校验 monitor.external.manage 与超管。只校验输入、平台与主页 capability，再走和 submit 同一套幂等 / 去重。
   */
  submitExternal(input: { platform: string; homeLocator: string; idempotencyKey: string; actorId: string }): Promise<SubmitOutcome>;
  cancel(rootTaskId: string, actor: ActorContext): Promise<TracerStatusFound>;
  /**
   * 名单导入的批量根任务（a-activity-plan design §10.2）：在**调用方给定的事务**里创建，一个导入批次共用**一个** intake 同步批次
   * （批次键由导入批次推出，续跑不重复创建）；每行一个 profile_only 的 resolve_account 根任务，幂等键 `roster:<导入批次>:<行号>`。
   * **不做授权**：调用方（activity-plan.confirm）已校验；只校验输入与主页 capability。不做任何网络 IO。
   */
  submitRoster(tx: DbTx, input: RosterSubmit): Promise<RosterSubmitResult>;
}
export interface RosterSubmit {
  importBatchId: bigint;
  actorId: string;
  platform: string;
  items: ReadonlyArray<{ rowNo: number; staffId: bigint; locator: string }>;
}
export interface RosterSubmitResult {
  syncBatchId: bigint;
  tasks: Array<{ rowNo: number; rootTaskId: bigint; deduplicated: boolean }>;
}

const externalInput = z.strictObject({
  platform: z.string().min(1).max(64),
  homeLocator: z.string().min(1).max(2048).refine((s) => s.isWellFormed(), "含孤立代理项"),
  idempotencyKey: z.string().min(1).max(200),
  actorId: z.string().min(1).max(128),
});
const TERMINAL = ["succeeded", "succeeded_with_gap", "failed", "dead", "cancelled"] as const;
const isTerminal = (s: string) => (TERMINAL as readonly string[]).includes(s);

function isDuplicateKey(e: unknown): boolean {
  for (let cur = e as { code?: string; cause?: unknown } | undefined; cur; cur = cur.cause as typeof cur) {
    if (cur.code === "ER_DUP_ENTRY") return true;
  }
  return false;
}

export function createTracerCommands(deps: { db: Db; clock: Clock; audit: AuditSink; config?: TracerConfig }): TracerCommands {
  const { db, clock, audit } = deps;
  const config = deps.config ?? DEFAULT_CONFIG;
  const retentionMs = config.retentionMs ?? ONE_YEAR_MS;
  const statusQuery = createTracerStatusQuery({ db, clock });

  const emit = (e: Omit<AuditEvent, "at" | "event">) => audit.record({ at: clock.now().toISOString(), event: "tracer.command", ...e });

  async function submit(raw: unknown, actor: ActorContext): Promise<SubmitOutcome> {
    const meta: Partial<AuditEvent> = {};
    try {
      const out = await doSubmit(raw, actor, meta);
      emit({
        action: "submit",
        outcome: out.deduplicated ? "deduplicated" : out.reusedActiveTask ? "reused_active_task" : "accepted",
        actorId: actor.actorId,
        rootTaskId: out.rootTaskId,
        ...pick(meta),
      });
      return out;
    } catch (e) {
      if (e instanceof TracerError) emit({ action: "submit", outcome: "rejected", code: e.code, actorId: actor.actorId, ...pick(meta) });
      throw e;
    }
  }

  async function doSubmit(raw: unknown, actor: ActorContext, meta: Partial<AuditEvent>): Promise<SubmitOutcome> {
    // 1) 输入校验（trust boundary）
    const parsed = submitInput.safeParse(raw);
    if (!parsed.success) {
      throw new TracerError("invalid_input", parsed.error.issues.map((i) => `${i.path.join(".") || "$"}: ${i.message}`).join("; "));
    }
    const input = parsed.data;
    const staffId = BigInt(input.mediaStaffId);
    meta.platform = input.platform;
    meta.mediaStaffId = input.mediaStaffId;
    meta.locatorSha256 = sha256Of(input.homeLocator).toString("hex").slice(0, 16);
    meta.locatorLength = input.homeLocator.length;

    // 2) 授权与范围——先于任何数据库读取与供应商调用
    requireCapability(actor);
    if (!inScope(actor, input.platform, staffId)) throw new TracerError("out_of_scope", "平台或 MediaStaff 超出调用方范围");

    // 3) capability 门控：两个 action 都必须由已验证 tuple 启用
    for (const action of ["media_user_info", "user_video_list"] as const) {
      try {
        capabilityGate.require({ platform: input.platform as Platform, action, mode: config.modes[action], environment: config.environment });
      } catch (e) {
        if (e instanceof UnsupportedCapabilityError) throw new TracerError("unsupported_capability", e.message);
        throw e;
      }
    }

    // 4) 引用的主档
    const [platform] = await db.select().from(platforms).where(eq(platforms.platformCode, input.platform));
    if (!platform) throw new TracerError("unsupported_capability", `平台 ${input.platform} 未登记`);
    const [staff] = await db.select().from(mediaStaff).where(eq(mediaStaff.staffId, staffId));
    if (!staff) throw new TracerError("media_staff_not_found", "MediaStaff 不存在");
    if (staff.status !== "active") throw new TracerError("media_staff_inactive", "MediaStaff 已停用");
    const [settings] = await db.select().from(syncSettings).where(eq(syncSettings.settingsId, 1));
    if (!settings) throw new TracerError("sync_settings_missing", "sync_settings 未配置");

    // 5) canonical command 与摘要
    const effectiveLimit = input.initialContentLimit ?? settings.initialContentLimit;
    const command = buildCommandV1({ platformId: platform.platformId, mediaStaffId: staffId, homeLocator: input.homeLocator, effectiveLimit });
    const commandSha = commandDigest(command);
    const callerKeySha = sha256Of(input.idempotencyKey);

    // 6) 短事务；唯一键竞争时重试一次（另一个并发提交已提交，重试会命中去重）
    for (let attempt = 0; ; attempt++) {
      try {
        return await db.transaction((tx) =>
          insertOrReuse(tx, { actorId: actor.actorId, callerKeySha, commandSha, platformId: platform.platformId, staffId, locator: input.homeLocator, effectiveLimit, settings }),
        );
      } catch (e) {
        if (attempt === 0 && isDuplicateKey(e)) continue;
        throw e;
      }
    }
  }

  async function insertOrReuse(
    tx: DbTx,
    p: {
      actorId: string;
      callerKeySha: Buffer;
      commandSha: Buffer;
      platformId: bigint;
      /** null = 外部监控账号。 */
      staffId: bigint | null;
      locator: string;
      effectiveLimit: number;
      settings: typeof syncSettings.$inferSelect;
    },
  ): Promise<SubmitOutcome> {
    const now = clock.now();

    // 同一 actor + key：窗口内比较 payload；窗口外视为新命令，释放旧 root 占用的 key（旧 status 不再承诺）
    const [existing] = await tx
      .select()
      .from(syncTasks)
      .where(and(eq(syncTasks.submittedByActor, p.actorId), eq(syncTasks.callerIdempotencyKeySha256, p.callerKeySha)));
    if (existing) {
      if (existing.expiresAt.getTime() > now.getTime()) {
        if (existing.canonicalCommandSha256?.equals(p.commandSha)) {
          return { rootTaskId: existing.taskId.toString(), deduplicated: true, reusedActiveTask: false };
        }
        throw new TracerError("idempotency_conflict", "同一幂等 key 对应了不同的命令内容");
      }
      await tx
        .update(syncTasks)
        .set({ submittedByActor: null, callerIdempotencyKeySha256: null, canonicalCommandSha256: null, updatedAt: now })
        .where(eq(syncTasks.taskId, existing.taskId));
    }

    // 同一命令已有活动 root：复用，不并发再建（R1.8、R18.6）
    const [active] = await tx
      .select({ taskId: syncTasks.taskId })
      .from(syncTasks)
      .where(
        and(
          eq(syncTasks.canonicalCommandSha256, p.commandSha),
          eq(syncTasks.requestedAction, "resolve_account"),
          isNull(syncTasks.parentTaskId),
          inArray(syncTasks.status, [...ACTIVE_STATUSES]),
        ),
      )
      .limit(1);
    if (active) return { rootTaskId: active.taskId.toString(), deduplicated: false, reusedActiveTask: true };

    const acceptedAt = now.toISOString();
    const effectKey = (kind: string) =>
      Buffer.from(jcsSha256Hex({ kind, actor_id: p.actorId, caller_key_sha256: p.callerKeySha.toString("hex"), accepted_at: acceptedAt }), "hex");

    const s = p.settings;
    const [batch] = await tx.insert(syncBatches).values({
      batchKey: effectKey("tracer_manual_batch"),
      triggerType: "manual",
      purpose: "intake",
      logicalAt: now,
      status: "running",
      settingsVersion: s.configVersion,
      settingsSnapshot: snapshotOf(s),
      plannedTaskCount: 1,
      startedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    const [providerRow] = await tx.query.dataProviders.findMany({ where: (d, { eq: e }) => e(d.providerCode, "aimaster"), limit: 1 });
    if (!providerRow) throw new TracerError("unsupported_capability", "数据供应商 aimaster 未登记");

    const [task] = await tx.insert(syncTasks).values({
      batchId: BigInt(batch.insertId),
      providerId: providerRow.providerId,
      platformId: p.platformId,
      requestedAction: "resolve_account",
      subjectType: p.staffId === null ? "external" : "media_staff",
      subjectId: p.staffId,
      subjectKey: p.locator,
      subjectKeySha256: sha256Of(p.locator),
      taskParameters: buildTaskParameters(p.effectiveLimit),
      idempotencyKey: effectKey("tracer_root"),
      submittedByActor: p.actorId,
      callerIdempotencyKeySha256: p.callerKeySha,
      canonicalCommandSha256: p.commandSha,
      status: "pending",
      attemptCount: 0,
      maxAttempts: s.accountResolveMaxAttempts,
      expiresAt: new Date(now.getTime() + retentionMs),
      createdAt: now,
      updatedAt: now,
    });
    return { rootTaskId: BigInt(task.insertId).toString(), deduplicated: false, reusedActiveTask: false };
  }

  async function cancel(rootTaskIdRaw: string, actor: ActorContext): Promise<TracerStatusFound> {
    const meta: Partial<AuditEvent> = {};
    try {
      requireCapability(actor);
      const rootId = parseRootId(rootTaskIdRaw);
      meta.rootTaskId = rootId.toString();

      // 范围与存在性检查走状态查询：未知、越权、过期都按 not_found 处理
      const before = await statusQuery.get(rootTaskIdRaw, actor);
      if (before.kind !== "found") throw new TracerError("not_found", "root 不存在或已过期");

      const now = clock.now();
      const changed = await db.transaction(async (tx) => {
        const [root] = await tx.select().from(syncTasks).where(eq(syncTasks.taskId, rootId)).for("update");
        if (!root || isTerminal(root.status)) return false;
        // 先使旧 fencing token 失效，再关闭 root 与所有未终态的子任务；已捕获的证据不动
        const closed = {
          status: "cancelled",
          leaseOwner: null,
          leaseExpiresAt: null,
          nextAttemptAt: null,
          stopReason: "cancelled_by_actor",
          finishedAt: now,
          updatedAt: now,
        } as const;
        await tx.update(syncTasks).set({ ...closed, fencingToken: root.fencingToken + 1n }).where(eq(syncTasks.taskId, rootId));
        const children = await tx.select().from(syncTasks).where(eq(syncTasks.parentTaskId, rootId)).for("update");
        for (const c of children) {
          if (isTerminal(c.status)) continue;
          await tx.update(syncTasks).set({ ...closed, fencingToken: c.fencingToken + 1n }).where(eq(syncTasks.taskId, c.taskId));
        }
        return true;
      });

      emit({ action: "cancel", outcome: changed ? "cancelled" : "cancel_noop", actorId: actor.actorId, ...pick(meta) });
      const after = await statusQuery.get(rootTaskIdRaw, actor);
      if (after.kind !== "found") throw new TracerError("not_found", "root 不存在或已过期");
      return after;
    } catch (e) {
      if (e instanceof TracerError) emit({ action: "cancel", outcome: "rejected", code: e.code, actorId: actor.actorId, ...pick(meta) });
      throw e;
    }
  }

  async function submitExternal(i: { platform: string; homeLocator: string; idempotencyKey: string; actorId: string }): Promise<SubmitOutcome> {
    const parsed = externalInput.safeParse(i);
    if (!parsed.success) throw new TracerError("invalid_input", parsed.error.issues.map((x) => `${x.path.join(".") || "$"}: ${x.message}`).join("; "));
    const input = parsed.data;
    try {
      capabilityGate.require({ platform: input.platform as Platform, action: "media_user_info", mode: config.modes.media_user_info, environment: config.environment });
    } catch (e) {
      if (e instanceof UnsupportedCapabilityError) throw new TracerError("unsupported_capability", e.message);
      throw e;
    }
    const [platform] = await db.select().from(platforms).where(eq(platforms.platformCode, input.platform));
    if (!platform) throw new TracerError("unsupported_capability", `平台 ${input.platform} 未登记`);
    const [settings] = await db.select().from(syncSettings).where(eq(syncSettings.settingsId, 1));
    if (!settings) throw new TracerError("sync_settings_missing", "sync_settings 未配置");
    // 外部型的命令摘要没有专员字段，用自己的 closed schema（版本号不同，不会和专员型命令碰撞）
    const commandSha = jcsSha256({ v: "sync-external-add.v1", platform_id_decimal: platform.platformId.toString(), home_locator_exact_utf8: input.homeLocator });
    const callerKeySha = sha256Of(input.idempotencyKey);
    for (let attempt = 0; ; attempt++) {
      try {
        return await db.transaction((tx) =>
          insertOrReuse(tx, { actorId: input.actorId, callerKeySha, commandSha, platformId: platform.platformId, staffId: null, locator: input.homeLocator, effectiveLimit: settings.initialContentLimit, settings }),
        );
      } catch (e) {
        if (attempt === 0 && isDuplicateKey(e)) continue;
        throw e;
      }
    }
  }
  async function submitRoster(tx: DbTx, input: RosterSubmit): Promise<RosterSubmitResult> {
    try {
      capabilityGate.require({ platform: input.platform as Platform, action: "media_user_info", mode: config.modes.media_user_info, environment: config.environment });
    } catch (e) {
      if (e instanceof UnsupportedCapabilityError) throw new TracerError("unsupported_capability", e.message);
      throw e;
    }
    for (const it of input.items) {
      if (it.locator.length < 1 || it.locator.length > 2048 || !it.locator.isWellFormed()) throw new TracerError("invalid_input", `第 ${it.rowNo} 行的主页入口不合法`);
    }
    const now = clock.now();
    const [platform] = await tx.select().from(platforms).where(eq(platforms.platformCode, input.platform));
    if (!platform) throw new TracerError("unsupported_capability", `平台 ${input.platform} 未登记`);
    const [settings] = await tx.select().from(syncSettings).where(eq(syncSettings.settingsId, 1));
    if (!settings) throw new TracerError("sync_settings_missing", "sync_settings 未配置");
    const [provider] = await tx.query.dataProviders.findMany({ where: (d, { eq: e }) => e(d.providerCode, "aimaster"), limit: 1 });
    if (!provider) throw new TracerError("unsupported_capability", "数据供应商 aimaster 未登记");
    // 一个导入批次一个同步批次：批次键由导入批次推出，续跑 / 重复调用命中同一行
    const batchKey = jcsSha256({ kind: "roster_import_sync_batch", import_batch_id: input.importBatchId.toString() });
    let [batch] = await tx.select().from(syncBatches).where(eq(syncBatches.batchKey, batchKey));
    if (!batch) {
      const [ins] = await tx.insert(syncBatches).values({
        batchKey,
        triggerType: "manual",
        purpose: "intake",
        logicalAt: now,
        status: "running",
        settingsVersion: settings.configVersion,
        settingsSnapshot: snapshotOf(settings),
        plannedTaskCount: 0,
        startedAt: now,
        createdAt: now,
        updatedAt: now,
      });
      [batch] = await tx.select().from(syncBatches).where(eq(syncBatches.batchId, BigInt(ins.insertId)));
    }
    const out: RosterSubmitResult = { syncBatchId: batch!.batchId, tasks: [] };
    let created = 0;
    for (const it of input.items) {
      const callerKeySha = sha256Of(`roster:${input.importBatchId}:${it.rowNo}`);
      const [existing] = await tx
        .select({ taskId: syncTasks.taskId })
        .from(syncTasks)
        .where(and(eq(syncTasks.submittedByActor, input.actorId), eq(syncTasks.callerIdempotencyKeySha256, callerKeySha)));
      if (existing) {
        out.tasks.push({ rowNo: it.rowNo, rootTaskId: existing.taskId, deduplicated: true });
        continue;
      }
      const [task] = await tx.insert(syncTasks).values({
        batchId: batch!.batchId,
        providerId: provider.providerId,
        platformId: platform.platformId,
        requestedAction: "resolve_account",
        subjectType: "media_staff",
        subjectId: it.staffId,
        subjectKey: it.locator,
        subjectKeySha256: sha256Of(it.locator),
        taskParameters: buildRosterTaskParameters(input.importBatchId, it.rowNo),
        idempotencyKey: jcsSha256({ kind: "roster_root", import_batch_id: input.importBatchId.toString(), row_no: it.rowNo }),
        submittedByActor: input.actorId,
        callerIdempotencyKeySha256: callerKeySha,
        canonicalCommandSha256: rosterCommandDigest({ platformId: platform.platformId, staffId: it.staffId, locator: it.locator, importBatchId: input.importBatchId, rowNo: it.rowNo }),
        status: "pending",
        attemptCount: 0,
        maxAttempts: settings.accountResolveMaxAttempts,
        expiresAt: new Date(now.getTime() + retentionMs),
        createdAt: now,
        updatedAt: now,
      });
      created++;
      out.tasks.push({ rowNo: it.rowNo, rootTaskId: BigInt(task.insertId), deduplicated: false });
    }
    if (created > 0) await tx.update(syncBatches).set({ plannedTaskCount: batch!.plannedTaskCount + created, updatedAt: now }).where(eq(syncBatches.batchId, batch!.batchId));
    return out;
  }
  return { submit, submitExternal, cancel, submitRoster };
}
/** 批次创建时冻结的同步设置快照（手动 tracer 批次与名单导入批次共用）。 */
function snapshotOf(s: typeof syncSettings.$inferSelect) {
  return {
    timezone: s.timezone,
    schedule_slots: s.scheduleSlots,
    initial_content_limit: s.initialContentLimit,
    list_safety_page_limit: s.listSafetyPageLimit,
    comment_page_limit: s.commentPageLimit,
    comment_item_limit: s.commentItemLimit,
    account_resolve_max_attempts: s.accountResolveMaxAttempts,
    task_max_attempts: s.taskMaxAttempts,
    config_version: s.configVersion.toString(),
  };
}

function pick(meta: Partial<AuditEvent>): Partial<AuditEvent> {
  const out: Partial<AuditEvent> = {};
  if (meta.platform !== undefined) out.platform = meta.platform;
  if (meta.mediaStaffId !== undefined) out.mediaStaffId = meta.mediaStaffId;
  if (meta.rootTaskId !== undefined) out.rootTaskId = meta.rootTaskId;
  if (meta.locatorSha256 !== undefined) out.locatorSha256 = meta.locatorSha256;
  if (meta.locatorLength !== undefined) out.locatorLength = meta.locatorLength;
  return out;
}
