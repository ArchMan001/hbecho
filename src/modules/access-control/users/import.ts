// 用户批量导入（design §7.12、AX-3）：CSV → 同步预检 → 提交人确认 → 回流文件。
//   - 沿用 a-master-data-import 的批次 / 行结果表（import_kind='user_import'）、租约 + fencing、回流写法，以及 csv-file 的严格解析；
//   - 预检与确认都经 admin.prepareInvite / inviteIn：和单个邀请是**同一套**规则，没有第二份；
//   - 预检不改任何用户 / 认证 / 授权行；确认时重新校验每个待写入的行（授权、专员、手机号），不信任预检结果；
//   - 越权行进跳过清单（error），不让整批失败；预检为 error 的行**不会**在确认时被「升级」成新增；
//   - 只做新增：没有「改成更新」的入口；手机号已被占用就是 phone_exists。
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, lt, ne, or } from "drizzle-orm";
import type { Db, DbTx } from "../../../db/client";
import { accessUsers, branches, brands, importBatches, importRowResults } from "../../../db/schema";
import { buildCsv, CsvFileError, parseCsv } from "../../csv-file";
import { normalizePhone } from "../../phone";
import type { Clock } from "../../raw-capture/ports";
import type { AuditWriter } from "../audit";
import type { AuthContext } from "../authorize";
import { AccessError } from "../errors";
import type { Principal } from "../grants";
import type { RoleCode } from "../roles";
import type { InviteInput, UserAdmin } from "./admin";

export const TEMPLATE_VERSION = "user-import.v1";
export const USER_IMPORT_HEADER = ["姓名", "角色", "手机号", "品牌", "分公司", "门店编码"] as const;
export const USER_IMPORT_LIMITS = { maxBytes: 10 * 1024 * 1024, maxRows: 1000 } as const;
export const RETURN_COLUMNS = [...USER_IMPORT_HEADER, "结果", "原因", "指引"] as const;
const STALE_LEASE_MS = 2 * 60_000;

/** 角色列：中文名（PRD §2.1）或角色码都认。 */
const ROLE_NAMES: Record<string, RoleCode> = {
  超级管理员: "platform_admin",
  总部人员: "hq_manager",
  分公司人员: "branch_manager",
  经销商人员: "store_staff",
  platform_admin: "platform_admin",
  hq_manager: "hq_manager",
  branch_manager: "branch_manager",
  store_staff: "store_staff",
};

/** 每个原因码一句指引（面向业务，告诉他下一步做什么）。 */
export const GUIDANCE: Record<string, string> = {
  missing_required_field: "姓名、角色、手机号必填，请补全后重新上传",
  name_invalid: "姓名不能为空，且不超过 100 个字符",
  role_invalid: "角色请填：超级管理员 / 总部人员 / 分公司人员 / 经销商人员",
  phone_invalid: "手机号请填 11 位大陆手机号",
  brand_not_found: "品牌编码不存在，请核对品牌编码（多个用分号隔开）",
  branch_not_found: "分公司编码不存在，请核对分公司编码（多个用分号隔开）",
  brand_required: "总部人员和分公司人员必须填写品牌",
  branch_required: "分公司人员必须填写分公司",
  store_code_required: "经销商人员必须填写门店编码",
  scope_fields_not_allowed: "这个角色不需要填写该列，请清空：超管不填品牌/分公司/门店，总部只填品牌，分公司人员填品牌和分公司，经销商人员只填门店编码",
  duplicate_phone_in_file: "文件里有多行使用了这个手机号，请只保留一行",
  role_not_grantable: "你不能创建这个级别的用户（只能创建比你低一级的角色），请联系上级管理员，或移出本文件",
  scope_exceeds_boundary: "品牌或分公司超出了你的管理范围，请联系上级管理员，或移出本文件",
  store_not_in_scope: "这个门店不在你的管理范围内，请联系有权限的管理员",
  shape_invalid: "角色与品牌、分公司的组合不对，请对照模板说明修改",
  staff_not_found: "系统里找不到这个手机号在该门店下的专员，请先确认主数据里的专员手机号与门店编码",
  staff_inactive: "这位专员已停用，不能建立登录账号",
  staff_already_bound: "这位专员已经有登录账号了，如需换号请先停用旧用户，再新建",
  phone_exists: "这个手机号已经是待激活或有效用户。如果是换号，请先到用户管理里停用旧用户，再新建；不会自动覆盖",
  conflict_at_confirm: "确认写入时这个手机号已被别人先建了，没有重复创建，请到用户管理里查看",
  authorization_changed: "确认时你的权限已经变化，这一行没有写入，请联系管理员后重新上传",
};
const guidanceOf = (code: string | null): string => (code ? (GUIDANCE[code] ?? "请联系管理员处理") : "");

