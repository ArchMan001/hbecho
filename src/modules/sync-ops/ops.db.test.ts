// 运营处置命令（acceptance N、M7、L5；FS-12.5、FS-13.7、FS-14）。全程离线、不发任何供应商调用。
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { adminActor, opsActor, serviceActor } from "../../../tests/harness/actors";
import { useTestDb } from "../../../tests/harness/db";
import { SLOT, setupSync } from "../../../tests/harness/sync-env";
import { addExternalAccount, settleTasks } from "../../../tests/harness/sync-fixtures";
import { branches, dataQualityIssues, dealers, externalAccounts, mediaStaff, sectors, staffAccountAssignments as aa, stores, syncBatches, syncTasks } from "../../db/schema";
import { insertAccount, insertAssignment } from "../../../tests/harness/factories";
import { createMonitoringSwitch } from "../monitoring/set-switch";
import { memorySyncAuditSink } from "../sync-schedule";
import { createSyncOps } from "./ops";

const t = useTestDb();
async function world() {
  const env = await setupSync(t);
  const audit = memorySyncAuditSink();
  const ops = createSyncOps({ db: t.db, clock: env.clock, audit });
  const sw = createMonitoringSwitch({ db: t.db, clock: env.clock, audit });
  return { env, audit, ops, sw };
}
const assignment = async (accountId: bigint) => (await t.db.select().from(aa).where(eq(aa.accountId, accountId)))[0]!;
const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as { code?: string }).code ?? `other:${String(e)}`;
  }
  return null;
};

describe("account rebind（FS-14.1）", () => {
  it("改绑到名额空闲的专员：写审计（原 → 新），不改 discovery 的 owner 快照；新专员名额已占 → slot_taken；原账号不动", async () => {
    const { env, audit, ops } = await world();
    const a = await env.addAccount("douyin", env.org.staffA);
    const b = await env.addAccount("douyin", env.org.staffB, { identifier: "other-uid" });
    // 新专员 B 的抖音名额已被 b 占用
    expect(await code(ops.rebind({ accountId: a.accountId.toString(), staffId: env.org.staffB.toString() }, opsActor()))).toBe("slot_taken");
    expect((await assignment(a.accountId)).staffId).toBe(env.org.staffA);
    // 改绑到 C：成功
    const r = await ops.rebind({ accountId: a.accountId.toString(), staffId: env.org.staffC.toString() }, opsActor());
    expect(r).toMatchObject({ kind: "rebound", fromStaffId: env.org.staffA.toString(), toStaffId: env.org.staffC.toString() });
    expect((await assignment(a.accountId)).staffId).toBe(env.org.staffC);
    expect(audit.events.filter((e) => e.action === "account_rebind").map((e) => e.outcome)).toEqual(["rejected", "applied"]);
    expect(audit.events.at(-1)?.detail).toMatchObject({ from_staff_id: env.org.staffA.toString(), to_staff_id: env.org.staffC.toString() });
    // 同一专员 = noop；停用专员 / 不存在的专员被拒
    expect((await ops.rebind({ accountId: a.accountId.toString(), staffId: env.org.staffC.toString() }, opsActor())).kind).toBe("noop");
    expect(await code(ops.rebind({ accountId: a.accountId.toString(), staffId: env.org.staffInactive.toString() }, opsActor()))).toBe("invalid_input");
    expect(await code(ops.rebind({ accountId: a.accountId.toString(), staffId: "999999" }, opsActor()))).toBe("not_found");
    void b;
  });
  it("授权：缺 Capability、超出范围、外部账号都在写之前被拒", async () => {
    const { env, ops } = await world();
    const a = await env.addAccount("douyin", env.org.staffA);
    const ext = await addExternalAccount(t.db, { platform: "douyin", now: env.clock.now() });
    const input = { accountId: a.accountId.toString(), staffId: env.org.staffC.toString() };
    expect(await code(ops.rebind(input, serviceActor()))).toBe("forbidden");
    expect(await code(ops.rebind(input, opsActor({ scope: { platformCodes: "all", mediaStaffIds: new Set([env.org.staffA]) } })))).toBe("out_of_scope"); // 目标专员不在范围
    expect(await code(ops.rebind(input, opsActor({ scope: { platformCodes: new Set(["xiaohongshu"]), mediaStaffIds: "all" } })))).toBe("out_of_scope");
    expect(await code(ops.rebind({ accountId: ext.accountId.toString(), staffId: env.org.staffC.toString() }, opsActor()))).toBe("invalid_input");
    expect(await code(ops.rebind({ accountId: "x", staffId: "1" }, opsActor()))).toBe("invalid_input");
    expect((await assignment(a.accountId)).staffId).toBe(env.org.staffA);
  });
});

