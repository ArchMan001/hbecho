// 结构操作（design §7.7）：structure 模式用到的经销商动作，以及门店改码。仅超管（data.master_data.structure，品牌范围 all）。
// 品牌 / 大区 / 分公司 / 板块只来自 bootstrap；单条结构命令族延后（design §3.2）。
import { and, eq, ne } from "drizzle-orm";
import type { Db, DbTx } from "../../db/client";
import { dealers, stores } from "../../db/schema";
import type { Clock } from "../raw-capture/ports";
import type { AuditEvent, AuditSink } from "./audit";
import { assertStructure, type ActorContext } from "./authorization";
import type { RowPlan } from "./classify";
import { isDuplicateKey, MasterDataError } from "./errors";

export type DealerResult = { ok: true; dealerId: bigint; events: AuditEvent[] } | { ok: false; reason: string };

/** 在行的保存点内执行：新建 / 启用 / 改名经销商。同一经销商被多行引用时，后一行复用前一行已建的记录。 */
export async function applyDealer(tx: DbTx, plan: RowPlan["dealer"], actor: string, batchId: bigint, now: Date): Promise<DealerResult> {
  const events: AuditEvent[] = [];
  const ev = (reason: string, id: bigint, before: Record<string, unknown>, after: Record<string, unknown>): void => {
    events.push({
      event_type: "structure_changed",
      actor,
      occurred_at: now.toISOString(),
      reason_code: reason,
      target_type: "dealer",
      target_id: String(id),
      batch_id: String(batchId),
      before,
      after,
    });
  };
  let id = plan.id;
  if (plan.create) {
    try {
      const [r] = await tx.insert(dealers).values({ dealerCode: plan.code, dealerName: plan.name, status: "active", createdAt: now, updatedAt: now });
      id = BigInt(r.insertId);
      ev("create_dealer", id, {}, { dealer_code: plan.code, dealer_name: plan.name });
      return { ok: true, dealerId: id, events };
    } catch (e) {
      if (!isDuplicateKey(e)) throw e;
      // 并发或前面的行已经建了：名称一致就复用，否则冲突
      const [ex] = await tx.select().from(dealers).where(eq(dealers.dealerCode, plan.code));
      if (!ex || ex.dealerName !== plan.name || ex.status !== "active") return { ok: false, reason: "dealer_name_conflict" };
      return { ok: true, dealerId: ex.dealerId, events };
    }
  }
  if (id === undefined) return { ok: false, reason: "dealer_missing" };
  if (plan.activate) {
    await tx.update(dealers).set({ status: "active", updatedAt: now }).where(eq(dealers.dealerId, id));
    ev("activate_dealer", id, { status: "inactive" }, { status: "active" });
  }
  if (plan.rename) {
    const [b] = await tx.select({ n: dealers.dealerName }).from(dealers).where(eq(dealers.dealerId, id));
    await tx.update(dealers).set({ dealerName: plan.name, updatedAt: now }).where(eq(dealers.dealerId, id));
    ev("update_dealer_name", id, { dealer_name: b?.n ?? null }, { dealer_name: plan.name });
  }
  return { ok: true, dealerId: id, events };
}

export interface StructureDeps {
  db: Db;
  clock: Clock;
  audit: AuditSink;
}

export type ChangeCodeResult = { result: "changed" | "unchanged"; storeId: string; storeCode: string };

/** 门店改码（ADR-0008 第 4 条）：store_id 不变；新码与同品牌其他门店冲突 → 冲突。 */
export async function changeStoreCode(deps: StructureDeps, storeId: string, newCode: string, actor: ActorContext): Promise<ChangeCodeResult> {
  assertStructure(actor);
  const code = newCode.trim();
  if (code === "" || !/^\d+$/.test(storeId)) throw new MasterDataError("input", "invalid_input", "需要有效的 store_id 与非空的新门店编码");
  const id = BigInt(storeId);
  const now = deps.clock.now();
  const event = await deps.db.transaction(async (tx) => {
    const [s] = await tx.select().from(stores).where(eq(stores.storeId, id)).for("update");
    if (!s) throw new MasterDataError("not_found", "store_not_found", "门店不存在");
    if (s.storeCode === code) return undefined;
    const [dup] = await tx
      .select({ id: stores.storeId })
      .from(stores)
      .where(and(eq(stores.brandId, s.brandId), eq(stores.storeCode, code), ne(stores.storeId, id)));
    if (dup) throw new MasterDataError("conflict", "store_code_conflict", "同一品牌下已有门店使用该编码", { storeId: String(dup.id) });
    await tx.update(stores).set({ storeCode: code, updatedAt: now }).where(eq(stores.storeId, id));
    return {
      event_type: "structure_changed",
      actor: actor.actor,
      occurred_at: now.toISOString(),
      reason_code: "change_store_code",
      target_type: "store",
      target_id: storeId,
      before: { store_code: s.storeCode },
      after: { store_code: code },
    } satisfies AuditEvent;
  });
  if (!event) return { result: "unchanged", storeId, storeCode: code };
  deps.audit(event);
  return { result: "changed", storeId, storeCode: code };
}