export interface UserImportDeps {
  db: Db;
  clock: Clock;
  audit: AuditWriter;
  admin: Pick<UserAdmin, "prepareInvite" | "inviteIn" | "requireManager">;
  newToken?: () => string;
}

type ParsedRow = { ok: true; input: InviteInput; phone: string } | { ok: false; code: string; detail?: string };
interface Refs {
  brandIds: Map<string, bigint>;
  branchIds: Map<string, bigint>;
}
const split = (cell: string): string[] =>
  cell
    .split(/[;；、|]/)
    .map((x) => x.trim())
    .filter((x) => x !== "");

async function loadRefs(db: Db | DbTx): Promise<Refs> {
  const [b, br] = await Promise.all([db.select({ id: brands.brandId, code: brands.brandCode }).from(brands), db.select({ id: branches.branchId, code: branches.branchCode }).from(branches)]);
  return { brandIds: new Map(b.map((x) => [x.code, x.id])), branchIds: new Map(br.map((x) => [x.code, x.id])) };
}

/** 一行 → InviteInput（纯字段层面的校验；授权、专员、手机号占用留给 prepareInvite）。 */
function parseRow(cells: readonly string[], refs: Refs): ParsedRow {
  const [name = "", roleCell = "", phoneCell = "", brandCell = "", branchCell = "", storeCell = ""] = cells.map((c) => c.trim());
  if (name === "" || roleCell === "" || phoneCell === "") return { ok: false, code: "missing_required_field" };
  if (name.length > 100) return { ok: false, code: "name_invalid" };
  const role = ROLE_NAMES[roleCell];
  if (!role) return { ok: false, code: "role_invalid", detail: roleCell };
  const phone = normalizePhone(phoneCell);
  if (phone === null) return { ok: false, code: "phone_invalid" };
  const brandCodes = split(brandCell);
  const branchCodes = split(branchCell);
  const hasStore = storeCell !== "";
  // 列与角色是否匹配：多余的列要明确拒绝，不静默忽略（否则业务以为填了就生效）
  if (role === "platform_admin" && (brandCodes.length || branchCodes.length || hasStore)) return { ok: false, code: "scope_fields_not_allowed" };
  if (role === "hq_manager" && (branchCodes.length || hasStore)) return { ok: false, code: "scope_fields_not_allowed" };
  if (role === "branch_manager" && hasStore) return { ok: false, code: "scope_fields_not_allowed" };
  if (role === "store_staff" && (brandCodes.length || branchCodes.length)) return { ok: false, code: "scope_fields_not_allowed" };
  if ((role === "hq_manager" || role === "branch_manager") && brandCodes.length === 0) return { ok: false, code: "brand_required" };
  if (role === "branch_manager" && branchCodes.length === 0) return { ok: false, code: "branch_required" };
  if (role === "store_staff" && !hasStore) return { ok: false, code: "store_code_required" };
  const brandIds: bigint[] = [];
  for (const c of brandCodes) {
    const id = refs.brandIds.get(c);
    if (id === undefined) return { ok: false, code: "brand_not_found", detail: c };
    brandIds.push(id);
  }
  const branchIds: bigint[] = [];
  for (const c of branchCodes) {
    const id = refs.branchIds.get(c);
    if (id === undefined) return { ok: false, code: "branch_not_found", detail: c };
    branchIds.push(id);
  }
  return { ok: true, phone, input: { name, role, phone, brandIds, branchIds, ...(hasStore ? { storeCode: storeCell } : {}) } };
}

const rawOf = (cells: readonly string[]): Record<string, string> => Object.fromEntries(USER_IMPORT_HEADER.map((h, i) => [h, cells[i] ?? ""]));
const cellsOfRaw = (raw: unknown): string[] => USER_IMPORT_HEADER.map((h) => String((raw as Record<string, unknown>)[h] ?? ""));

