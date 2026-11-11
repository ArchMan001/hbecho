// 专员自动新建（requirements AP-7；D-70）：确认写入时按「门店 + 姓名 + 手机号」新建 MediaStaff。
// 先 INSERT，唯一键（有效专员手机号唯一）冲突在保存点内回滚，该行记 conflict，不影响其他行；
// 不先 SELECT … FOR UPDATE 一个不存在的键（间隙锁）。不创建任何登录账号（登录账号激活是 B 域的事，D-46）。
import { sql } from "drizzle-orm";
import type { DbTx } from "../../../db/client";
import { mediaStaff } from "../../../db/schema";
import type { PlanAuditEvent } from "../audit";
import { isDuplicateKey } from "../errors";

const SAVEPOINT = sql.raw("ap_staff");

export async function createStaff(
  tx: DbTx,
  p: { storeId: bigint; name: string; phone: string; now: Date; actor: string; batchId: bigint },
): Promise<{ ok: true; staffId: bigint; event: PlanAuditEvent } | { ok: false; reason: "staff_phone_conflict" }> {
  await tx.execute(sql`SAVEPOINT ${SAVEPOINT}`);
  try {
    const [r] = await tx.insert(mediaStaff).values({ storeId: p.storeId, staffName: p.name, phone: p.phone, status: "active", createdAt: p.now, updatedAt: p.now });
    await tx.execute(sql`RELEASE SAVEPOINT ${SAVEPOINT}`);
    const staffId = BigInt(r.insertId);
    return {
      ok: true,
      staffId,
      event: {
        event_type: "staff_created",
        actor: p.actor,
        occurred_at: p.now.toISOString(),
        target_type: "media_staff",
        target_id: staffId.toString(),
        target_code: p.name,
        batch_id: p.batchId.toString(),
        // 手机号按 D-42 明文，不额外脱敏
        after: { store_id: p.storeId.toString(), staff_name: p.name, phone: p.phone },
      },
    };
  } catch (e) {
    await tx.execute(sql`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`);
    if (!isDuplicateKey(e)) throw e;
    return { ok: false, reason: "staff_phone_conflict" };
  }
}