describe("account confirm-deleted（FS-14.2）", () => {
  it("账号置 deleted、写 slot_released_at、归属保留；该专员可再录同平台账号；之后不在目标集", async () => {
    const { env, ops } = await world();
    const a = await env.addAccount("douyin", env.org.staffA);
    expect((await env.resolver.targets({ afterAccountId: null, limit: 10 })).rows).toHaveLength(1);
    const r = await ops.confirmDeleted({ accountId: a.accountId.toString() }, opsActor());
    expect(r.kind).toBe("deleted");
    const [acct] = await t.db.select().from(externalAccounts).where(eq(externalAccounts.accountId, a.accountId));
    expect(acct).toMatchObject({ status: "deleted", statusReason: "confirmed_deleted" });
    const asg = await assignment(a.accountId);
    expect(asg.slotReleasedAt).not.toBeNull();
    expect(asg.staffId).toBe(env.org.staffA); // 归属保留
    expect((await env.resolver.targets({ afterAccountId: null, limit: 10 })).rows).toHaveLength(0);
    // 名额释放：同一专员同平台再录一个账号不再违反唯一索引
    const acc2 = await insertAccount(t.db, "douyin", env.clock.now());
    await insertAssignment(t.db, { accountId: acc2, platform: "douyin", staffId: env.org.staffA, now: env.clock.now() });
    expect((await ops.confirmDeleted({ accountId: a.accountId.toString() }, opsActor())).kind).toBe("noop");
    expect(await code(ops.confirmDeleted({ accountId: a.accountId.toString() }, serviceActor()))).toBe("forbidden");
  });
});

describe("issue set-status（FS-14.3）", () => {
  it("三种目标状态；记 resolved_by_actor；不删除业务数据；人工 ignored 不被覆盖为 open", async () => {
    const { env, ops } = await world();
    const a = await env.addAccount("douyin", env.org.staffA);
    const now = env.clock.now();
    const [ins] = await t.db.insert(dataQualityIssues).values({ issueFingerprint: Buffer.alloc(32, 1), issueCode: "list_author_mismatch", severity: "warning", status: "open", accountId: a.accountId, detail: {}, firstSeenAt: now, lastSeenAt: now, createdAt: now, updatedAt: now });
    const id = ins.insertId.toString();
    for (const status of ["acknowledged", "ignored", "resolved"] as const) {
      const r = await ops.setIssueStatus({ issueId: id, status, note: "n" }, opsActor({ actorId: "service:ops-1" }));
      expect(r.to).toBe(status);
      const [row] = await t.db.select().from(dataQualityIssues).where(eq(dataQualityIssues.issueId, BigInt(id)));
      expect(row).toMatchObject({ status, resolvedByActor: "service:ops-1", resolutionNote: "n" });
      expect(row!.resolvedAt === null).toBe(status === "acknowledged");
    }
    expect((await ops.listIssues({ status: "resolved" })).map((i) => i.issueId)).toEqual([id]);
    expect(await ops.listIssues({ status: "open" })).toEqual([]);
    expect(await code(ops.setIssueStatus({ issueId: "424242", status: "resolved" }, opsActor()))).toBe("not_found");
    expect(await code(ops.setIssueStatus({ issueId: id, status: "open" }, opsActor()))).toBe("invalid_input");
    expect(await code(ops.setIssueStatus({ issueId: id, status: "resolved" }, serviceActor()))).toBe("forbidden");
    expect((await t.db.select().from(externalAccounts)).length).toBe(1); // 业务数据还在
  });
});

