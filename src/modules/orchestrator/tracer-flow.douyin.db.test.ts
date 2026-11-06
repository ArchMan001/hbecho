// 任务 4：抖音账号 tracer 纵向切片（R3–R5、R7–R11、R14、R18、R19；acceptance B、C、D、E、I、J）。
// 全部离线：fixture transport、fake OSS、fake clock；真实 MySQL 8.4（一次性容器）。
import { createHash } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { useTestDb } from "../../../tests/harness/db";
import { bytesOf } from "../../../tests/harness/decode-helpers";
import { loadFixtureBytes } from "../../../tests/harness/fixtures";
import { DOUYIN_LOCATOR, LIST_PATH, PROFILE_PATH, XHS_LOCATOR, setupTracer } from "../../../tests/harness/tracer-env";
import { insertAccount, insertAssignment } from "../../../tests/harness/factories";
import {
  accountProfileSnapshots,
  contentDiscoveries,
  contentSnapshots,
  contents,
  dataQualityIssues,
  externalAccountIdentifiers,
  externalAccounts,
  mediaReferences,
  odsProviderCalls,
  staffAccountAssignments,
  syncBatches,
  syncCheckpoints,
  syncTasks,
} from "../../db/schema";
import { runTracerRoot, type TracerRunHooks } from "./index";

const t = useTestDb();
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest();

const run = (env: Awaited<ReturnType<typeof setupTracer>>, rootId: bigint, hooks?: TracerRunHooks) =>
  runTracerRoot({ db: t.db, clock: env.clock, gateway: env.gateway, workerId: "w1", ...(hooks ? { hooks } : {}) }, rootId);

async function happy() {
  const env = await setupTracer(t);
  env.serve.profile("douyin");
  env.serve.list("douyin");
  const rootId = await env.submit();
  const result = await run(env, rootId);
  return { env, rootId, result };
}

const counts = async () => ({
  accounts: (await t.db.select().from(externalAccounts)).length,
  identifiers: (await t.db.select().from(externalAccountIdentifiers)).length,
  assignments: (await t.db.select().from(staffAccountAssignments)).length,
  profiles: (await t.db.select().from(accountProfileSnapshots)).length,
  contents: (await t.db.select().from(contents)).length,
  snapshots: (await t.db.select().from(contentSnapshots)).length,
  discoveries: (await t.db.select().from(contentDiscoveries)).length,
  checkpoints: (await t.db.select().from(syncCheckpoints)).length,
  mediaRefs: (await t.db.select().from(mediaReferences)).length,
});
const ZERO = { accounts: 0, identifiers: 0, assignments: 0, profiles: 0, contents: 0, snapshots: 0, discoveries: 0, checkpoints: 0, mediaRefs: 0 };

