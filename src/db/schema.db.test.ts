// 任务 2：drizzle-kit 生成的迁移在真实 MySQL 8.4 上是否真的强制 v2 需要的约束。
// 结论回填 ADR-0005「已知坑」第 7 行。需要 HBECHO_TEST_DATABASE_URL（scripts/with-test-mysql.sh）。
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  expectRejected,
  useTestDb,
} from "../../tests/harness/db";
import {
  insertAccount,
  insertAssignment,
  insertBatch,
  insertContent,
  insertContentSnapshot,
  insertOssObject,
  insertPreparedCall,
  insertProfileSnapshot,
  insertTask,
  sha,
} from "../../tests/harness/factories";
import { BIG_STAFF_ID, platformIdOf, providerIdOf, seedOrg } from "../../tests/harness/seed";
import {
  accountProfileSnapshots,
  contentDiscoveries,
  contentSnapshots,
  contents,
  externalAccountIdentifiers,
  externalAccounts,
  mediaAssets,
  mediaReferences,
  mediaStaff,
  odsPayloads,
  odsProviderCalls,
  ossObjects,
  platforms,
  staffAccountAssignments,
  syncBatches,
  syncTasks,
} from "./schema";

const NOW = new Date("2026-11-04T08:00:00.123456Z");
const t = useTestDb();

describe("迁移与参考数据", () => {
  it("29 张业务表全部建成，没有 ENUM 列，没有 ON DELETE CASCADE", async () => {
    const [tables] = await t.pool.query(
      "SELECT table_name n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type='BASE TABLE' AND table_name <> '__drizzle_migrations'",
    );
    // B 域的 11 张表在本 spec 内定义，不属于 v2（b-access-control AX-D01），单独核对
    const B_TABLES = [
      "auth_users", "auth_sessions", "auth_accounts", "auth_verifications",
      "access_users", "access_user_brands", "access_user_branches", "access_login_failures",
      "access_sms_sends", "access_bootstrap_tokens", "audit_events",
      // 域 G 自有的 6 张表（g-learning-min design §3），同样不属于 v2
      "courses", "course_brand_scopes", "tags", "course_tags", "learning_progress", "course_media_deletions",
    ];
    const names = (tables as Array<{ n: string }>).map((r) => r.n);
    expect(B_TABLES.filter((n) => !names.includes(n))).toEqual([]);
    expect(names.filter((n) => !B_TABLES.includes(n))).toHaveLength(29);
    const [enums] = await t.pool.query("SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = DATABASE() AND data_type = 'enum'");
    expect(enums).toEqual([]);
    const [rules] = await t.pool.query(
      "SELECT delete_rule r, COUNT(*) c FROM information_schema.referential_constraints WHERE constraint_schema = DATABASE() GROUP BY delete_rule",
    );
    const byRule = Object.fromEntries((rules as Array<{ r: string; c: number | string }>).map((x) => [x.r, Number(x.c)]));
    expect(byRule.CASCADE).toBeUndefined();
    // 只有「指向一年期调用/任务的长期引用」使用 SET NULL（v2 §5.3）
    expect(byRule["SET NULL"]).toBe(10); // 含 comments.last_provider_call_id
  });

  it("迁移种入四个平台和 aimaster 供应商；不种 sync_settings（取值未定，不静默冻结）", async () => {
    const rows = await t.db.select({ code: platforms.platformCode }).from(platforms);
    expect(rows.map((r) => r.code).sort()).toEqual(["douyin", "kuaishou", "wechat_channels", "xiaohongshu"]);
    expect(await providerIdOf(t.db)).toBeGreaterThan(0n);
    const [n] = await t.pool.query("SELECT COUNT(*) c FROM sync_settings");
    expect(Number((n as Array<{ c: string }>)[0]!.c)).toBe(0);
  });

  it("连接时区是 UTC，DATETIME(6) 的微秒与 UTC 往返不变", async () => {
    const [tz] = await t.pool.query("SELECT @@session.time_zone tz");
    expect((tz as Array<{ tz: string }>)[0]!.tz).toBe("+00:00");
    const accountId = await insertAccount(t.db, "douyin", NOW);
    const [row] = await t.db.select({ at: externalAccounts.firstSeenAt }).from(externalAccounts).where(eq(externalAccounts.accountId, accountId));
    expect(row!.at.toISOString()).toBe("2026-11-04T08:00:00.123Z");
    const [raw] = await t.pool.query("SELECT CAST(first_seen_at AS CHAR) s FROM external_accounts");
    expect((raw as Array<{ s: string }>)[0]!.s).toBe("2026-11-04 08:00:00.123000");
  });
});