describe("监控开关（FS-14.4、FS-14.6）", () => {
  const levels = async (env: Awaited<ReturnType<typeof world>>["env"]) => {
    const [store] = await t.db.select().from(stores).where(eq(stores.storeId, env.org.storeId));
    const [sector] = await t.db.select().from(sectors).where(eq(sectors.sectorId, store!.sectorId));
    return { branch: sector!.branchId, dealer: store!.dealerId, store: store!.storeId, staff: env.org.staffA };
  };
  it("五级各一个用例：组织级默认预览（零写入，受影响数 + 示例），--apply 才写；不改写下级的值；账号级直接写并带 manual", async () => {
    const { env, sw } = await world();
    const a = await env.addAccount("douyin", env.org.staffA);
    const L = await levels(env);
    const admin = adminActor();
    const rowOf = {
      branch: async () => (await t.db.select().from(branches).where(eq(branches.branchId, L.branch)))[0]!,
      dealer: async () => (await t.db.select().from(dealers).where(eq(dealers.dealerId, L.dealer)))[0]!,
      store: async () => (await t.db.select().from(stores).where(eq(stores.storeId, L.store)))[0]!,
      staff: async () => (await t.db.select().from(mediaStaff).where(eq(mediaStaff.staffId, L.staff)))[0]!,
    };
    for (const level of ["branch", "dealer", "store", "staff"] as const) {
      const before = await rowOf[level]();
      const pv = await sw.set({ level, id: L[level].toString(), enabled: false }, admin);
      expect(pv).toMatchObject({ kind: "preview", currentEnabled: true, affectedAccounts: 1, examples: [a.accountId.toString()] });
      expect(await rowOf[level]()).toEqual(before); // 预览零写入（含 updated_at）
      env.clock.advance(1000);
      const ap = await sw.set({ level, id: L[level].toString(), enabled: false, apply: true }, admin);
      expect(ap).toMatchObject({ kind: "applied", previousEnabled: true, affectedAccounts: 1 });
      expect((await rowOf[level]()).monitoringEnabled).toBe(false);
      expect((await env.resolver.explain(a.accountId)).effective).toBe(false);
      await sw.set({ level, id: L[level].toString(), enabled: true, apply: true }, admin); // 还原
    }
    // 上级关闭不改写下级的值：关分公司后，门店 / 专员 / 账号开关仍是 true
    await sw.set({ level: "branch", id: L.branch.toString(), enabled: false, apply: true }, admin);
    expect([(await rowOf.store()).monitoringEnabled, (await rowOf.staff()).monitoringEnabled, (await assignment(a.accountId)).monitoringEnabled]).toEqual([true, true, true]);
    expect((await env.resolver.explain(a.accountId)).reason).toBe("branch_off");
    await sw.set({ level: "branch", id: L.branch.toString(), enabled: true, apply: true }, admin);
    // 账号级：直接写，关闭写 manual，开启清空原因
    expect(await sw.set({ level: "account", id: a.accountId.toString(), enabled: false }, opsActor())).toMatchObject({ kind: "applied", previousEnabled: true });
    expect(await assignment(a.accountId)).toMatchObject({ monitoringEnabled: false, monitoringClosedReason: "manual" });
    await sw.set({ level: "account", id: a.accountId.toString(), enabled: true }, opsActor());
    expect(await assignment(a.accountId)).toMatchObject({ monitoringEnabled: true, monitoringClosedReason: null });
    expect((await sw.set({ level: "account", id: a.accountId.toString(), enabled: true }, opsActor())).kind).toBe("noop");
  });
  it("授权：经销商级仅超管；组织级需要全范围；缺 Capability 被拒；账号级按范围；分公司 / 不存在的节点", async () => {
    const { env, sw } = await world();
    const a = await env.addAccount("douyin", env.org.staffA);
    const L = await levels(env);
    expect(await code(sw.set({ level: "dealer", id: L.dealer.toString(), enabled: false, apply: true }, opsActor()))).toBe("forbidden");
    expect(await code(sw.set({ level: "store", id: L.store.toString(), enabled: false, apply: true }, serviceActor()))).toBe("forbidden");
    expect(await code(sw.set({ level: "store", id: L.store.toString(), enabled: false }, opsActor({ scope: { platformCodes: "all", mediaStaffIds: new Set([env.org.staffA]) } })))).toBe("out_of_scope");
    expect(await code(sw.set({ level: "account", id: a.accountId.toString(), enabled: false }, opsActor({ scope: { platformCodes: "all", mediaStaffIds: new Set([env.org.staffB]) } })))).toBe("out_of_scope");
    expect(await code(sw.set({ level: "branch", id: "999999", enabled: false }, opsActor()))).toBe("not_found");
    expect(await code(sw.set({ level: "country", id: "1", enabled: false }, opsActor()))).toBe("invalid_input");
    expect((await t.db.select().from(dealers).where(eq(dealers.dealerId, L.dealer)))[0]!.monitoringEnabled).toBe(true);
  });
});