describe("抖音主路径：一次命令得到 HITACHI1 的全部结构化事实", () => {
  it("账号、命名空间标识、当前归属、finalized 主页快照、20/20 条内容与发现、整数检查点", async () => {
    const { env, rootId, result } = await happy();
    expect(result.kind).toBe("succeeded");

    // 一个账号 HITACHI1，没有 HITACHI2023
    const accounts = await t.db.select().from(externalAccounts);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.status).toBe("active"); // 账号状态不被 tracer 改动
    const ids = await t.db.select().from(externalAccountIdentifiers).orderBy(externalAccountIdentifiers.namespaceCode);
    expect(ids.map((i) => [i.namespaceCode, i.identifierValue, i.bindingMethod, i.confidence])).toEqual([
      ["douyin.sec_uid", "MS4wLjABAAAAaQNZi_ulE1SgF5-WN-toezy3GtHsCmdlZjrc1wkHcLA", "same_payload", "observed"],
      ["douyin.user_id", "HITACHI1", "same_payload", "observed"],
    ]);
    expect(ids.every((i) => i.accountId === accounts[0]!.accountId)).toBe(true);
    expect(ids.some((i) => i.identifierValue === "HITACHI2023")).toBe(false);

    // 当前归属：同一条记录里成对写入入口（原文）与清洗值；无区间；intake_status=normal
    const [a] = await t.db.select().from(staffAccountAssignments);
    expect(a).toMatchObject({
      watchType: "staff",
      staffId: env.org.staffA,
      accountId: accounts[0]!.accountId,
      monitoringEnabled: true,
      currentHomeLocator: DOUYIN_LOCATOR,
      previousHomeLocator: null,
      resolvedHomeUrl: DOUYIN_LOCATOR, // 清洗后的入口，不是供应商确认的主页 URL（v2 §8.3）
      intakeStatus: "normal",
    });
    expect(a!.currentHomeLocatorSha256.equals(sha(DOUYIN_LOCATOR))).toBe(true);

    // finalized 主页快照：绑定到那次主页调用与 Adapter 版本；值状态保真；current 指针指向它
    const calls = await t.db.select().from(odsProviderCalls).orderBy(odsProviderCalls.providerCallId);
    expect(calls.map((c) => [c.requestedAction, c.callStatus, c.outcome])).toEqual([
      ["media_user_info", "terminal", "succeeded"],
      ["user_video_list", "terminal", "succeeded"],
    ]);
    const [p] = await t.db.select().from(accountProfileSnapshots);
    expect(p).toMatchObject({
      accountId: accounts[0]!.accountId,
      assignmentId: a!.assignmentId,
      sourceProviderCallId: calls[0]!.providerCallId,
      adapterVersion: "aimaster-adapter.v1",
      nickname: "日立中央空调",
      followerState: "value",
      followerValue: 1181412n,
      postValue: 590n,
    });
    expect(accounts[0]!.currentProfileSnapshotId).toBe(p!.profileSnapshotId);

    // 头像 / 背景引用（抖音）：pending，临时 URL 只是 source locator
    const profileRefs = await t.db.select().from(mediaReferences).where(eq(mediaReferences.profileSnapshotId, p!.profileSnapshotId));
    expect(profileRefs.map((r) => [r.role, r.slotIndex, r.archiveStatus]).sort()).toEqual([
      ["avatar", 0, "pending"],
      ["background", 0, "pending"],
    ]);

    // 20/20 条内容、快照、发现；归属快照三列；前三位可能置顶
    expect(await counts()).toMatchObject({ contents: 20, snapshots: 20, discoveries: 20, accounts: 1, profiles: 1, checkpoints: 1 });
    const disc = await t.db.select().from(contentDiscoveries).orderBy(contentDiscoveries.absolutePosition);
    expect(disc.map((d) => d.absolutePosition)).toEqual([...Array(20).keys()]);
    expect(disc.every((d) => d.pageNo === 0 && d.assignmentId === a!.assignmentId)).toBe(true);
    expect(disc.map((d) => d.isPotentiallyPinned)).toEqual([true, true, true, ...Array(17).fill(false)]);
    expect(disc.every((d) => d.ownerStaffId === env.org.staffA && d.ownerStoreId === env.org.storeId && d.ownerBrandId === env.org.hitachiBrandId)).toBe(true);
    expect(disc.every((d) => d.sourceProviderCallId === calls[1]!.providerCallId)).toBe(true);

    // 异作者：HITACHI2023 只在内容事实里，不是账号；target 账号才是内容的账号
    const cs = await t.db.select().from(contents);
    expect(cs.every((c) => c.accountId === accounts[0]!.accountId && c.contentKind === "video")).toBe(true);
    const snaps = await t.db.select().from(contentSnapshots);
    const foreign = snaps.filter((s) => s.returnedAuthorIdentifier === "HITACHI2023");
    expect(foreign).toHaveLength(1);
    expect(foreign[0]).toMatchObject({ returnedAuthorNamespaceCode: "douyin.user_id", returnedAuthorName: expect.any(String) });
    expect(snaps.filter((s) => s.returnedAuthorIdentifier === "HITACHI1")).toHaveLength(19);

    // 值状态：列表播放数 unsupported（不是 0 / missing）；点赞等是真实值
    expect(snaps.every((s) => s.snapshotStatus === "finalized" && s.finalizedAt !== null)).toBe(true);
    expect(snaps.every((s) => s.playState === "unsupported" && s.playValue === null)).toBe(true);
    expect(snaps.every((s) => s.likeState === "value")).toBe(true);
    expect(snaps.every((s) => s.listObserved && !s.detailObserved && s.lastListProviderCallId === calls[1]!.providerCallId)).toBe(true);
    // current 指针：每条内容都指向自己的 finalized 快照
    const bySnap = new Map(snaps.map((s) => [s.contentId, s.contentSnapshotId]));
    expect(cs.every((c) => c.currentSnapshotId === bySnap.get(c.contentId))).toBe(true);

    // 封面：第 2 条候选，role=cover，slot 0
    const covers = await t.db.select().from(mediaReferences).where(eq(mediaReferences.role, "cover"));
    expect(covers).toHaveLength(20);
    expect(covers.every((c) => c.slotIndex === 0 && c.archiveStatus === "pending" && /540:q75/.test(c.sourceLocator ?? ""))).toBe(true);

    // 检查点：整数游标原样（不转字符串）；time 锚点；ready；版本 1
    const [cp] = await t.db.select().from(syncCheckpoints);
    expect(cp!.cursorEnvelope).toEqual({ kind: "integer", lexeme: "1782701295000" });
    expect(cp).toMatchObject({ accountId: accounts[0]!.accountId, action: "fetch_content_list", anchorMode: "time", continuityStatus: "ready", version: 1n });
    expect(cp!.highWatermarkPublishedAt!.getTime()).toBe(1788169004000);
    expect(cp!.highWatermarkContentIds).toEqual(["7680127373081070848"]);
    const [batch] = await t.db.select().from(syncBatches);
    expect(cp!.lastSuccessfulBatchId).toBe(batch!.batchId);

    // 状态：结构化成功、媒资待办（独立进度）、cursor 类型、录入结果
    const s = await env.status(rootId);
    expect(s).toMatchObject({
      state: "structured_succeeded_media_pending",
      entryOutcome: "normal",
      structured: { profileFinalized: true, returnedEntries: 20, projectedEntries: 20, discoveries: 20, checkpointEstablished: true, cursorType: "integer" },
      target: { accountId: accounts[0]!.accountId.toString(), submittedMediaStaffIsOwner: true },
    });
    expect(s.media.pending).toBe(22);
    expect(s.media.total).toBe(22);
    expect(await env.root(rootId)).toMatchObject({ status: "succeeded", accountId: accounts[0]!.accountId, assignmentId: a!.assignmentId });
    expect((await t.db.select().from(syncBatches))[0]!.status).toBe("succeeded");
  });

  it("成功路径的 ProviderCall 数 = 主页 1 + 列表 1，请求是同步、整数游标 0；没有质量问题", async () => {
    const { env } = await happy();
    expect(env.transport.calls).toHaveLength(2);
    expect(env.transport.calls.map((c) => [c.request.path, c.request.query.async])).toEqual([
      [PROFILE_PATH, "false"],
      [LIST_PATH, "false"],
    ]);
    expect(new TextDecoder().decode(env.transport.calls[1]!.request.body!)).toBe(`{"url":${JSON.stringify(DOUYIN_LOCATOR)},"max_cursor":0}`);
    expect(await t.db.select().from(dataQualityIssues)).toHaveLength(0);
  });
});