describe("BIGINT 与外部 ID 文本往返（验收 21）", () => {
  it("超过 2^53 的内部 ID 不丢精度", async () => {
    const big = 9007199254740993n;
    await insertAccount(t.db, "douyin", NOW, big);
    const [row] = await t.db.select({ id: externalAccounts.accountId }).from(externalAccounts);
    expect(row!.id).toBe(big);
    const [r] = await t.pool.query("SELECT CAST(account_id AS CHAR) s FROM external_accounts");
    expect((r as Array<{ s: string }>)[0]!.s).toBe("9007199254740993");
  });

  it("19 位外部 ID 与前导零按文本保存，区分大小写（utf8mb4_bin），同 namespace 同文本唯一", async () => {
    const accountId = await insertAccount(t.db, "douyin", NOW);
    const ins = (value: string, ns = "douyin.user_id") =>
      t.db.insert(externalAccountIdentifiers).values({
        accountId,
        namespaceCode: ns,
        identifierValue: value,
        identifierSha256: sha(value),
        bindingMethod: "same_payload",
        confidence: "observed",
        firstSeenAt: NOW,
        lastSeenAt: NOW,
        createdAt: NOW,
      });
    await ins("7680127373081070848");
    await ins("007");
    await ins("abc");
    await ins("ABC"); // 大小写不同 → 不同标识
    await expectRejected(ins("abc"), "uq_identifiers_namespace_sha");
    await ins("abc", "douyin.sec_uid"); // 相同文本、不同 namespace → 允许
    const rows = await t.db.select({ v: externalAccountIdentifiers.identifierValue }).from(externalAccountIdentifiers);
    expect(rows.map((r) => r.v)).toContain("7680127373081070848");
    expect(rows.map((r) => r.v)).toContain("007");
  });

  it("未登记的 namespace 被 CHECK 拒绝", async () => {
    const accountId = await insertAccount(t.db, "douyin", NOW);
    await expectRejected(
      t.db.insert(externalAccountIdentifiers).values({
        accountId,
        namespaceCode: "douyin.made_up",
        identifierValue: "x",
        identifierSha256: sha("x"),
        bindingMethod: "same_payload",
        confidence: "observed",
        firstSeenAt: NOW,
        lastSeenAt: NOW,
        createdAt: NOW,
      }),
      "ck_identifiers_namespace",
    );
  });

  it("dominant_list_author 必须带齐四个 evidence 字段；evidence 字段要么全空要么全有", async () => {
    const accountId = await insertAccount(t.db, "xiaohongshu", NOW);
    const base = {
      accountId,
      namespaceCode: "xiaohongshu.content.user_id",
      identifierValue: "a",
      identifierSha256: sha("a"),
      confidence: "observed",
      firstSeenAt: NOW,
      lastSeenAt: NOW,
      createdAt: NOW,
    };
    await expectRejected(
      t.db.insert(externalAccountIdentifiers).values({ ...base, bindingMethod: "dominant_list_author" }),
      "ck_identifiers_dominant_has_evidence",
    );
    await expectRejected(
      t.db.insert(externalAccountIdentifiers).values({ ...base, bindingMethod: "same_payload", bindingPolicyVersion: "p" }),
      "ck_identifiers_evidence_all_or_none",
    );
  });
});

describe("值状态 CHECK（v2 §5.2）", () => {
  it("value 状态必须非负且非空；其余四态的 value 必须为空", async () => {
    const batchId = await insertBatch(t.db, NOW);
    const accountId = await insertAccount(t.db, "douyin", NOW);
    const org = await seedOrg(t.db, NOW);
    const assignmentId = await insertAssignment(t.db, { accountId, platform: "douyin", staffId: org.staffA, now: NOW });
    const row = (over: Record<string, unknown>) => ({
      batchId,
      accountId,
      assignmentId,
      providerId: 1n,
      followerValue: 0n,
      followerState: "value",
      followingValue: null,
      followingState: "missing",
      likeValue: null,
      likeState: "explicit_null",
      postValue: null,
      postState: "unsupported",
      responseReceivedAt: NOW,
      adapterVersion: "v",
      createdAt: NOW,
      ...over,
    });
    const provider = await providerIdOf(t.db);
    await expectRejected(
      t.db.insert(accountProfileSnapshots).values(row({ providerId: provider, followerValue: -1n }) as never),
      "ck_profile_follower",
    );
    await expectRejected(
      t.db.insert(accountProfileSnapshots).values(row({ providerId: provider, followerValue: null }) as never),
      "ck_profile_follower",
    );
    await expectRejected(
      t.db.insert(accountProfileSnapshots).values(row({ providerId: provider, followingState: "missing", followingValue: 5n }) as never),
      "ck_profile_following",
    );
    await expectRejected(
      t.db.insert(accountProfileSnapshots).values(row({ providerId: provider, postState: "bogus" }) as never),
      "ck_profile_post",
    );
    // 真实 0 是有效值；五态里的 unsupported 合法
    await t.db.insert(accountProfileSnapshots).values(row({ providerId: provider }) as never);
  });
});

