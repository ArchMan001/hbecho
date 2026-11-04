// 任务 2：本地、脱敏的状态查询（R15.1–R15.6；acceptance A7–A9）。
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { serviceActor } from "../../../tests/harness/actors";
import { MemoryAuditSink } from "../../../tests/harness/audit";
import { useTestDb } from "../../../tests/harness/db";
import { FakeClock } from "../../../tests/harness/fake-clock";
import { FixtureTransport } from "../../../tests/harness/fixture-transport";
import {
  insertAccount,
  insertAssignment,
  insertMediaAsset,
  insertOssObject,
  insertPreparedCall,
  insertProfileSnapshot,
  insertTask,
  sha,
} from "../../../tests/harness/factories";
import { seedOrg, seedSyncSettings, type OrgSeed } from "../../../tests/harness/seed";
import { createDb, type QueryLogger } from "../../db/client";
import {
  dataQualityIssues,
  externalAccounts,
  mediaReferences,
  odsPayloads,
  syncCheckpoints,
  syncTasks,
} from "../../db/schema";
import { providerIdOf } from "../../../tests/harness/seed";
import { TracerError, createTracerCommands, createTracerStatusQuery, type TracerStatus } from "./index";

const START = new Date("2026-11-04T08:00:00.000Z");
const YEAR_MS = 365 * 24 * 3600 * 1000;
const t = useTestDb();

async function setup() {
  const clock = new FakeClock(START);
  const org = await seedOrg(t.db, clock.now());
  await seedSyncSettings(t.db, clock.now());
  const commands = createTracerCommands({ db: t.db, clock, audit: new MemoryAuditSink() });
  const status = createTracerStatusQuery({ db: t.db, clock });
  const submit = async (o: OrgSeed = org, key = "k", staff = o.staffA) =>
    (await commands.submit({ platform: "douyin", mediaStaffId: staff.toString(), homeLocator: "https://v.douyin.com/abc/", idempotencyKey: key }, serviceActor())).rootTaskId;
  return { clock, org, commands, status, submit };
}

const found = (s: TracerStatus) => {
  if (s.kind !== "found") throw new Error(`期望 found，实际 ${s.kind}`);
  return s;
};
const setRoot = (id: string, set: Partial<typeof syncTasks.$inferInsert>) =>
  t.db.update(syncTasks).set(set).where(eq(syncTasks.taskId, BigInt(id)));

describe("A9 未知 / 过期 / 越权 / 非 root：不泄露信息（R15.5）", () => {
  it("未知、越权、非 root 都是 not_found（外部无法探测哪些 root 存在）；一年后是 expired", async () => {
    const { status, submit, org, clock } = await setup();
    const id = await submit();
    expect(await status.get("999999", serviceActor())).toEqual({ kind: "not_found" });
    const other = serviceActor({ scope: { platformCodes: "all", mediaStaffIds: new Set([org.staffB]) } });
    expect(await status.get(id, other)).toEqual({ kind: "not_found" });
    const wrongPlatform = serviceActor({ scope: { platformCodes: new Set(["xiaohongshu"]), mediaStaffIds: "all" } });
    expect(await status.get(id, wrongPlatform)).toEqual({ kind: "not_found" });

    const [root] = await t.db.select().from(syncTasks).where(eq(syncTasks.taskId, BigInt(id)));
    const child = await insertTask(t.db, { batchId: root!.batchId, platform: "douyin", now: START, action: "fetch_profile" });
    expect(await status.get(child.toString(), serviceActor())).toEqual({ kind: "not_found" });

    expect(found(await status.get(id, serviceActor())).rootTaskId).toBe(id);
    clock.advance(YEAR_MS - 1);
    expect((await status.get(id, serviceActor())).kind).toBe("found");
    clock.advance(1);
    expect(await status.get(id, serviceActor())).toEqual({ kind: "expired" });
    // 越权者即使在过期之后也只会看到 not_found，不会借此确认该 root 存在
    expect(await status.get(id, other)).toEqual({ kind: "not_found" });
  });

  it("缺 Capability → forbidden；id 不是十进制数字 → invalid_input", async () => {
    const { status, submit } = await setup();
    const id = await submit();
    await expect(status.get(id, serviceActor({ capabilities: new Set() }))).rejects.toMatchObject({ code: "forbidden" });
    await expect(status.get("abc", serviceActor())).rejects.toMatchObject({ code: "invalid_input" });
    await expect(status.get("1.5", serviceActor())).rejects.toBeInstanceOf(TracerError);
  });

  it("过期之后不从长期业务事实反推旧的运行状态：即使账号、快照都还在，也只返回 expired", async () => {
    const { status, submit, org, clock } = await setup();
    const id = await submit();
    const accountId = await insertAccount(t.db, "douyin", START);
    await insertAssignment(t.db, { accountId, platform: "douyin", staffId: org.staffA, now: START });
    await setRoot(id, { accountId, status: "succeeded" });
    clock.advance(YEAR_MS + 1);
    expect(await status.get(id, serviceActor())).toEqual({ kind: "expired" });
  });
});