describe("重复提交与恢复：不重复付费调用，不重复业务事实", () => {
  it("同一 root 再运行一次：终态不变、供应商调用数不变、事实行数不变", async () => {
    const { env, rootId } = await happy();
    const before = await counts();
    const again = await run(env, rootId);
    expect(again.kind).toBe("already_terminal");
    expect(env.transport.calls).toHaveLength(2);
    expect(await counts()).toEqual(before);
  });

  it("崩溃发生在网络调用之前（prepared 已落地）：接手后只发送一次，调用总数 2", async () => {
    const env = await setupTracer(t);
    env.serve.profile("douyin");
    env.serve.list("douyin");
    const rootId = await env.submit();
    class Crash extends Error {}
    env.hooks.afterPrepared = () => {
      if (env.transport.calls.length === 1) throw new Crash("列表 prepared 之后崩溃");
    };
    await expect(run(env, rootId)).rejects.toThrow(Crash);
    expect(env.transport.calls).toHaveLength(1);
    delete env.hooks.afterPrepared;
    // 租约到期后接手
    env.clock.advance(120_000);
    const result = await run(env, rootId);
    expect(result.kind).toBe("succeeded");
    expect(env.transport.calls).toHaveLength(2);
    expect(await counts()).toMatchObject({ accounts: 1, assignments: 1, profiles: 1, contents: 20, discoveries: 20, checkpoints: 1 });
    const calls = await t.db.select().from(odsProviderCalls);
    expect(calls).toHaveLength(2); // 主页调用被复用，没有新 ProviderCall
  });
});