describe("归属：账号上的当前单一事实（v2 §8.3）", () => {
  it("一个账号只有一条归属；external 型不带专员；staff 型必须带专员", async () => {
    const org = await seedOrg(t.db, NOW);
    const accountId = await insertAccount(t.db, "douyin", NOW);
    await insertAssignment(t.db, { accountId, platform: "douyin", staffId: org.staffA, now: NOW });
    await expectRejected(
      insertAssignment(t.db, { accountId, platform: "douyin", staffId: org.staffB, now: NOW }),
      "uq_assignments_account",
    );
    const other = await insertAccount(t.db, "xiaohongshu", NOW);
    await expectRejected(
      t.db.insert(staffAccountAssignments).values({
        watchType: "staff",
        staffId: null,
        accountId: other,
        platformId: await platformIdOf(t.db, "xiaohongshu"),
        currentHomeLocator: "l",
        currentHomeLocatorSha256: sha("l"),
        resolvedHomeUrl: "l",
        resolvedHomeUrlSha256: sha("l"),
        intakeStatus: "normal",
        createdAt: NOW,
        updatedAt: NOW,
      }),
      "ck_assignments_staff_by_type",
    );
  });

  it("D-69：同一专员同一平台最多一个占用名额；不同平台、释放名额后可以再录入", async () => {
    const org = await seedOrg(t.db, NOW);
    const a1 = await insertAccount(t.db, "douyin", NOW);
    const a2 = await insertAccount(t.db, "douyin", NOW);
    const a3 = await insertAccount(t.db, "xiaohongshu", NOW);
    await insertAssignment(t.db, { accountId: a1, platform: "douyin", staffId: org.staffA, now: NOW });
    await expectRejected(
      insertAssignment(t.db, { accountId: a2, platform: "douyin", staffId: org.staffA, now: NOW }),
      "uq_assignments_staff_platform_slot",
    );
    await insertAssignment(t.db, { accountId: a3, platform: "xiaohongshu", staffId: org.staffA, now: NOW }); // 另一个平台
    // 名额释放后可以录入新账号
    await t.db.update(staffAccountAssignments).set({ slotReleasedAt: NOW }).where(eq(staffAccountAssignments.accountId, a1));
    await insertAssignment(t.db, { accountId: a2, platform: "douyin", staffId: org.staffA, now: NOW });
  });

  it("复合 FK：归属的 platform_id 必须与账号的 platform_id 一致", async () => {
    const org = await seedOrg(t.db, NOW);
    const accountId = await insertAccount(t.db, "douyin", NOW);
    await expectRejected(
      insertAssignment(t.db, { accountId, platform: "xiaohongshu", staffId: org.staffA, now: NOW }),
      "fk_assignments_account_platform",
    );
  });

  it("关闭监控必须写原因；上一入口与摘要同空同非空", async () => {
    const org = await seedOrg(t.db, NOW);
    const accountId = await insertAccount(t.db, "douyin", NOW);
    const id = await insertAssignment(t.db, { accountId, platform: "douyin", staffId: org.staffA, now: NOW });
    await expectRejected(
      t.db.update(staffAccountAssignments).set({ monitoringEnabled: false }).where(eq(staffAccountAssignments.assignmentId, id)),
      "ck_assignments_closed_reason",
    );
    await expectRejected(
      t.db.update(staffAccountAssignments).set({ previousHomeLocator: "old" }).where(eq(staffAccountAssignments.assignmentId, id)),
      "ck_assignments_previous_locator_pair",
    );
  });
});

describe("专员手机号（D-70）：生成列唯一键", () => {
  it("有效专员手机号唯一；停用专员保留原号但不占号", async () => {
    const org = await seedOrg(t.db, NOW);
    const dup = (phone: string, status: string) =>
      t.db.insert(mediaStaff).values({ storeId: org.storeId, staffName: "x", phone, status, createdAt: NOW, updatedAt: NOW });
    await expectRejected(dup("13800000001", "active"), "uq_media_staff_active_phone");
    await dup("13800000004", "active"); // 13800000004 属于停用专员丁，停用不占号 → 允许
    await dup("13899999999", "inactive");
    await dup("13899999999", "inactive"); // 两个停用专员同号 → 允许
    expect(BIG_STAFF_ID).toBe(org.staffC);
  });
});

describe("current 指针：循环复合外键（v2 §5.4）", () => {
  it("账号 current 只能指向自身的快照", async () => {
    const org = await seedOrg(t.db, NOW);
    const batchId = await insertBatch(t.db, NOW);
    const a1 = await insertAccount(t.db, "douyin", NOW);
    const a2 = await insertAccount(t.db, "xiaohongshu", NOW);
    const as1 = await insertAssignment(t.db, { accountId: a1, platform: "douyin", staffId: org.staffA, now: NOW });
    const as2 = await insertAssignment(t.db, { accountId: a2, platform: "xiaohongshu", staffId: org.staffB, now: NOW });
    const snap1 = await insertProfileSnapshot(t.db, { batchId, accountId: a1, assignmentId: as1, now: NOW });
    await insertProfileSnapshot(t.db, { batchId, accountId: a2, assignmentId: as2, now: NOW });

    await expectRejected(
      t.db.update(externalAccounts).set({ currentProfileSnapshotId: snap1 }).where(eq(externalAccounts.accountId, a2)),
      "fk_accounts_current_profile",
    );
    await t.db.update(externalAccounts).set({ currentProfileSnapshotId: snap1, currentProfileSelectedAt: NOW }).where(eq(externalAccounts.accountId, a1));
  });

  it("内容 current 同理；同账号同批次同内容只有一份快照", async () => {
    const batchId = await insertBatch(t.db, NOW);
    const a1 = await insertAccount(t.db, "douyin", NOW);
    const c1 = await insertContent(t.db, { platform: "douyin", accountId: a1, platformContentId: "p1", now: NOW });
    const c2 = await insertContent(t.db, { platform: "douyin", accountId: a1, platformContentId: "p2", now: NOW });
    const s1 = await insertContentSnapshot(t.db, { batchId, contentId: c1, now: NOW, status: "finalized" });
    await expectRejected(insertContentSnapshot(t.db, { batchId, contentId: c1, now: NOW }), "uq_content_snapshots_batch_content");
    await expectRejected(
      t.db.update(contents).set({ currentSnapshotId: s1 }).where(eq(contents.contentId, c2)),
      "fk_contents_current_snapshot",
    );
    await t.db.update(contents).set({ currentSnapshotId: s1 }).where(eq(contents.contentId, c1));
  });
});