describe("A8 状态可区分（R15.2、R15.3）", () => {
  it("pending / running / retry_wait / cancelled / failed / dead / 阻塞冲突 / 阻塞名额", async () => {
    const { status, submit } = await setup();
    const id = await submit();
    const st = async () => found(await status.get(id, serviceActor()));

    expect((await st()).state).toBe("accepted");

    await setRoot(id, { status: "running", leaseOwner: "w", leaseExpiresAt: new Date(START.getTime() + 1000) });
    expect(await st()).toMatchObject({ state: "in_progress", stage: "resolving_locator" });

    await setRoot(id, { status: "retry_wait", leaseOwner: null, leaseExpiresAt: null, attemptCount: 1, lastErrorCode: "provider_rate_limited", nextAttemptAt: new Date(START.getTime() + 60_000) });
    expect(await st()).toMatchObject({ state: "retry_wait", failure: { code: "provider_rate_limited", retryable: true } });

    await setRoot(id, { status: "failed", nextAttemptAt: null, lastErrorCode: "provider_validation_failed", lastErrorDetail: { category: "provider_input" }, finishedAt: START });
    expect(await st()).toMatchObject({ state: "failed", failure: { category: "provider_input", code: "provider_validation_failed", retryable: false } });

    await setRoot(id, { status: "failed", stopReason: "assignment_conflict" });
    expect((await st()).state).toBe("blocked_assignment_conflict");
    await setRoot(id, { status: "failed", stopReason: "staff_platform_slot_taken" });
    expect((await st()).state).toBe("blocked_staff_platform_slot_taken");

    await setRoot(id, { status: "dead", stopReason: null });
    expect((await st()).state).toBe("failed");
    await setRoot(id, { status: "cancelled", stopReason: "cancelled_by_actor" });
    expect((await st()).state).toBe("cancelled");
  });

  it("运行阶段取自活动子任务：fetch_profile → fetching_profile，fetch_content_list → fetching_first_page", async () => {
    const { status, submit } = await setup();
    const id = await submit();
    const [root] = await t.db.select().from(syncTasks).where(eq(syncTasks.taskId, BigInt(id)));
    await setRoot(id, { status: "running", leaseOwner: "w", leaseExpiresAt: new Date(START.getTime() + 1000) });
    const child = await insertTask(t.db, { batchId: root!.batchId, platform: "douyin", now: START, action: "fetch_profile", status: "pending" });
    await t.db.update(syncTasks).set({ parentTaskId: BigInt(id) }).where(eq(syncTasks.taskId, child));
    expect(found(await status.get(id, serviceActor()))).toMatchObject({ stage: "fetching_profile" });
    await t.db.update(syncTasks).set({ requestedAction: "fetch_content_list" }).where(eq(syncTasks.taskId, child));
    const s = found(await status.get(id, serviceActor()));
    expect(s.stage).toBe("fetching_first_page");
    expect(s.stages).toEqual([
      { name: "resolve_account", state: "running", attempts: 0 },
      { name: "fetch_content_list", state: "pending", attempts: 0 },
    ]);
  });

  it("结构化成功 + 媒资待完成 ≠ 完全成功 ≠ 带警告成功", async () => {
    const { status, submit, org } = await setup();
    const id = await submit();
    const [root] = await t.db.select().from(syncTasks).where(eq(syncTasks.taskId, BigInt(id)));
    const accountId = await insertAccount(t.db, "douyin", START);
    const assignmentId = await insertAssignment(t.db, { accountId, platform: "douyin", staffId: org.staffA, now: START });
    const snap = await insertProfileSnapshot(t.db, { batchId: root!.batchId, accountId, assignmentId, now: START });
    await setRoot(id, { accountId, assignmentId, status: "succeeded", finishedAt: START });

    const ref = (role: "avatar" | "background" | "avatar_normalized" | "background_normalized", over: Partial<typeof mediaReferences.$inferInsert>) =>
      t.db.insert(mediaReferences).values({ profileSnapshotId: snap, role, observedAt: START, archiveStatus: "pending", createdAt: START, updatedAt: START, ...over });
    const asset = await insertMediaAsset(t.db, { key: "m/a", now: START });

    await ref("avatar", {});
    await ref("background", { archiveStatus: "archived", mediaAssetId: asset });
    let s = found(await status.get(id, serviceActor()));
    expect(s.state).toBe("structured_succeeded_media_pending");
    expect(s.media).toEqual({ total: 2, pending: 1, archived: 1, failed: 0, carriedForward: 0 });

    await t.db.update(mediaReferences).set({ archiveStatus: "archived", mediaAssetId: asset }).where(eq(mediaReferences.role, "avatar"));
    s = found(await status.get(id, serviceActor()));
    expect(s.state).toBe("succeeded");

    await ref("avatar_normalized", { archiveStatus: "failed", lastErrorCode: "download_failed" });
    await ref("background_normalized", { archiveStatus: "carried_forward", mediaAssetId: asset, lastErrorCode: "download_failed", isCarriedForward: true });
    s = found(await status.get(id, serviceActor()));
    expect(s.state).toBe("succeeded_with_warnings");
    expect(s.media).toEqual({ total: 4, pending: 0, archived: 2, failed: 1, carriedForward: 1 });

    await setRoot(id, { status: "succeeded_with_gap", continuityGapDetected: true, stopReason: "end_of_list_rebased" });
    expect(found(await status.get(id, serviceActor())).state).toBe("succeeded_with_warnings");
  });

  it("账号级与批次级结果：目标账号、录入结果、返回/投影条数、检查点、质量问题", async () => {
    const { status, submit, org } = await setup();
    const id = await submit();
    const [root] = await t.db.select().from(syncTasks).where(eq(syncTasks.taskId, BigInt(id)));
    const accountId = await insertAccount(t.db, "douyin", START);
    const assignmentId = await insertAssignment(t.db, { accountId, platform: "douyin", staffId: org.staffA, now: START });
    await insertProfileSnapshot(t.db, { batchId: root!.batchId, accountId, assignmentId, now: START });
    const list = await insertTask(t.db, { batchId: root!.batchId, platform: "douyin", now: START, action: "fetch_content_list", status: "succeeded" });
    await t.db.update(syncTasks).set({ parentTaskId: BigInt(id), fetchedItemCount: 20, pageCount: 1 }).where(eq(syncTasks.taskId, list));
    await t.db.insert(syncCheckpoints).values({
      accountId,
      providerId: await providerIdOf(t.db),
      anchorMode: "empty",
      cursorEnvelope: { kind: "integer", lexeme: "1782701295000" },
      cursorSha256: sha("c"),
      lastSuccessfulBatchId: root!.batchId,
      continuityStatus: "ready",
      updatedAt: START,
    });
    await t.db.insert(dataQualityIssues).values({
      issueFingerprint: sha("i1"),
      issueCode: "suspected_empty_account",
      severity: "warning",
      status: "open",
      batchId: root!.batchId,
      accountId,
      detail: { secret: "DETAIL-SHOULD-NOT-LEAK" },
      firstSeenAt: START,
      lastSeenAt: START,
      createdAt: START,
      updatedAt: START,
    });
    await setRoot(id, { accountId, assignmentId, status: "succeeded", resultSummary: { entry_outcome: "normal", warnings: [{ code: "cursor_empty_with_has_more", stage: "fetch_content_list" }] } });

    const s = found(await status.get(id, serviceActor()));
    expect(s.target).toEqual({ accountId: accountId.toString(), ownerMediaStaffId: org.staffA.toString(), submittedMediaStaffIsOwner: true });
    expect(s.entryOutcome).toBe("normal");
    expect(s.structured).toMatchObject({ profileFinalized: true, returnedEntries: 20, projectedEntries: 0, discoveries: 0, checkpointEstablished: true, cursorType: "integer" });
    expect(s.qualityIssues).toEqual([{ code: "suspected_empty_account", status: "open" }]);
    expect(s.warnings).toEqual([{ code: "cursor_empty_with_has_more", stage: "fetch_content_list" }]);
    expect(JSON.stringify(s)).not.toContain("DETAIL-SHOULD-NOT-LEAK");
  });

  it("归属冲突：提交的专员不会被显示为 owner；owner 的 ID 只对有权范围可见", async () => {
    const { status, submit, org } = await setup();
    const id = await submit(); // 提交者 staffA
    const [root] = await t.db.select().from(syncTasks).where(eq(syncTasks.taskId, BigInt(id)));
    const accountId = await insertAccount(t.db, "douyin", START);
    const assignmentId = await insertAssignment(t.db, { accountId, platform: "douyin", staffId: org.staffB, now: START }); // 现任 owner 是 staffB
    await setRoot(id, { accountId, assignmentId, status: "failed", stopReason: "assignment_conflict", finishedAt: START });
    void root;

    const all = found(await status.get(id, serviceActor()));
    expect(all.state).toBe("blocked_assignment_conflict");
    expect(all.target).toEqual({ accountId: accountId.toString(), ownerMediaStaffId: org.staffB.toString(), submittedMediaStaffIsOwner: false });

    const narrow = serviceActor({ scope: { platformCodes: "all", mediaStaffIds: new Set([org.staffA]) } });
    const limited = found(await status.get(id, narrow));
    expect(limited.target).toEqual({ accountId: accountId.toString(), submittedMediaStaffIsOwner: false });
    expect(JSON.stringify(limited)).not.toContain(org.staffB.toString());
  });
});