describe("接手：主页事实已提交后崩溃", () => {
  it("整页投影之前进程崩溃，租约到期后接手：主页证据与列表证据都复用，调用总数仍是 2，没有重复账号 / 快照 / 发现", async () => {
    const env = await setupTracer(t);
    env.serve.profile("douyin");
    env.serve.list("douyin");
    const rootId = await env.submit();
    class Crash extends Error {}
    await expect(
      run(env, rootId, {
        beforePageProjection: () => {
          throw new Crash("整页投影前崩溃");
        },
      }),
    ).rejects.toThrow(Crash);
    expect(await counts()).toMatchObject({ accounts: 1, assignments: 1, profiles: 1, contents: 0 });
    expect((await run(env, rootId)).kind).toBe("busy"); // 租约还没到期：另一个 worker 不能抢

    env.clock.advance(120_000);
    expect((await run(env, rootId)).kind).toBe("succeeded");
    expect(env.transport.calls).toHaveLength(2);
    expect(await t.db.select().from(odsProviderCalls)).toHaveLength(2);
    expect(await counts()).toMatchObject({ accounts: 1, identifiers: 2, assignments: 1, profiles: 1, contents: 20, snapshots: 20, discoveries: 20, checkpoints: 1 });
    // fencing token 单调递增：接手使旧 worker 的 token 失效
    expect((await env.root(rootId)).fencingToken).toBe(2n);
  });
});