describe("内容按被观察账号保存（2026-11-04 修订）", () => {
  it("同一作品出现在两个账号下是两条内容；同账号重复被拒；content_kind 不接受 mixed", async () => {
    const a1 = await insertAccount(t.db, "douyin", NOW);
    const a2 = await insertAccount(t.db, "douyin", NOW);
    await insertContent(t.db, { platform: "douyin", accountId: a1, platformContentId: "7680127373081070848", now: NOW });
    await insertContent(t.db, { platform: "douyin", accountId: a2, platformContentId: "7680127373081070848", now: NOW });
    await expectRejected(
      insertContent(t.db, { platform: "douyin", accountId: a1, platformContentId: "7680127373081070848", now: NOW }),
      "uq_contents_account_content",
    );
    await expectRejected(
      t.db.update(contents).set({ contentKind: "mixed" }).where(eq(contents.accountId, a1)),
      "ck_contents_kind",
    );
  });
});

describe("content_discoveries：采集当时的归属快照（CONTEXT 不变量 19、D-67）", () => {
  type DiscoveryInsert = typeof contentDiscoveries.$inferInsert;
  const discovery = (over: Pick<DiscoveryInsert, "batchId" | "assignmentId" | "contentId"> & Partial<DiscoveryInsert>): DiscoveryInsert => ({
    pageNo: 0,
    positionInPage: 0,
    absolutePosition: 0,
    isPotentiallyPinned: false,
    discoveredAt: NOW,
    createdAt: NOW,
    ...over,
  });

  it("三列要么全空要么全有；有值时必须指向真实的专员 / 门店 / 品牌", async () => {
    const org = await seedOrg(t.db, NOW);
    const batchId = await insertBatch(t.db, NOW);
    const accountId = await insertAccount(t.db, "douyin", NOW);
    const assignmentId = await insertAssignment(t.db, { accountId, platform: "douyin", staffId: org.staffA, now: NOW });
    const c1 = await insertContent(t.db, { platform: "douyin", accountId, platformContentId: "p1", now: NOW });
    const c2 = await insertContent(t.db, { platform: "douyin", accountId, platformContentId: "p2", now: NOW });
    const c3 = await insertContent(t.db, { platform: "douyin", accountId, platformContentId: "p3", now: NOW });
    const base = { batchId, assignmentId };
    const full = { ownerStaffId: org.staffA, ownerStoreId: org.storeId, ownerBrandId: org.hitachiBrandId };

    await expectRejected(
      t.db.insert(contentDiscoveries).values(discovery({ ...base, contentId: c1, ownerStaffId: org.staffA })),
      "ck_discoveries_owner_snapshot",
    );
    await expectRejected(
      t.db.insert(contentDiscoveries).values(discovery({ ...base, contentId: c1, ...full, ownerStoreId: 424242n })),
      "fk_discoveries_owner_store",
    );
    await t.db.insert(contentDiscoveries).values(discovery({ ...base, contentId: c2, ...full }));
    await t.db.insert(contentDiscoveries).values(discovery({ ...base, contentId: c3 })); // external 型账号没有归属快照
  });

  it("改绑（归属行的 staff_id 被更新）之后，已发生的 discovery 的三列不变", async () => {
    const org = await seedOrg(t.db, NOW);
    const batchId = await insertBatch(t.db, NOW);
    const accountId = await insertAccount(t.db, "douyin", NOW);
    const assignmentId = await insertAssignment(t.db, { accountId, platform: "douyin", staffId: org.staffA, now: NOW });
    const contentId = await insertContent(t.db, { platform: "douyin", accountId, platformContentId: "p1", now: NOW });
    await t.db.insert(contentDiscoveries).values(
      discovery({ batchId, assignmentId, contentId, ownerStaffId: org.staffA, ownerStoreId: org.storeId, ownerBrandId: org.hitachiBrandId }),
    );

    // 受审计的管理员改绑：归属行改给另一门店的专员
    await t.db.update(staffAccountAssignments).set({ staffId: org.staffC }).where(eq(staffAccountAssignments.assignmentId, assignmentId));

    const [row] = await t.db.select().from(contentDiscoveries);
    expect(row).toMatchObject({ ownerStaffId: org.staffA, ownerStoreId: org.storeId, ownerBrandId: org.hitachiBrandId });
    const [a] = await t.db.select().from(staffAccountAssignments);
    expect(a!.staffId).toBe(org.staffC); // 当前归属已经变了，历史发现没有
  });

  it("被发现记录引用的专员 / 门店 / 品牌不能被物理删除（RESTRICT）", async () => {
    const org = await seedOrg(t.db, NOW);
    const batchId = await insertBatch(t.db, NOW);
    const accountId = await insertAccount(t.db, "douyin", NOW);
    const assignmentId = await insertAssignment(t.db, { accountId, platform: "douyin", staffId: org.staffA, now: NOW });
    const contentId = await insertContent(t.db, { platform: "douyin", accountId, platformContentId: "p1", now: NOW });
    await t.db.insert(contentDiscoveries).values(
      discovery({ batchId, assignmentId, contentId, ownerStaffId: org.staffA, ownerStoreId: org.storeId, ownerBrandId: org.hitachiBrandId }),
    );
    // 先改绑，让当前归属行不再引用 staffA；这样挡住删除的只剩 discovery 的快照外键
    await t.db.update(staffAccountAssignments).set({ staffId: org.staffC }).where(eq(staffAccountAssignments.assignmentId, assignmentId));
    await expectRejected(t.db.delete(mediaStaff).where(eq(mediaStaff.staffId, org.staffA)), "fk_discoveries_owner_staff");
  });
});