describe("外部账号启停与可见性（FS-13.5–13.7）", () => {
  it("只改自身开关，关闭写 manual；对非超管不可见 / 不可操作；仍在目标集内且只生成 fetch_profile", async () => {
    const { env, ops } = await world();
    const ext = await addExternalAccount(t.db, { platform: "douyin", now: env.clock.now() });
    const id = ext.accountId.toString();
    expect((await env.resolver.targets({ afterAccountId: null, limit: 10 })).rows).toHaveLength(1);
    expect(await ops.externalDisable({ accountId: id }, adminActor())).toMatchObject({ kind: "applied", enabled: false });
    expect(await assignment(ext.accountId)).toMatchObject({ monitoringEnabled: false, monitoringClosedReason: "manual" });
    expect((await env.resolver.targets({ afterAccountId: null, limit: 10 })).rows).toHaveLength(0);
    expect((await ops.externalDisable({ accountId: id }, adminActor())).kind).toBe("noop");
    await ops.externalEnable({ accountId: id }, adminActor());
    expect(await assignment(ext.accountId)).toMatchObject({ monitoringEnabled: true, monitoringClosedReason: null });
    expect((await ops.externalList(adminActor())).map((r) => r.accountId)).toEqual([id]);
    for (const who of [opsActor(), serviceActor()]) {
      expect(await code(ops.externalList(who))).toBe("forbidden");
      expect(await code(ops.externalDisable({ accountId: id }, who))).toBe("forbidden");
    }
    // 自有账号不是外部账号
    const own = await env.addAccount("douyin", env.org.staffA);
    expect(await code(ops.externalDisable({ accountId: own.accountId.toString() }, adminActor()))).toBe("not_found");
    // 规划：外部账号只有 fetch_profile
    await env.scheduler.tick(SLOT);
    const tasks = (await env.tasks()).filter((x) => x.accountId === ext.accountId);
    expect(tasks.map((x) => x.requestedAction)).toEqual(["fetch_profile"]);
  });
});