describe("入口：非主页 / 平台错配 / 三次失败都不产生业务身份", () => {
  const VALIDATION_FAILED = () => loadFixtureBytes("raw7.C20.http500");

  it("视频链接：终态 invalid_link，供应商调用 0，没有任何账号 / 归属 / 快照", async () => {
    const env = await setupTracer(t);
    const rootId = await env.submit({ locator: "https://www.douyin.com/video/7680127373081070848" });
    const result = await run(env, rootId);
    expect(result.kind).toBe("failed");
    expect(env.transport.calls).toHaveLength(0);
    expect(await t.db.select().from(odsProviderCalls)).toHaveLength(0);
    expect(await counts()).toEqual(ZERO);
    const r = await env.root(rootId);
    expect(r).toMatchObject({ status: "failed", stopReason: "invalid_link", lastErrorCode: "non_home_locator" });
    const s = await env.status(rootId);
    expect(s.entryOutcome).toBe("invalid_link");
    expect(s.failure).toMatchObject({ code: "non_home_locator", retryable: false });
    expect(s.target).toBeUndefined();
  });

  it("平台错配（抖音命令 + 小红书主页链接）：拒绝，不静默切换平台，调用 0", async () => {
    const env = await setupTracer(t);
    const rootId = await env.submit({ locator: XHS_LOCATOR });
    const result = await run(env, rootId);
    expect(result.kind).toBe("failed");
    expect(env.transport.calls).toHaveLength(0);
    expect(await counts()).toEqual(ZERO);
    expect(await env.root(rootId)).toMatchObject({ status: "failed", stopReason: "invalid_link", lastErrorCode: "platform_mismatch" });
    expect((await env.status(rootId)).entryOutcome).toBe("invalid_link");
  });

  it("连续三次 RESULT_VALIDATION_FAILED：三条独立 ProviderCall，终态 invalid_link，库里没有账号 / 归属 / 快照 / 检查点", async () => {
    const env = await setupTracer(t);
    env.serve.profile("douyin", VALIDATION_FAILED(), 500);
    // 第 1 次同步失败后，第 2、3 次改走异步；异步提交同样被供应商校验失败拒绝
    env.transport.register({ path: PROFILE_PATH, query: { async: "true" } }, { httpStatus: 500, body: VALIDATION_FAILED() });
    const rootId = await env.submit();
    const result = await run(env, rootId);
    expect(result.kind).toBe("failed");
    expect(env.transport.calls.map((c) => c.request.query.async)).toEqual(["false", "true", "true"]);
    const calls = await t.db.select().from(odsProviderCalls).orderBy(odsProviderCalls.attemptNo);
    expect(calls.map((c) => [c.attemptNo, c.callSequence, c.callStatus, c.outcome, c.httpStatus])).toEqual([
      [1, 1, "terminal", "http_error", 500],
      [2, 1, "terminal", "http_error", 500],
      [3, 1, "terminal", "http_error", 500],
    ]);
    expect(await counts()).toEqual(ZERO);
    expect(await env.root(rootId)).toMatchObject({ status: "failed", stopReason: "invalid_link", attemptCount: 3 });
    expect((await env.status(rootId)).entryOutcome).toBe("invalid_link");
    expect(env.transport.calls).toHaveLength(3); // 没有第 4 次
  });

  it("前两次校验失败、第三次成功：继续完成整条链路", async () => {
    const env = await setupTracer(t);
    const ok = loadFixtureBytes("raw3.douyin.media_user_info");
    // 第 1 次（同步）与第 2 次（异步）失败，第 3 次（异步）提交直接返回完整结果
    env.transport.register({ path: PROFILE_PATH, query: { async: "false" } }, { httpStatus: 500, body: VALIDATION_FAILED() });
    let asyncCalls = 0;
    env.transport.register({ path: PROFILE_PATH, query: { async: "true" } }, () => (asyncCalls++ < 1 ? { httpStatus: 500, body: VALIDATION_FAILED() } : { httpStatus: 200, body: ok }));
    env.serve.list("douyin");
    const rootId = await env.submit();
    expect((await run(env, rootId)).kind).toBe("succeeded");
    expect(env.transport.calls).toHaveLength(4); // 3 次主页 + 1 页列表
    expect(await counts()).toMatchObject({ accounts: 1, discoveries: 20 });
  });

  it("HTTP 400 INVALID_REQUEST：不重试、不当作 invalid_link，也不产生业务身份", async () => {
    const env = await setupTracer(t);
    env.serve.profile("douyin", loadFixtureBytes("raw7.C19.http400"), 400);
    const rootId = await env.submit();
    expect((await run(env, rootId)).kind).toBe("failed");
    expect(env.transport.calls).toHaveLength(1);
    expect(await counts()).toEqual(ZERO);
    const s = await env.status(rootId);
    expect(s.entryOutcome).toBeUndefined();
    expect(s.failure).toMatchObject({ category: "provider_request_rejected", retryable: false });
  });
});