describe("sync_tasks（v2 §9.3）", () => {
  it("调用者幂等三元组同空同非空；相同 actor+key 唯一", async () => {
    const batchId = await insertBatch(t.db, NOW);
    const taskId = await insertTask(t.db, { batchId, platform: "douyin", now: NOW });
    await expectRejected(
      t.db.update(syncTasks).set({ submittedByActor: "svc" }).where(eq(syncTasks.taskId, taskId)),
      "ck_sync_tasks_command_triple",
    );
    await t.db
      .update(syncTasks)
      .set({ submittedByActor: "svc", callerIdempotencyKeySha256: sha("k"), canonicalCommandSha256: sha("c") })
      .where(eq(syncTasks.taskId, taskId));
    const second = await insertTask(t.db, { batchId, platform: "douyin", now: NOW });
    await expectRejected(
      t.db
        .update(syncTasks)
        .set({ submittedByActor: "svc", callerIdempotencyKeySha256: sha("k"), canonicalCommandSha256: sha("c2") })
        .where(eq(syncTasks.taskId, second)),
      "uq_sync_tasks_caller_key",
    );
  });

  it("租约状态必须有 owner/到期；succeeded_with_gap 必须有 gap 与 stop_reason；overflow 必须伴随 gap；尝试次数不超上限", async () => {
    const batchId = await insertBatch(t.db, NOW);
    const id = await insertTask(t.db, { batchId, platform: "douyin", now: NOW });
    const upd = (set: Partial<typeof syncTasks.$inferInsert>) => t.db.update(syncTasks).set(set).where(eq(syncTasks.taskId, id));
    await expectRejected(upd({ status: "running" }), "ck_sync_tasks_lease");
    await expectRejected(upd({ status: "succeeded_with_gap" }), "ck_sync_tasks_gap");
    await expectRejected(upd({ windowOverflowDetected: true }), "ck_sync_tasks_overflow");
    await expectRejected(upd({ attemptCount: 4 }), "ck_sync_tasks_attempts");
    await expectRejected(upd({ status: "exploded" }), "ck_sync_tasks_status");
    await upd({ status: "running", leaseOwner: "w1", leaseExpiresAt: NOW });
  });

  it("父任务删除时子任务的 parent 置空（一年期引用）", async () => {
    const batchId = await insertBatch(t.db, NOW);
    const parent = await insertTask(t.db, { batchId, platform: "douyin", now: NOW });
    const child = await insertTask(t.db, { batchId, platform: "douyin", now: NOW, action: "fetch_profile" });
    await t.db.update(syncTasks).set({ parentTaskId: parent }).where(eq(syncTasks.taskId, child));
    await t.db.delete(syncTasks).where(eq(syncTasks.taskId, parent));
    const [row] = await t.db.select({ p: syncTasks.parentTaskId }).from(syncTasks).where(eq(syncTasks.taskId, child));
    expect(row!.p).toBeNull();
  });
});