describe("batch retry-failed（FS-12.5）", () => {
  async function failedBatch() {
    const w = await world();
    const a = await w.env.addAccount("douyin", w.env.org.staffA);
    const b = await w.env.addAccount("xiaohongshu", w.env.org.staffB);
    await w.env.scheduler.tick(SLOT);
    const [batch] = await t.db.select().from(syncBatches).where(eq(syncBatches.purpose, "full"));
    await settleTasks(t.db, batch!.batchId, { status: "succeeded", where: (x) => x.accountId === a.accountId }, w.env.clock.now());
    await settleTasks(t.db, batch!.batchId, { status: "failed", lastErrorCode: "provider_server_error", where: (x) => x.accountId === b.accountId && x.requestedAction === "fetch_profile" }, w.env.clock.now());
    await settleTasks(t.db, batch!.batchId, { status: "failed", lastErrorCode: "provider_server_error", where: (x) => x.accountId === b.accountId && x.requestedAction === "fetch_content_list" }, w.env.clock.now());
    // 一个 failed、一个 dead
    await t.db.update(syncTasks).set({ status: "dead" }).where(and(eq(syncTasks.accountId, b.accountId), eq(syncTasks.requestedAction, "fetch_content_list")));
    await w.env.scheduler.tick(w.env.clock.now()); // 汇总 → 批次终态
    return { ...w, batchId: batch!.batchId.toString(), a, b };
  }
  it("默认预览（零写入，受影响数 + 示例）；--apply 只放回 failed / dead，重置额度，成功任务不动，终态批次回到 running", async () => {
    const { env, ops, batchId, a } = await failedBatch();
    const rowsBefore = await env.tasks();
    expect((await t.db.select().from(syncBatches).where(eq(syncBatches.batchId, BigInt(batchId))))[0]!.status).toBe("partial_succeeded");
    const pv = await ops.retryFailed({ batchId }, opsActor());
    expect(pv).toMatchObject({ kind: "preview", affectedTasks: 2 });
    expect(await env.tasks()).toEqual(rowsBefore);
    const r = await ops.retryFailed({ batchId, apply: true }, opsActor());
    expect(r).toMatchObject({ kind: "requeued", requeuedTasks: 2 });
    const rows = await env.tasks();
    const retried = rows.filter((x) => x.accountId !== a.accountId && x.requestedAction !== "download_media");
    expect(retried.every((x) => x.status === "pending" && x.attemptCount === 0 && x.lastErrorCode === null && x.finishedAt === null)).toBe(true);
    expect(retried.every((x) => x.fencingToken === rowsBefore.find((o) => o.taskId === x.taskId)!.fencingToken + 1n)).toBe(true); // 旧 worker 的写入失效
    expect(rows.filter((x) => x.accountId === a.accountId && x.requestedAction !== "download_media").every((x) => x.status === "succeeded")).toBe(true); // 成功的不重做
    expect((await t.db.select().from(syncBatches).where(eq(syncBatches.batchId, BigInt(batchId))))[0]).toMatchObject({ status: "running", finishedAt: null });
    expect((await ops.retryFailed({ batchId, apply: true }, opsActor())).kind).toBe("noop"); // 没有失败的任务了
  });
  it("拒绝：下一个 full 批次已开始 / 非 full 批次 / 已取消 / 不存在 / 缺 Capability / 受限身份", async () => {
    const { env, ops, batchId } = await failedBatch();
    expect(await code(ops.retryFailed({ batchId }, serviceActor({ capabilities: new Set() })))).toBe("forbidden");
    expect(await code(ops.retryFailed({ batchId }, opsActor({ scope: { platformCodes: new Set(["douyin"]), mediaStaffIds: "all" } })))).toBe("out_of_scope");
    expect(await code(ops.retryFailed({ batchId: "424242" }, opsActor()))).toBe("not_found");
    env.clock.advance(7 * 24 * 3600 * 1000);
    await env.scheduler.tick(env.clock.now());
    await env.scheduler.tick(env.clock.now()); // 下一个 full 批次开始
    expect(await code(ops.retryFailed({ batchId, apply: true }, opsActor()))).toBe("not_retryable");
    const [demandLike] = await t.db.insert(syncBatches).values({ batchKey: Buffer.alloc(32, 9), triggerType: "manual", purpose: "supplement", logicalAt: env.clock.now(), status: "running", settingsVersion: 1n, settingsSnapshot: {}, plannedTaskCount: 0, createdAt: env.clock.now(), updatedAt: env.clock.now() });
    expect(await code(ops.retryFailed({ batchId: demandLike.insertId.toString() }, opsActor()))).toBe("not_retryable");
    void syncTasks;
  });
});

describe("R8：审计事件内容", () => {
  it("含 actor、时间、对象、前后状态；不含 secret、原始载荷、临时 URL；拒绝也写审计", async () => {
    const { env, audit, ops, sw } = await world();
    const a = await env.addAccount("douyin", env.org.staffA);
    await ops.rebind({ accountId: a.accountId.toString(), staffId: env.org.staffC.toString() }, opsActor({ actorId: "service:ops-9" }));
    await sw.set({ level: "account", id: a.accountId.toString(), enabled: false }, opsActor({ actorId: "service:ops-9" }));
    await code(ops.rebind({ accountId: a.accountId.toString(), staffId: env.org.staffC.toString() }, serviceActor()));
    const events = audit.events;
    expect(events.length).toBeGreaterThanOrEqual(3);
    for (const e of events) {
      expect(e.actorId).toMatch(/^service:/);
      expect(Date.parse(e.at)).not.toBeNaN();
      expect(e.action).toBeTruthy();
      expect(e.outcome).toBeTruthy();
    }
    expect(events.find((e) => e.action === "account_rebind" && e.outcome === "applied")?.detail).toMatchObject({ account_id: a.accountId.toString(), from_staff_id: env.org.staffA.toString(), to_staff_id: env.org.staffC.toString() });
    expect(events.find((e) => e.action === "monitoring_set" && e.outcome === "applied")?.detail).toMatchObject({ enabled: false, previous_enabled: true });
    expect(events.some((e) => e.outcome === "rejected" && e.code === "forbidden")).toBe(true);
    expect(JSON.stringify(events)).not.toMatch(/https?:\/\/|secret|password|token|authorization/i);
  });
});