describe("归属：不抢占，不继续付费", () => {
  it("账号已归属他人：原 owner 不变，提交者不是 owner，只有主页 1 次调用，记录冲突问题", async () => {
    const env = await setupTracer(t);
    env.serve.profile("douyin");
    env.serve.list("douyin");
    // 先由专员乙占有 HITACHI1
    const accountId = await insertAccount(t.db, "douyin", env.clock.now());
    const assignmentId = await insertAssignment(t.db, { accountId, platform: "douyin", staffId: env.org.staffB, now: env.clock.now() });
    await t.db.insert(externalAccountIdentifiers).values({
      accountId,
      namespaceCode: "douyin.user_id",
      identifierValue: "HITACHI1",
      identifierSha256: sha("HITACHI1"),
      bindingMethod: "same_payload",
      confidence: "observed",
      firstSeenAt: env.clock.now(),
      lastSeenAt: env.clock.now(),
      createdAt: env.clock.now(),
    });
    const rootId = await env.submit({ staffId: env.org.staffA });
    const result = await run(env, rootId);
    expect(result.kind).toBe("blocked");

    expect(env.transport.calls).toHaveLength(1); // 只调了主页，没有列表（默认不继续付费）
    const [a] = await t.db.select().from(staffAccountAssignments);
    expect(a).toMatchObject({ assignmentId, staffId: env.org.staffB, accountId });
    expect(await t.db.select().from(staffAccountAssignments)).toHaveLength(1);
    expect(await counts()).toMatchObject({ profiles: 0, contents: 0, snapshots: 0, discoveries: 0, checkpoints: 0, mediaRefs: 0 });

    const issues = await t.db.select().from(dataQualityIssues);
    expect(issues.map((i) => [i.issueCode, i.accountId, i.assignmentId, i.batchId !== null])).toEqual([["assignment_conflict", accountId, assignmentId, true]]);

    const s = await env.status(rootId);
    expect(s.state).toBe("blocked_assignment_conflict");
    expect(s.target).toMatchObject({ accountId: accountId.toString(), ownerMediaStaffId: env.org.staffB.toString(), submittedMediaStaffIsOwner: false });
    expect(s.qualityIssues).toEqual([{ code: "assignment_conflict", status: "open" }]);
    // 账号状态不变
    expect((await t.db.select().from(externalAccounts))[0]!.status).toBe("active");
  });

  it("账号已归属同一专员：no-op 复用，不产生第二条归属，仍完成链路", async () => {
    const env = await setupTracer(t);
    env.serve.profile("douyin");
    env.serve.list("douyin");
    const first = await env.submit({ key: "a" });
    expect((await run(env, first)).kind).toBe("succeeded");
    const second = await env.submit({ key: "b" }); // 前一个已终态，所以是新 root
    expect(second).not.toBe(first);
    expect((await run(env, second)).kind).toBe("succeeded");
    expect(await t.db.select().from(staffAccountAssignments)).toHaveLength(1);
    expect(await t.db.select().from(externalAccounts)).toHaveLength(1);
    expect(await t.db.select().from(accountProfileSnapshots)).toHaveLength(2); // 每批次一份
    expect(await t.db.select().from(contents)).toHaveLength(20); // 内容按账号复用
    expect(await t.db.select().from(contentSnapshots)).toHaveLength(40);
    expect(await t.db.select().from(syncCheckpoints)).toHaveLength(1); // 检查点只建立一次，不被第二批次改写
    const [cp] = await t.db.select().from(syncCheckpoints);
    expect(cp!.version).toBe(1n);
  });

  it("同一专员在抖音已占用名额：第二个账号阻塞为 staff_platform_slot_taken，无新账号 / 归属，只调主页 1 次", async () => {
    const env = await setupTracer(t);
    env.serve.profile("douyin");
    env.serve.list("douyin");
    const otherAccount = await insertAccount(t.db, "douyin", env.clock.now());
    await insertAssignment(t.db, { accountId: otherAccount, platform: "douyin", staffId: env.org.staffA, now: env.clock.now() });
    const rootId = await env.submit({ staffId: env.org.staffA });
    expect((await run(env, rootId)).kind).toBe("blocked");
    expect(env.transport.calls).toHaveLength(1);
    expect(await t.db.select().from(staffAccountAssignments)).toHaveLength(1);
    expect(await t.db.select().from(externalAccounts)).toHaveLength(1); // 只有预先存在的那个
    expect(await t.db.select().from(externalAccountIdentifiers)).toHaveLength(0);
    expect(await counts()).toMatchObject({ profiles: 0, contents: 0, discoveries: 0, checkpoints: 0 });
    const s = await env.status(rootId);
    expect(s.state).toBe("blocked_staff_platform_slot_taken");
    const issues = await t.db.select().from(dataQualityIssues);
    expect(issues.map((i) => i.issueCode)).toEqual(["staff_platform_slot_taken"]);
  });
});