describe("ods_provider_calls 状态矩阵（v2 §9.5）", () => {
  const T0 = NOW;
  const T1 = new Date(NOW.getTime() + 1000);
  const T2 = new Date(NOW.getTime() + 2000);
  const setup = async () => {
    const batchId = await insertBatch(t.db, NOW);
    const taskId = await insertTask(t.db, { batchId, platform: "douyin", now: NOW });
    const callId = await insertPreparedCall(t.db, taskId, "douyin", NOW);
    return { callId, taskId };
  };
  const upd = (id: bigint, set: Partial<typeof odsProviderCalls.$inferInsert>) =>
    t.db.update(odsProviderCalls).set(set).where(eq(odsProviderCalls.providerCallId, id));

  it("prepared 不能带发送时间；in_flight 必须带发送时间；terminal 必须有 outcome", async () => {
    const { callId } = await setup();
    await expectRejected(upd(callId, { sendStartedAt: T1 }), "ck_calls_prepared");
    await expectRejected(upd(callId, { callStatus: "in_flight" }), "ck_calls_in_flight");
    await upd(callId, { callStatus: "in_flight", sendStartedAt: T1 });
    await expectRejected(upd(callId, { callStatus: "terminal", finishedAt: T2, terminalCapturedAt: T2 }), "ck_calls_terminal_has_outcome");
  });

  it("not_sent：发送前封口，不得有发送时间", async () => {
    const { callId } = await setup();
    await expectRejected(upd(callId, { callStatus: "terminal", outcome: "not_sent" }), "ck_calls_not_sent");
    await upd(callId, { callStatus: "terminal", outcome: "not_sent", finishedAt: T1, terminalCapturedAt: T1 });
  });

  it("完整响应终态要求 response_received_at / http_status / elapsed，且不得有 transport_error", async () => {
    const { callId } = await setup();
    await upd(callId, { callStatus: "in_flight", sendStartedAt: T1 });
    await expectRejected(
      upd(callId, { callStatus: "terminal", outcome: "succeeded", finishedAt: T2, terminalCapturedAt: T2 }),
      "ck_calls_complete_response",
    );
    await upd(callId, {
      callStatus: "terminal",
      outcome: "succeeded",
      httpStatus: 200,
      responseReceivedAt: T2,
      finishedAt: T2,
      elapsedSeconds: "1.000000",
      terminalCapturedAt: T2,
    });
  });

  it("transport_error 必须有 transport_error 载荷元数据；ambiguous 不得有完整响应", async () => {
    const a = await setup();
    await upd(a.callId, { callStatus: "in_flight", sendStartedAt: T1 });
    await expectRejected(
      upd(a.callId, { callStatus: "terminal", outcome: "transport_error", finishedAt: T2, elapsedSeconds: "1", terminalCapturedAt: T2 }),
      "ck_calls_transport_error",
    );
    const b = await setup();
    await upd(b.callId, { callStatus: "in_flight", sendStartedAt: T1 });
    await expectRejected(
      upd(b.callId, { callStatus: "ambiguous", outcome: "ambiguous", ambiguousAt: T2, responseReceivedAt: T2 }),
      "ck_calls_ambiguous",
    );
    await upd(b.callId, { callStatus: "ambiguous", outcome: "ambiguous", ambiguousAt: T2 });
  });

  it("时间顺序：发送不早于 prepared，终态捕获不早于结束", async () => {
    const { callId } = await setup();
    await expectRejected(upd(callId, { callStatus: "in_flight", sendStartedAt: new Date(T0.getTime() - 1) }), "ck_calls_times");
  });

  it("reconciled 终态：reconciled_by 不能是自己（触发器），也必须字段齐全", async () => {
    const a = await setup();
    const b = await insertPreparedCall(t.db, a.taskId, "douyin", NOW, 2);
    await upd(a.callId, { callStatus: "in_flight", sendStartedAt: T1 });
    await upd(a.callId, { callStatus: "ambiguous", outcome: "ambiguous", ambiguousAt: T1 });
    const reconciled = {
      callStatus: "terminal",
      outcome: "reconciled_succeeded",
      finishedAt: T2,
      terminalCapturedAt: T2,
      reconciledAt: T2,
      reconciliationMethod: "task_lookup.v1",
    };
    await expectRejected(upd(a.callId, { ...reconciled, reconciledByProviderCallId: a.callId }), "trg_calls_reconciled_not_self");
    await expectRejected(upd(a.callId, reconciled), "ck_calls_reconciled");
    await upd(a.callId, { ...reconciled, reconciledByProviderCallId: b });
  });

  it("被 reconcile 引用的调用不能被删除（RESTRICT，清理顺序：先删引用方）", async () => {
    const a = await setup();
    const b = await insertPreparedCall(t.db, a.taskId, "douyin", NOW, 2);
    await upd(a.callId, { callStatus: "in_flight", sendStartedAt: T1 });
    await upd(a.callId, { callStatus: "ambiguous", outcome: "ambiguous", ambiguousAt: T1 });
    await upd(a.callId, {
      callStatus: "terminal",
      outcome: "reconciled_failed",
      finishedAt: T2,
      terminalCapturedAt: T2,
      reconciledAt: T2,
      reconciliationMethod: "task_lookup.v1",
      reconciledByProviderCallId: b,
    });
    await expectRejected(t.db.delete(odsProviderCalls).where(eq(odsProviderCalls.providerCallId, b)), "fk_calls_reconciled_by");
    await t.db.delete(odsProviderCalls).where(eq(odsProviderCalls.providerCallId, a.callId));
    await t.db.delete(odsProviderCalls).where(eq(odsProviderCalls.providerCallId, b));
  });

  it("ODS 到期删除调用后，长期快照的来源调用引用被置空，快照本身保留", async () => {
    const org = await seedOrg(t.db, NOW);
    const batchId = await insertBatch(t.db, NOW);
    const accountId = await insertAccount(t.db, "douyin", NOW);
    const assignmentId = await insertAssignment(t.db, { accountId, platform: "douyin", staffId: org.staffA, now: NOW });
    const taskId = await insertTask(t.db, { batchId, platform: "douyin", now: NOW });
    const callId = await insertPreparedCall(t.db, taskId, "douyin", NOW);
    const snap = await insertProfileSnapshot(t.db, { batchId, accountId, assignmentId, now: NOW, callId });
    await t.db.delete(odsProviderCalls).where(eq(odsProviderCalls.providerCallId, callId));
    const [row] = await t.db.select({ c: accountProfileSnapshots.sourceProviderCallId }).from(accountProfileSnapshots).where(eq(accountProfileSnapshots.profileSnapshotId, snap));
    expect(row!.c).toBeNull();
  });
});