export interface PrecheckRowView {
  rowNo: number;
  precheckClass: "new" | "error";
  outcome: string | null;
  reasonCode: string | null;
  reasonDetail: string | null;
  guidance: string;
}
export interface BatchView {
  batchId: string;
  status: string;
  fileName: string | null;
  totalRows: number;
  newRows: number;
  /** 越权（跳过）行：角色不可授 / 超出品牌分公司 / 门店不在范围内。 */
  skippedRows: number;
  /** 其他错误行。 */
  errorRows: number;
  conflictRows: number;
  summary: unknown;
  rows: PrecheckRowView[];
}

const SKIP_CODES = new Set(["role_not_grantable", "scope_exceeds_boundary", "store_not_in_scope"]);

export function createUserImport(deps: UserImportDeps) {
  const { db, clock, admin } = deps;
  const newToken = deps.newToken ?? randomUUID;

  /** 只有提交人本人能看 / 确认 / 下载；他人（包括更高级别的管理员）一律「未找到」。 */
  async function loadOwn(ctx: AuthContext, batchId: bigint) {
    const [b] = await db.select().from(importBatches).where(and(eq(importBatches.importBatchId, batchId), eq(importBatches.importKind, "user_import")));
    if (!b || ctx.userId === null || b.uploadedByUserId !== ctx.userId) throw new AccessError("not_found", "batch_not_found", "批次不存在");
    return b;
  }

  async function view(batchId: bigint): Promise<BatchView> {
    const [b] = await db.select().from(importBatches).where(eq(importBatches.importBatchId, batchId));
    const rows = await db.select().from(importRowResults).where(eq(importRowResults.importBatchId, batchId)).orderBy(asc(importRowResults.rowNo));
    return {
      batchId: batchId.toString(),
      status: b!.status,
      fileName: b!.fileName,
      totalRows: b!.totalRows,
      newRows: b!.newRows,
      skippedRows: b!.skippedRows,
      errorRows: b!.errorRows,
      conflictRows: b!.conflictRows,
      summary: b!.summary,
      rows: rows.map((r) => ({
        rowNo: r.rowNo,
        precheckClass: r.precheckClass as "new" | "error",
        outcome: r.outcome,
        reasonCode: r.reasonCode,
        reasonDetail: r.reasonDetail,
        guidance: guidanceOf(r.reasonCode),
      })),
    };
  }

  return {
    /** 预检：文件级失败不建批次；逐行分类；整个过程不写用户相关表。 */
    async precheck(ctx: AuthContext, file: { name: string; bytes: Uint8Array }): Promise<BatchView> {
      const p: Principal = await admin.requireManager(ctx);
      let parsed;
      try {
        parsed = parseCsv(file.bytes, { header: USER_IMPORT_HEADER, limits: USER_IMPORT_LIMITS });
      } catch (e) {
        if (e instanceof CsvFileError) throw new AccessError("input", e.code, e.message, e.detail);
        throw e;
      }
      const refs = await loadRefs(db);
      const results = new Map<number, { code: string; detail?: string } | null>(); // null = new
      const parsedRows = new Map<number, ParsedRow>();
      for (const r of parsed.rows) parsedRows.set(r.rowNo, parseRow(r.cells, refs));

      // 文件内手机号重复：整组报错（两行都报，不选一行当真）
      const byPhone = new Map<string, number[]>();
      for (const [rowNo, pr] of parsedRows) if (pr.ok) byPhone.set(pr.phone, [...(byPhone.get(pr.phone) ?? []), rowNo]);
      const dupRows = new Map<number, number[]>();
      for (const rows of byPhone.values()) if (rows.length > 1) for (const n of rows) dupRows.set(n, rows);

      // 已被「待激活 + 有效」占用的手机号，一次查完
      const okPhones = [...byPhone.keys()];
      const taken = new Set<string>();
      for (let i = 0; i < okPhones.length; i += 500) {
        const chunk = okPhones.slice(i, i + 500);
        const rows = await db.select({ phone: accessUsers.phone }).from(accessUsers).where(and(inArray(accessUsers.phone, chunk), ne(accessUsers.status, "disabled")));
        for (const r of rows) taken.add(r.phone);
      }

      const staffSeen = new Set<bigint>(); // 同一专员在文件内出现两次也只会有一次成功；预检里提前标出
      for (const [rowNo, pr] of parsedRows) {
        if (!pr.ok) {
          results.set(rowNo, { code: pr.code, ...(pr.detail ? { detail: pr.detail } : {}) });
          continue;
        }
        if (dupRows.has(rowNo)) {
          results.set(rowNo, { code: "duplicate_phone_in_file", detail: `行 ${dupRows.get(rowNo)!.join("、")}` });
          continue;
        }
        try {
          const v = await admin.prepareInvite(db, p, pr.input);
          if (taken.has(v.phone)) {
            results.set(rowNo, { code: "phone_exists" });
            continue;
          }
          if (v.mediaStaffId !== null) {
            if (staffSeen.has(v.mediaStaffId)) {
              results.set(rowNo, { code: "staff_already_bound", detail: "同一专员在文件内出现多次" });
              continue;
            }
            const bound = await db
              .select({ id: accessUsers.userId })
              .from(accessUsers)
              .where(and(eq(accessUsers.mediaStaffId, v.mediaStaffId), ne(accessUsers.status, "disabled")))
              .limit(1);
            if (bound.length > 0) {
              results.set(rowNo, { code: "staff_already_bound" });
              continue;
            }
            staffSeen.add(v.mediaStaffId);
          }
          results.set(rowNo, null);
        } catch (e) {
          if (!(e instanceof AccessError)) throw e;
          results.set(rowNo, { code: e.code });
        }
      }

      // 落库：批次 + 行，一个事务
      const now = clock.now();
      let newRows = 0;
      let skipped = 0;
      let errors = 0;
      const byReason: Record<string, number> = {};
      for (const r of results.values()) {
        if (r === null) newRows++;
        else {
          byReason[r.code] = (byReason[r.code] ?? 0) + 1;
          if (SKIP_CODES.has(r.code)) skipped++;
          else errors++;
        }
      }
      const batchId = await db.transaction(async (tx) => {
        const [ins] = await tx.insert(importBatches).values({
          importKind: "user_import",
          uploadedByActor: ctx.actor,
          uploadedByUserId: ctx.userId,
          uploadedAt: now,
          fileName: file.name.slice(0, 512),
          fileSha256: parsed.sha256,
          templateVersion: TEMPLATE_VERSION,
          brandScope: p.brands === "all" ? "all" : [...p.brands].map(String),
          totalRows: parsed.rows.length,
          newRows,
          skippedRows: skipped,
          errorRows: errors,
          summary: { encoding: parsed.encoding, byReason },
          status: "awaiting_confirm",
          createdAt: now,
          updatedAt: now,
        });
        const id = BigInt(ins.insertId);
        for (let i = 0; i < parsed.rows.length; i += 500) {
          await tx.insert(importRowResults).values(
            parsed.rows.slice(i, i + 500).map((r) => {
              const res = results.get(r.rowNo)!;
              return {
                importBatchId: id,
                rowNo: r.rowNo,
                rawRow: rawOf(r.cells),
                precheckClass: res === null ? "new" : "error",
                reasonCode: res?.code ?? null,
                reasonDetail: res?.detail ?? null,
                createdAt: now,
              };
            }),
          );
        }
        return id;
      });
      return view(batchId);
    },

    /** 本人提交过的批次（新的在前）。 */
    async list(ctx: AuthContext, page: { offset?: number; limit?: number } = {}): Promise<Array<Omit<BatchView, "rows">>> {
      await admin.requireManager(ctx);
      if (ctx.userId === null) return [];
      const rows = await db
        .select()
        .from(importBatches)
        .where(and(eq(importBatches.importKind, "user_import"), eq(importBatches.uploadedByUserId, ctx.userId)))
        .orderBy(desc(importBatches.importBatchId))
        .limit(Math.min(page.limit ?? 50, 200))
        .offset(page.offset ?? 0);
      return rows.map((b) => ({
        batchId: b.importBatchId.toString(),
        status: b.status,
        fileName: b.fileName,
        totalRows: b.totalRows,
        newRows: b.newRows,
        skippedRows: b.skippedRows,
        errorRows: b.errorRows,
        conflictRows: b.conflictRows,
        summary: b.summary,
      }));
    },

    /** 提交人才能看到批次详情。 */
    async get(ctx: AuthContext, batchId: bigint): Promise<BatchView> {
      await admin.requireManager(ctx);
      await loadOwn(ctx, batchId);
      return view(batchId);
    },

    /**
     * 确认写入（同步）：只处理预检为 new 的行，且每行**重新校验**后才创建；每行一个事务（用户创建 + 该行结果同提交）。
     * 租约 + fencing：每个行事务开头核对 writing_token；心跳陈旧才允许接手续跑，续跑只处理 outcome 为空的行。
     */
    async confirm(ctx: AuthContext, batchId: bigint): Promise<BatchView & { alreadyCompleted: boolean }> {
      const p = await admin.requireManager(ctx);
      const batch = await loadOwn(ctx, batchId);
      if (batch.status === "completed") return { ...(await view(batchId)), alreadyCompleted: true };
      if (batch.status !== "awaiting_confirm" && batch.status !== "writing") throw new AccessError("conflict", "batch_not_confirmable", "这个批次不能确认");
      const now0 = clock.now();
      const token = newToken();
      // 认领（一条语句，原子）：awaiting_confirm 直接认领；writing 只有心跳陈旧（上一个确认进程已死）才接手
      const stale = new Date(now0.getTime() - STALE_LEASE_MS);
      const [claim] = await db
        .update(importBatches)
        .set({ status: "writing", writingToken: token, heartbeatAt: now0, confirmedByActor: ctx.actor, confirmedByUserId: ctx.userId, confirmedAt: batch.confirmedAt ?? now0, updatedAt: now0 })
        .where(
          and(
            eq(importBatches.importBatchId, batchId),
            or(eq(importBatches.status, "awaiting_confirm"), and(eq(importBatches.status, "writing"), lt(importBatches.heartbeatAt, stale))),
          ),
        );
      if (claim.affectedRows !== 1) {
        const [now] = await db.select({ status: importBatches.status }).from(importBatches).where(eq(importBatches.importBatchId, batchId));
        if (now?.status === "completed") return { ...(await view(batchId)), alreadyCompleted: true }; // 并发的另一次确认刚完成
        if (now?.status === "writing") throw new AccessError("conflict", "batch_busy", "批次正在被另一次确认处理");
        throw new AccessError("conflict", "batch_not_confirmable", "这个批次不能确认");
      }
      const cur = batch;

      const rows = await db
        .select()
        .from(importRowResults)
        .where(and(eq(importRowResults.importBatchId, batchId), eq(importRowResults.precheckClass, "new"), isNull(importRowResults.outcome)))
        .orderBy(asc(importRowResults.rowNo));
      const refs = await loadRefs(db);
      let imported = 0;
      let conflicts = 0;
      let invalid = 0;
      const fail = async (rowId: bigint, outcome: "conflict" | "invalid", code: string, detail?: string) => {
        await db
          .update(importRowResults)
          .set({ outcome, reasonCode: code, reasonDetail: detail ?? null, resolvedAt: clock.now(), resolvedByActor: ctx.actor, resolvedByUserId: ctx.userId })
          .where(eq(importRowResults.importRowResultId, rowId));
      };
      for (const row of rows) {
        const pr = parseRow(cellsOfRaw(row.rawRow), refs);
        if (!pr.ok) {
          await fail(row.importRowResultId, "invalid", pr.code, pr.detail);
          invalid++;
          continue;
        }
        try {
          await db.transaction(async (tx) => {
            const [b] = await tx.select({ token: importBatches.writingToken }).from(importBatches).where(eq(importBatches.importBatchId, batchId)).for("update");
            if (b?.token !== token) throw new AccessError("conflict", "lease_lost", "确认租约已被其他进程接手");
            await tx.update(importBatches).set({ heartbeatAt: clock.now() }).where(eq(importBatches.importBatchId, batchId));
            await admin.inviteIn(tx, ctx, p, { ...pr.input, source: { importBatchId: batchId.toString(), rowNo: row.rowNo }, batchRef: batchId });
            await tx
              .update(importRowResults)
              .set({ outcome: "imported", resolvedAt: clock.now(), resolvedByActor: ctx.actor, resolvedByUserId: ctx.userId })
              .where(eq(importRowResults.importRowResultId, row.importRowResultId));
          });
          imported++;
        } catch (e) {
          if (!(e instanceof AccessError)) throw e; // 非业务错误：批次留在 writing，租约陈旧后可续跑
          if (e.code === "lease_lost") throw e;
          if (e.code === "phone_exists" || e.code === "staff_already_bound") {
            await fail(row.importRowResultId, "conflict", "conflict_at_confirm", e.code);
            conflicts++;
          } else {
            await fail(row.importRowResultId, "invalid", e.code);
            invalid++;
          }
        }
      }
      const done = clock.now();
      const all = await db.select({ outcome: importRowResults.outcome }).from(importRowResults).where(eq(importRowResults.importBatchId, batchId));
      const count = (o: string) => all.filter((r) => r.outcome === o).length;
      await db.transaction(async (tx) => {
        const [b] = await tx.select({ token: importBatches.writingToken }).from(importBatches).where(eq(importBatches.importBatchId, batchId)).for("update");
        if (b?.token !== token) throw new AccessError("conflict", "lease_lost", "确认租约已被其他进程接手");
        const summary = { ...((cur.summary as Record<string, unknown> | null) ?? {}), imported: count("imported"), conflict: count("conflict"), invalid: count("invalid") };
        await tx
          .update(importBatches)
          .set({ status: "completed", conflictRows: count("conflict"), summary, heartbeatAt: null, updatedAt: done })
          .where(eq(importBatches.importBatchId, batchId));
        await deps.audit.write(
          {
            actor: ctx.actor,
            actorUserId: ctx.userId,
            eventType: "user_import_confirmed",
            outcome: "succeeded",
            reasonCode: "user_import_confirmed",
            targetType: "import_batch",
            targetId: batchId.toString(),
            batchRef: batchId,
            detail: { imported: count("imported"), conflict: count("conflict"), invalid: count("invalid"), thisRun: { imported, conflicts, invalid } },
          },
          { tx, risk: "high" },
        );
      });
      return { ...(await view(batchId)), alreadyCompleted: false };
    },

    /** 回流文件：原 6 列 + 结果 / 原因 / 指引；只含没成功的行；提交人本人下载；手机号明文；记审计。 */
    async returnFile(ctx: AuthContext, batchId: bigint): Promise<{ fileName: string; csv: string; rows: number }> {
      await admin.requireManager(ctx);
      const b = await loadOwn(ctx, batchId);
      const rows = await db.select().from(importRowResults).where(eq(importRowResults.importBatchId, batchId)).orderBy(asc(importRowResults.rowNo));
      const failed = rows.filter((r) => r.precheckClass === "error" || r.outcome === "conflict" || r.outcome === "invalid");
      const OUTCOME_TEXT: Record<string, string> = { conflict: "冲突，未创建", invalid: "未创建" };
      const out = failed.map((r) => [
        ...cellsOfRaw(r.rawRow),
        r.outcome ? (OUTCOME_TEXT[r.outcome] ?? r.outcome) : "未导入",
        r.reasonCode ? `${r.reasonCode}${r.reasonDetail ? `：${r.reasonDetail}` : ""}` : "",
        guidanceOf(r.reasonCode),
      ]);
      // 审计写入失败 → 不给文件（高风险动作失败即拒绝）
      await db.transaction((tx) =>
        deps.audit.write(
          {
            actor: ctx.actor,
            actorUserId: ctx.userId,
            eventType: "user_import_returnfile_downloaded",
            outcome: "succeeded",
            reasonCode: "user_import_returnfile_downloaded",
            targetType: "import_batch",
            targetId: batchId.toString(),
            batchRef: batchId,
            detail: { rows: out.length },
          },
          { tx, risk: "high" },
        ),
      );
      const base = (b.fileName ?? `batch-${batchId}`).replace(/\.csv$/i, "");
      return { fileName: `${base}-回流.csv`, csv: buildCsv(RETURN_COLUMNS, out), rows: out.length };
    },
  };
}

export type UserImport = ReturnType<typeof createUserImport>;