describe("疑似空账号：粉丝 0 且作品 0", () => {
  const emptyProfile = () => {
    const text = new TextDecoder().decode(loadFixtureBytes("raw3.douyin.media_user_info"));
    return bytesOf(text.replace(/"(follower_number|follower_count|post_number|post_count)":\s*"?\d+"?/g, '"$1": 0'));
  };

  it("写 issue 与 intake_status=suspected_empty，账号状态不变，不进入常规采集（无列表调用、无检查点），监控开关不关", async () => {
    const env = await setupTracer(t);
    env.serve.profile("douyin", emptyProfile());
    env.serve.list("douyin");
    const rootId = await env.submit();
    expect((await run(env, rootId)).kind).toBe("succeeded");
    expect(env.transport.calls).toHaveLength(1);

    const [a] = await t.db.select().from(staffAccountAssignments);
    expect(a).toMatchObject({ intakeStatus: "suspected_empty", monitoringEnabled: true, monitoringClosedReason: null });
    expect((await t.db.select().from(externalAccounts))[0]!.status).toBe("active");
    const issues = await t.db.select().from(dataQualityIssues);
    expect(issues.map((i) => [i.issueCode, i.severity, i.accountId, i.assignmentId])).toEqual([
      ["suspected_empty_account", "warning", a!.accountId, a!.assignmentId],
    ]);
    expect(await counts()).toMatchObject({ profiles: 1, contents: 0, discoveries: 0, checkpoints: 0 });
    const s = await env.status(rootId);
    expect(s.entryOutcome).toBe("suspected_empty");
    expect(s.qualityIssues).toEqual([{ code: "suspected_empty_account", status: "open" }]);
  });

  it("只有粉丝为 0（作品不是 0）不算疑似空账号", async () => {
    const env = await setupTracer(t);
    const text = new TextDecoder().decode(loadFixtureBytes("raw3.douyin.media_user_info"));
    env.serve.profile("douyin", bytesOf(text.replace(/"(follower_number|follower_count)":\s*"?\d+"?/g, '"$1": 0')));
    env.serve.list("douyin");
    const rootId = await env.submit();
    expect((await run(env, rootId)).kind).toBe("succeeded");
    expect((await t.db.select().from(staffAccountAssignments))[0]!.intakeStatus).toBe("normal");
    expect(env.transport.calls).toHaveLength(2);
  });
});

describe("fencing 与取消：迟到 worker 不发布，已取消不付费", () => {
  it("主页响应返回后 fencing token 被更高 worker 取代：证据保留，但不创建账号 / 归属 / 快照，也不发列表", async () => {
    const env = await setupTracer(t);
    env.serve.profile("douyin");
    env.serve.list("douyin");
    const rootId = await env.submit();
    env.hooks.afterNetwork = async () => {
      await t.db.update(syncTasks).set({ fencingToken: 99n }).where(eq(syncTasks.taskId, rootId));
    };
    const result = await run(env, rootId);
    expect(result.kind).toBe("stale");
    expect(env.transport.calls).toHaveLength(1);
    const [call] = await t.db.select().from(odsProviderCalls);
    expect(call).toMatchObject({ callStatus: "terminal", outcome: "succeeded" }); // 不可变证据保留
    expect(await counts()).toEqual(ZERO);
  });

  it("主页响应已捕获、投影事务之前被更高 worker 取代：投影事务拒绝，不创建账号 / 归属 / 快照，也不发列表", async () => {
    const env = await setupTracer(t);
    env.serve.profile("douyin");
    env.serve.list("douyin");
    const rootId = await env.submit();
    const result = await run(env, rootId, {
      beforeIntake: async () => void (await t.db.update(syncTasks).set({ fencingToken: 99n }).where(eq(syncTasks.taskId, rootId))),
    });
    expect(result.kind).toBe("stale");
    expect(env.transport.calls).toHaveLength(1);
    expect(await counts()).toEqual(ZERO);
  });

  it("列表响应已捕获、整页投影之前被取代：内容 / 发现 / 检查点一行都不写（整页回滚），主页事实保留", async () => {
    const env = await setupTracer(t);
    env.serve.profile("douyin");
    env.serve.list("douyin");
    const rootId = await env.submit();
    const result = await run(env, rootId, {
      beforePageProjection: async () => void (await t.db.update(syncTasks).set({ fencingToken: 99n }).where(eq(syncTasks.taskId, rootId))),
    });
    expect(result.kind).toBe("stale");
    expect(await counts()).toMatchObject({ accounts: 1, profiles: 1, contents: 0, snapshots: 0, discoveries: 0, checkpoints: 0, mediaRefs: 2 });
    expect((await env.root(rootId)).status).toBe("running"); // 没有被陈旧 worker 写成终态
  });

  it("投影之前被取消：返回 cancelled，不写任何新事实", async () => {
    const env = await setupTracer(t);
    env.serve.profile("douyin");
    env.serve.list("douyin");
    const rootId = await env.submit();
    const result = await run(env, rootId, { beforeIntake: async () => void (await env.commands.cancel(rootId.toString(), env.actor)) });
    expect(result.kind).toBe("cancelled");
    expect(await counts()).toEqual(ZERO);
  });

  it("发送前已取消：不发送任何供应商调用", async () => {
    const env = await setupTracer(t);
    env.serve.profile("douyin");
    env.serve.list("douyin");
    const rootId = await env.submit();
    await env.commands.cancel(rootId.toString(), env.actor);
    const result = await run(env, rootId);
    expect(result.kind).toBe("already_terminal");
    expect(env.transport.calls).toHaveLength(0);
    expect(await counts()).toEqual(ZERO);
  });

  it("列表阶段中途被取消：已投影的主页事实保留，不写内容 / 发现 / 检查点", async () => {
    const env = await setupTracer(t);
    env.serve.profile("douyin");
    env.serve.list("douyin");
    const rootId = await env.submit();
    env.hooks.afterNetwork = async () => {
      if (env.transport.calls.length === 2) await env.commands.cancel(rootId.toString(), env.actor);
    };
    const result = await run(env, rootId);
    expect(result.kind).toBe("cancelled");
    expect(await counts()).toMatchObject({ accounts: 1, profiles: 1, contents: 0, discoveries: 0, checkpoints: 0 });
    expect((await env.root(rootId)).status).toBe("cancelled");
  });
});