describe("ODS 与正式媒资对象的用途隔离（v2 §11）", () => {
  it("ods_payloads 只能引用 ods 对象，media_assets 只能引用 media 对象", async () => {
    const batchId = await insertBatch(t.db, NOW);
    const taskId = await insertTask(t.db, { batchId, platform: "douyin", now: NOW });
    const callId = await insertPreparedCall(t.db, taskId, "douyin", NOW);
    const odsObj = await insertOssObject(t.db, { category: "ods", key: "ods/a", now: NOW });
    const mediaObj = await insertOssObject(t.db, { category: "media", key: "media/a", now: NOW });

    const payload = (obj: bigint, category: string) =>
      t.db.insert(odsPayloads).values({
        providerCallId: callId,
        payloadRole: "request_body",
        ossObjectId: obj,
        objectCategory: category,
        byteLength: 2n,
        sha256: sha("{}"),
        parseStatus: "not_attempted",
        capturedAt: NOW,
        expiresAt: NOW,
      });
    await expectRejected(payload(mediaObj, "ods"), "fk_payloads_oss_object"); // 对象是 media，但声明 ods → 复合 FK 不匹配
    await expectRejected(payload(mediaObj, "media"), "ck_payloads_category");
    await payload(odsObj, "ods");

    const asset = (obj: bigint, category: string, hex: string) =>
      t.db.insert(mediaAssets).values({
        sha256: sha(hex),
        byteLength: 1n,
        mediaKind: "image",
        mimeType: "image/jpeg",
        ossObjectId: obj,
        objectCategory: category,
        verificationStatus: "verified",
        verifiedAt: NOW,
        createdAt: NOW,
      });
    await expectRejected(asset(odsObj, "media", "a"), "fk_media_assets_oss_object");
    await expectRejected(asset(odsObj, "ods", "b"), "ck_media_assets_category");
    await asset(mediaObj, "media", "c");
  });

  it("同一字节只有一个 media_asset（UQ sha256）", async () => {
    const o1 = await insertOssObject(t.db, { category: "media", key: "m/1", now: NOW });
    const o2 = await insertOssObject(t.db, { category: "media", key: "m/2", now: NOW });
    const mk = (obj: bigint) =>
      t.db.insert(mediaAssets).values({
        sha256: sha("same-bytes"),
        byteLength: 1n,
        mediaKind: "image",
        mimeType: "image/jpeg",
        ossObjectId: obj,
        verificationStatus: "verified",
        verifiedAt: NOW,
        createdAt: NOW,
      });
    await mk(o1);
    await expectRejected(mk(o2), "uq_media_assets_sha");
  });

  it("1024 字符的对象 key 可以建唯一键（ascii_bin；utf8mb4 会超过 3072 字节索引上限）", async () => {
    const long = "k/" + "a".repeat(1000);
    await insertOssObject(t.db, { category: "ods", key: long, now: NOW });
    await expectRejected(insertOssObject(t.db, { category: "ods", key: long, now: NOW }), "uq_oss_objects_location");
  });

  it("media_references：恰有一个快照；pending/archived/carried_forward/failed 的组合受 CHECK 约束", async () => {
    const org = await seedOrg(t.db, NOW);
    const batchId = await insertBatch(t.db, NOW);
    const accountId = await insertAccount(t.db, "douyin", NOW);
    const assignmentId = await insertAssignment(t.db, { accountId, platform: "douyin", staffId: org.staffA, now: NOW });
    const snap = await insertProfileSnapshot(t.db, { batchId, accountId, assignmentId, now: NOW });
    const ref = (over: Partial<typeof mediaReferences.$inferInsert>) =>
      t.db.insert(mediaReferences).values({
        profileSnapshotId: snap,
        role: "avatar",
        observedAt: NOW,
        archiveStatus: "pending",
        createdAt: NOW,
        updatedAt: NOW,
        ...over,
      });
    await expectRejected(ref({ profileSnapshotId: null }), "ck_media_refs_one_snapshot");
    await expectRejected(ref({ role: "mixed" }), "ck_media_refs_role");
    await expectRejected(ref({ archiveStatus: "archived" }), "ck_media_refs_state_shape");
    await expectRejected(ref({ archiveStatus: "failed" }), "ck_media_refs_state_shape");
    await ref({ archiveStatus: "failed", lastErrorCode: "download_failed" });
    await expectRejected(ref({ role: "avatar", archiveStatus: "failed", lastErrorCode: "x" }), "uq_media_refs_profile_slot");
    await ref({ role: "avatar_normalized" }); // 衍生图角色
  });
});

describe("检查点（v2 §9.4）", () => {
  it("anchor_mode 与高水位字段的形状；游标与摘要同空同非空", async () => {
    const accountId = await insertAccount(t.db, "douyin", NOW);
    const provider = await providerIdOf(t.db);
    const cp = (over: Record<string, unknown>) =>
      t.pool.query(
        "INSERT INTO sync_checkpoints (account_id, provider_id, anchor_mode, high_watermark_published_at, high_watermark_content_ids, cursor_envelope, cursor_sha256, continuity_status, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
        [
          accountId.toString(),
          provider.toString(),
          over.mode,
          over.at ?? null,
          over.ids ?? null,
          over.cursor ?? null,
          over.cursorSha ?? null,
          "ready",
          "2026-11-04 08:00:00.000000",
        ],
      );
    await expectRejected(cp({ mode: "time" }), "ck_checkpoints_anchor_shape");
    await expectRejected(cp({ mode: "id_window", ids: "[]" }), "ck_checkpoints_anchor_shape");
    await expectRejected(cp({ mode: "empty", ids: '["a"]' }), "ck_checkpoints_anchor_shape");
    await expectRejected(cp({ mode: "time", at: "2026-11-04 08:00:00", ids: '{"a":1}' }), "ck_checkpoints_ids_array");
    await expectRejected(cp({ mode: "empty", cursor: '{"kind":"null"}' }), "ck_checkpoints_cursor_pair");
    await cp({ mode: "empty", cursor: '{"kind":"integer","lexeme":"0"}', cursorSha: Buffer.alloc(32, 1) });
  });
});

describe("sync_settings（v2 §9.1）", () => {
  it("单例；初始条数 1..20；评论页数/条数至少配置一项", async () => {
    const ins = (over: Record<string, unknown>) =>
      t.pool.query(
        "INSERT INTO sync_settings (settings_id, schedule_slots, initial_content_limit, list_safety_page_limit, comment_page_limit, task_max_attempts, config_version, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
        [over.id ?? 1, '[{"weekday":1,"time":"02:00"}]', over.limit ?? 20, 5, "comment" in over ? over.comment : 5, 3, 1, "2026-11-04 08:00:00", "2026-11-04 08:00:00"],
      );
    await expectRejected(ins({ id: 2 }), "ck_sync_settings_singleton");
    await expectRejected(ins({ limit: 21 }), "ck_sync_settings_initial_limit");
    await expectRejected(ins({ comment: null }), "ck_sync_settings_comment_limits");
    await ins({});
  });
});

