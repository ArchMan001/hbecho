// 同步调度测试的小工厂：外部监控账号、直接设置任务终态。
import { eq } from "drizzle-orm";
import type { Db } from "../../src/db/client";
import { staffAccountAssignments, syncTasks } from "../../src/db/schema";
import { insertAccount, insertAssignment, sha } from "./factories";
import { platformIdOf } from "./seed";

export async function addStaffAccount(db: Db, a: { platform: string; staffId: bigint; now: Date }): Promise<{ accountId: bigint; assignmentId: bigint }> {
  const accountId = await insertAccount(db, a.platform, a.now);
  const assignmentId = await insertAssignment(db, { accountId, platform: a.platform, staffId: a.staffId, now: a.now });
  return { accountId, assignmentId };
}

export async function addExternalAccount(db: Db, a: { platform: string; now: Date; enabled?: boolean }): Promise<{ accountId: bigint; assignmentId: bigint }> {
  const accountId = await insertAccount(db, a.platform, a.now);
  const locator = `https://example.test/external/${accountId}`;
  const enabled = a.enabled ?? true;
  const [r] = await db.insert(staffAccountAssignments).values({
    watchType: "external",
    staffId: null,
    accountId,
    platformId: await platformIdOf(db, a.platform),
    monitoringEnabled: enabled,
    ...(enabled ? {} : { monitoringClosedReason: "manual" }),
    currentHomeLocator: locator,
    currentHomeLocatorSha256: sha(locator),
    resolvedHomeUrl: locator,
    resolvedHomeUrlSha256: sha(locator),
    intakeStatus: "normal",
    createdAt: a.now,
    updatedAt: a.now,
  });
  return { accountId, assignmentId: BigInt(r.insertId) };
}

/** 直接把某批次的任务置为指定终态（调度测试不需要真的采集）。返回改动的任务数。 */
export async function settleTasks(
  db: Db,
  batchId: bigint,
  to: { status: "succeeded" | "failed" | "cancelled"; lastErrorCode?: string; where?: (t: typeof syncTasks.$inferSelect) => boolean },
  now: Date,
): Promise<number> {
  const rows = await db.select().from(syncTasks).where(eq(syncTasks.batchId, batchId));
  let n = 0;
  for (const t of rows) {
    if (to.where && !to.where(t)) continue;
    await db
      .update(syncTasks)
      .set({ status: to.status, lastErrorCode: to.lastErrorCode ?? null, finishedAt: now, updatedAt: now })
      .where(eq(syncTasks.taskId, t.taskId));
    n++;
  }
  return n;
}