describe("脱敏（R15.4；acceptance A8）", () => {
  it("原始 body、认证头、完整 ODS key、临时 URL、供应商错误详情都不会出现在 status 中", async () => {
    const { status, submit, org } = await setup();
    const id = await submit();
    const [root] = await t.db.select().from(syncTasks).where(eq(syncTasks.taskId, BigInt(id)));
    const accountId = await insertAccount(t.db, "douyin", START);
    const assignmentId = await insertAssignment(t.db, { accountId, platform: "douyin", staffId: org.staffA, now: START, locator: "https://v.douyin.com/LOCATOR-MARKER/" });
    const snap = await insertProfileSnapshot(t.db, { batchId: root!.batchId, accountId, assignmentId, now: START });
    await t.db.insert(mediaReferences).values({
      profileSnapshotId: snap,
      role: "avatar",
      sourceLocator: "https://cdn.example/a.jpg?x-signature=TEMP-URL-MARKER",
      sourceLocatorSha256: sha("u"),
      observedAt: START,
      archiveStatus: "failed",
      lastErrorCode: "download_failed",
      createdAt: START,
      updatedAt: START,
    });
    const callId = await insertPreparedCall(t.db, BigInt(id), "douyin", START);
    const obj = await insertOssObject(t.db, { category: "ods", key: "ods/2026/11/ODS-KEY-MARKER", now: START });
    await t.db.insert(odsPayloads).values({ providerCallId: callId, payloadRole: "request_body", ossObjectId: obj, byteLength: 2n, sha256: sha("{}"), parseStatus: "not_attempted", capturedAt: START, expiresAt: START });
    await setRoot(id, {
      accountId,
      assignmentId,
      status: "failed",
      lastErrorCode: "provider_auth",
      lastErrorDetail: { category: "provider_auth", header: "X-Api-Key: HEADER-MARKER", body: "RAW-BODY-MARKER" },
      resultSummary: { raw_body: "RAW-BODY-MARKER", ods_key: "ods/2026/11/ODS-KEY-MARKER", entry_outcome: "normal", note: "NOTE-MARKER" },
    });
    await t.db.update(externalAccounts).set({ statusReason: "REASON-MARKER" }).where(eq(externalAccounts.accountId, accountId));

    const text = JSON.stringify(found(await status.get(id, serviceActor())));
    for (const marker of ["HEADER-MARKER", "RAW-BODY-MARKER", "ODS-KEY-MARKER", "TEMP-URL-MARKER", "x-signature", "LOCATOR-MARKER", "NOTE-MARKER", "REASON-MARKER", "X-Api-Key"]) {
      expect(text, marker).not.toContain(marker);
    }
    expect(text).toContain("provider_auth"); // 稳定原因码保留
  });
});

describe("A7 状态查询只读本地事实（R15.1）", () => {
  it("整个查询只执行 SELECT；没有可用的 ProviderTransport / 媒资源站，也没有任何网络尝试", async () => {
    const { submit } = await setup();
    const id = await submit();
    const executed: string[] = [];
    const logger: QueryLogger = { logQuery: (q) => void executed.push(q) };
    const spyDb = createDb(t.pool, { logger });
    const status = createTracerStatusQuery({ db: spyDb, clock: new FakeClock(START) });
    const transport = new FixtureTransport(); // 状态查询的依赖里根本没有 transport；这里证明它没被动过

    found(await status.get(id, serviceActor()));
    expect(executed.length).toBeGreaterThan(0);
    expect(executed.every((q) => /^\s*select\b/i.test(q))).toBe(true);
    expect(transport.calls).toHaveLength(0);
    expect(transport.rejected).toHaveLength(0);
    // setup.ts 的 afterEach 还会在出现任何被拒网络尝试时让本用例失败
  });
});