describe("质量问题与批次", () => {
  it("问题指纹唯一；severity/status 受限", async () => {
    const ins = (over: Record<string, unknown>) =>
      t.pool.query(
        "INSERT INTO data_quality_issues (issue_fingerprint, issue_code, severity, status, detail, first_seen_at, last_seen_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
        [over.fp ?? sha("fp"), "suspected_empty_account", over.sev ?? "warning", "open", "{}", "2026-11-04 08:00:00", "2026-11-04 08:00:00", "2026-11-04 08:00:00", "2026-11-04 08:00:00"],
      );
    await ins({});
    await expectRejected(ins({}), "uq_issues_fingerprint");
    await expectRejected(ins({ fp: sha("fp2"), sev: "fatal" }), "ck_issues_severity");
  });

  it("查询与 SQL 一致：用 drizzle 读回 bigint 与 sql 表达式可用", async () => {
    const [r] = await t.db.select({ one: sql<number>`1` }).from(platforms).limit(1);
    expect(Number(r!.one)).toBe(1);
  });
});

describe("a-full-sync：批次用途、媒资完成时间、种子快照、快手标识（v2 R1 / R4 / R5 / R6）", () => {
  it("purpose 只接受四个值，且没有默认值：漏写被 NOT NULL 拒绝，不会静默变成 intake", async () => {
    for (const purpose of ["full", "supplement", "demand", "intake"]) {
      await insertBatch(t.db, NOW, `purpose-${purpose}`).then(async (id) => {
        await t.db.update(syncBatches).set({ purpose }).where(eq(syncBatches.batchId, id));
      });
    }
    const id = await insertBatch(t.db, NOW, "purpose-bad");
    await expectRejected(t.db.update(syncBatches).set({ purpose: "scheduled" }).where(eq(syncBatches.batchId, id)), "ck_sync_batches_purpose");
    await expect(
      t.pool.query(
        "INSERT INTO sync_batches (batch_key, trigger_type, logical_at, status, settings_version, settings_snapshot, created_at, updated_at) VALUES (UNHEX(SHA2('no-purpose',256)), 'manual', ?, 'running', 1, '{}', ?, ?)",
        [NOW, NOW, NOW],
      ),
    ).rejects.toThrow(/purpose/);
    const [col] = await t.pool.query("SELECT column_default d, is_nullable n FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'sync_batches' AND column_name = 'purpose'");
    expect(col).toEqual([{ d: null, n: "NO" }]);
  });
  it("media_finished_at 可空，写入后与 finished_at 互不影响", async () => {
    const id = await insertBatch(t.db, NOW, "media-finished");
    const [before] = await t.db.select().from(syncBatches).where(eq(syncBatches.batchId, id));
    expect(before!.mediaFinishedAt).toBeNull();
    const later = new Date(NOW.getTime() + 3600_000);
    await t.db.update(syncBatches).set({ mediaFinishedAt: later }).where(eq(syncBatches.batchId, id));
    const [after] = await t.db.select().from(syncBatches).where(eq(syncBatches.batchId, id));
    expect(after!.mediaFinishedAt!.getTime()).toBe(later.getTime());
    expect(after!.finishedAt).toBeNull();
  });
  it("种子快照：非空时必须 list_observed=FALSE 且 detail_observed=TRUE；指向的种子不能被物理删除", async () => {
    const b1 = await insertBatch(t.db, NOW, "seed-b1");
    const b2 = await insertBatch(t.db, NOW, "seed-b2");
    const acc = await insertAccount(t.db, "douyin", NOW);
    const c = await insertContent(t.db, { platform: "douyin", accountId: acc, platformContentId: "seed-1", now: NOW });
    const seed = await insertContentSnapshot(t.db, { batchId: b1, contentId: c, now: NOW, status: "finalized" });
    const demand = await insertContentSnapshot(t.db, { batchId: b2, contentId: c, now: NOW });
    const setSeed = (extra: object) =>
      t.db.update(contentSnapshots).set({ seededFromSnapshotId: seed, ...extra }).where(eq(contentSnapshots.contentSnapshotId, demand));
    await expectRejected(setSeed({}), "ck_content_snapshots_seeded"); // detail_observed 仍是 FALSE
    await expectRejected(setSeed({ listObserved: true, detailObserved: true }), "ck_content_snapshots_seeded");
    await setSeed({ listObserved: false, detailObserved: true });
    const [row] = await t.db.select().from(contentSnapshots).where(eq(contentSnapshots.contentSnapshotId, demand));
    expect(row!.seededFromSnapshotId).toBe(seed);
    await expectRejected(t.db.delete(contentSnapshots).where(eq(contentSnapshots.contentSnapshotId, seed)), "fk_content_snap_seeded_from");
  });
  it("kuaishou.user_id 可以登记为账号标识，同 namespace 同文本唯一", async () => {
    const accountId = await insertAccount(t.db, "kuaishou", NOW);
    const ins = (v: string) =>
      t.db.insert(externalAccountIdentifiers).values({
        accountId,
        namespaceCode: "kuaishou.user_id",
        identifierValue: v,
        identifierSha256: sha(v),
        bindingMethod: "same_payload",
        confidence: "observed",
        firstSeenAt: NOW,
        lastSeenAt: NOW,
        createdAt: NOW,
      });
    await ins("3xabcdef0123456");
    await expectRejected(ins("3xabcdef0123456"), "uq_identifiers_namespace_sha");
  });
});