describe("状态查询不产生供应商调用", () => {
  it("run 之后反复查询：transport 调用数不变", async () => {
    const { env, rootId } = await happy();
    const before = env.transport.calls.length;
    await env.status(rootId);
    await env.status(rootId);
    expect(env.transport.calls).toHaveLength(before);
  });
});

describe("子任务与批次记录", () => {
  it("列表阶段是 root 的子任务 fetch_content_list：已处理条数、页数、has_more 与终态可查", async () => {
    const { rootId } = await happy();
    const kids = await t.db.select().from(syncTasks).where(eq(syncTasks.parentTaskId, rootId));
    expect(kids).toHaveLength(1);
    expect(kids[0]).toMatchObject({
      requestedAction: "fetch_content_list",
      status: "succeeded",
      pageCount: 1,
      fetchedItemCount: 20,
      hasMoreAtStop: true,
      accountId: expect.any(BigInt),
    });
    expect(kids[0]!.newestPublishedAt!.getTime()).toBe(1788169004000);
    const tasks = await t.db.select().from(syncTasks).where(inArray(syncTasks.status, ["succeeded"]));
    expect(tasks).toHaveLength(2);
    const [batch] = await t.db.select().from(syncBatches);
    expect(batch).toMatchObject({ status: "succeeded", succeededTaskCount: 2, failedTaskCount: 0 });
  });

  it("旧批次迟到：先运行较新的批次，再运行较旧的批次，current 指针与检查点都不倒退，旧批次的不可变历史仍保留", async () => {
    const env = await setupTracer(t);
    env.serve.profile("douyin");
    env.serve.list("douyin");
    const older = await env.submit({ key: "a" }); // 批次逻辑时间 t0
    env.clock.advance(3600_000);
    const newer = await env.submit({ key: "b", locator: `${DOUYIN_LOCATOR}?b=1` }); // t0 + 1h，命令不同所以不复用
    expect((await run(env, newer)).kind).toBe("succeeded");
    expect((await run(env, older)).kind).toBe("succeeded");

    const [acct] = await t.db.select().from(externalAccounts);
    const profiles = await t.db.select().from(accountProfileSnapshots).orderBy(accountProfileSnapshots.profileSnapshotId);
    expect(profiles).toHaveLength(2);
    const newerBatch = (await env.root(newer)).batchId;
    const newerProfile = profiles.find((p) => p.batchId === newerBatch)!;
    expect(acct!.currentProfileSnapshotId).toBe(newerProfile.profileSnapshotId);

    const cs = await t.db.select().from(contents);
    const snaps = await t.db.select().from(contentSnapshots);
    expect(snaps).toHaveLength(40);
    const newerByContent = new Map(snaps.filter((s) => s.batchId === newerBatch).map((s) => [s.contentId, s.contentSnapshotId]));
    expect(cs.every((c) => c.currentSnapshotId === newerByContent.get(c.contentId))).toBe(true);

    const [cp] = await t.db.select().from(syncCheckpoints);
    expect(cp).toMatchObject({ lastSuccessfulBatchId: newerBatch, version: 1n });
  });
});
