// 任务 5：小红书多命名空间身份纵向切片（R3–R7、R9–R11、R14、R18、R19；acceptance B、C、D、E）。
// 全部离线；真实 MySQL 8.4（一次性容器）。
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { useTestDb } from "../../../tests/harness/db";
import { bytesOf } from "../../../tests/harness/decode-helpers";
import { insertAccount, insertAssignment, insertBatch } from "../../../tests/harness/factories";
import { loadFixtureBytes } from "../../../tests/harness/fixtures";
import { LIST_PATH, PROFILE_PATH, XHS_LOCATOR, setupTracer, type TracerEnv } from "../../../tests/harness/tracer-env";
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
} from "../../db/schema";
import { jcsSha256 } from "../canonical-json";
import { EvidenceError, XHS_DOMINANT_AUTHOR_V1, bindDominantListAuthor, buildEvidence, decideDominantAuthor, evidenceDigest, parseEvidence } from "../identity";
import { cleanupExpired } from "../raw-capture";
import { DEFAULT_STRATEGIES, runTracerRoot, xiaohongshuStrategy } from "./index";

const t = useTestDb();
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest();
const AUTHOR = "5decba2300000000010007e1";
const PROFILE_ID = "49328995493";
const DAY = 24 * 3600 * 1000;

const strategies = { ...DEFAULT_STRATEGIES, xiaohongshu: xiaohongshuStrategy };
const run = (env: TracerEnv, rootId: bigint) =>
  runTracerRoot({ db: t.db, clock: env.clock, gateway: env.gateway, workerId: "w1", strategies }, rootId);

/** 把列表 fixture 里每条的 user_id 依次换成指定值（共 21 条）；null 表示空串。 */
function withAuthors(authors: Array<string | null>): Uint8Array {
  const text = new TextDecoder().decode(loadFixtureBytes("raw3.xiaohongshu.user_video_list"));
  const matches = text.match(/"user_id":\s*"[^"]*"/g) ?? [];
  expect(matches).toHaveLength(21);
  let i = 0;
  return bytesOf(text.replace(/"user_id":\s*"[^"]*"/g, () => `"user_id": ${JSON.stringify(authors[i++] ?? "")}`));
}
const repeat = (n: number, v: string | null) => Array<string | null>(n).fill(v);

async function happy(limit?: number) {
  const env = await setupTracer(t);
  env.serve.profile("xiaohongshu");
  env.serve.list("xiaohongshu");
  const rootId = await env.submit({ platform: "xiaohongshu", locator: XHS_LOCATOR, ...(limit === undefined ? {} : { limit }) });
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

describe("小红书主路径：一个账号、两个命名空间、21/21 条", () => {
  it("profile ID 与主导作者 ID 在不同命名空间，绑定到同一 ExternalAccount；evidence 随标识行长期保存", async () => {
    const { env, result } = await happy();
    expect(result.kind).toBe("succeeded");

    const accounts = await t.db.select().from(externalAccounts);
    expect(accounts).toHaveLength(1);
    const ids = await t.db.select().from(externalAccountIdentifiers).orderBy(externalAccountIdentifiers.namespaceCode);
    expect(ids.map((i) => [i.namespaceCode, i.identifierValue, i.bindingMethod, i.accountId])).toEqual([
      ["xiaohongshu.content.user_id", AUTHOR, "dominant_list_author", accounts[0]!.accountId],
      ["xiaohongshu.profile.user_id", PROFILE_ID, "same_payload", accounts[0]!.accountId],
    ]);
    // 两个标识的字符串不同，没有做任何字符串 / 昵称猜测
    expect(AUTHOR).not.toBe(PROFILE_ID);

    const [batch] = await t.db.select().from(syncBatches);
    const content = ids[0]!;
    expect(content.confidence).toBe("observed");
    expect(content.bindingPolicyVersion).toBe("xhs-dominant-author.v1");
    expect(content.evidenceBatchId).toBe(batch!.batchId);
    const evidence = parseEvidence(content.bindingEvidence);
    expect(evidence).toMatchObject({
      schema_version: "dominant-list-author-evidence.v1",
      decision: "accepted",
      reason: "unique_highest_and_policy_passed",
      policy_version: "xhs-dominant-author.v1",
      evidence_batch_id: batch!.batchId.toString(),
      candidate_identifier: { namespace: "xiaohongshu.content.user_id", value: AUTHOR, count: 21 },
      total_entry_count: 21,
      non_empty_author_entry_count: 21,
      empty_author_entry_count: 0,
      author_counts: [{ identifier: AUTHOR, count: 21 }],
    });
    expect(content.bindingEvidenceSha256!.equals(evidenceDigest(evidence))).toBe(true);
    // profile 标识没有 evidence 字段
    expect([ids[1]!.bindingPolicyVersion, ids[1]!.bindingEvidence, ids[1]!.bindingEvidenceSha256, ids[1]!.evidenceBatchId]).toEqual([null, null, null, null]);
    expect(await t.db.select().from(dataQualityIssues)).toHaveLength(0);
    expect(env.transport.calls).toHaveLength(2);
  });

  it("21/21 条全部处理（limit=5 也不截断）；没有少数作者账号；返回作者保留在内容快照里", async () => {
    const { env, rootId } = await happy(5);
    expect(await counts()).toMatchObject({ accounts: 1, contents: 21, snapshots: 21, discoveries: 21, checkpoints: 1 });
    const snaps = await t.db.select().from(contentSnapshots);
    expect(snaps.every((s) => s.returnedAuthorIdentifier === AUTHOR && s.returnedAuthorNamespaceCode === "xiaohongshu.content.user_id")).toBe(true);
    const disc = await t.db.select().from(contentDiscoveries).orderBy(contentDiscoveries.absolutePosition);
    expect(disc.map((d) => d.absolutePosition)).toEqual([...Array(21).keys()]);
    expect(disc.slice(0, 3).every((d) => d.isPotentiallyPinned) && disc.slice(3).every((d) => !d.isPotentiallyPinned)).toBe(true);
    const s = await env.status(rootId);
    expect(s.structured).toMatchObject({ returnedEntries: 21, projectedEntries: 21, discoveries: 21, cursorType: "string" });
    expect(env.transport.calls).toHaveLength(2); // limit 只决定要不要请求下一页；这里一页也没多请求
  });

  it("小红书主页不返回头像 / 背景 → 没有这两类引用；封面取单值 cover（21 条，role=cover）", async () => {
    await happy();
    const refs = await t.db.select().from(mediaReferences);
    expect(refs.filter((r) => r.profileSnapshotId !== null)).toHaveLength(0);
    expect(refs.filter((r) => r.role === "avatar" || r.role === "background")).toHaveLength(0);
    const covers = refs.filter((r) => r.role === "cover");
    expect(covers).toHaveLength(21);
    expect(covers.every((c) => c.slotIndex === 0 && c.archiveStatus === "pending" && /^\$\.data\.result\.result\[\d+\]\.cover$/.test(c.sourceJsonPath ?? ""))).toBe(true);
    expect(refs).toHaveLength(21);
  });

  it("游标保持字符串（不转整数）；time 锚点；请求回发的首页游标是整数 0", async () => {
    const { env } = await happy();
    const [cp] = await t.db.select().from(syncCheckpoints);
    expect(cp!.cursorEnvelope).toEqual({ kind: "string", value: "6a5098aa000000001603fb07" });
    expect(cp).toMatchObject({ anchorMode: "time", continuityStatus: "ready", version: 1n });
    expect(cp!.cursorSha256!.equals(jcsSha256({ kind: "string", value: "6a5098aa000000001603fb07" }))).toBe(true);
    expect(new TextDecoder().decode(env.transport.calls[1]!.request.body!)).toContain('"max_cursor":0');
  });

  it("第二个批次重复提交：首次绑定的 evidence 不被覆盖，只更新观察时间", async () => {
    const { env } = await happy();
    const before = (await t.db.select().from(externalAccountIdentifiers).where(eq(externalAccountIdentifiers.namespaceCode, "xiaohongshu.content.user_id")))[0]!;
    env.clock.advance(DAY);
    const second = await env.submit({ platform: "xiaohongshu", locator: XHS_LOCATOR, key: "again" });
    expect((await run(env, second)).kind).toBe("succeeded");
    const after = (await t.db.select().from(externalAccountIdentifiers).where(eq(externalAccountIdentifiers.namespaceCode, "xiaohongshu.content.user_id")))[0]!;
    expect(after.evidenceBatchId).toBe(before.evidenceBatchId);
    expect(after.bindingEvidenceSha256!.equals(before.bindingEvidenceSha256!)).toBe(true);
    expect(after.lastSeenAt.getTime()).toBeGreaterThan(before.lastSeenAt.getTime());
    expect(await t.db.select().from(externalAccountIdentifiers)).toHaveLength(2);
  });
});

describe("主导作者策略：少数作者与拒绝", () => {
  it("20 条同一作者 + 1 条少数作者：仍通过（20/21），少数作者只进内容快照，不建账号、不绑标识", async () => {
    const env = await setupTracer(t);
    env.serve.profile("xiaohongshu");
    env.serve.list("xiaohongshu", withAuthors([...repeat(20, AUTHOR), "minorauthor0000000000001"]));
    const rootId = await env.submit({ platform: "xiaohongshu", locator: XHS_LOCATOR });
    expect((await run(env, rootId)).kind).toBe("succeeded");
    expect(await t.db.select().from(externalAccounts)).toHaveLength(1);
    const ids = await t.db.select().from(externalAccountIdentifiers);
    expect(ids.map((i) => i.identifierValue).sort()).toEqual([PROFILE_ID, AUTHOR].sort());
    const snaps = await t.db.select().from(contentSnapshots);
    expect(snaps.filter((s) => s.returnedAuthorIdentifier === "minorauthor0000000000001")).toHaveLength(1);
    const evidence = parseEvidence(ids.find((i) => i.identifierValue === AUTHOR)!.bindingEvidence);
    expect(evidence.author_counts).toEqual([
      { identifier: AUTHOR, count: 20 },
      { identifier: "minorauthor0000000000001", count: 1 },
    ]);
    expect(evidence.candidate_identifier).toMatchObject({ value: AUTHOR, count: 20 });
    expect(await t.db.select().from(dataQualityIssues)).toHaveLength(0);
  });

  const rejections: Array<{ name: string; authors: Array<string | null>; reason: string }> = [
    { name: "并列最高", authors: [...repeat(10, "authorAAAAAAAAAAAAAAAAAAA"), ...repeat(10, "authorBBBBBBBBBBBBBBBBBBB"), null], reason: "tie_for_highest" },
    { name: "全部作者为空", authors: repeat(21, null), reason: "no_non_empty_author" },
    { name: "唯一最高但低于 80%", authors: [...repeat(15, AUTHOR), ...repeat(6, "authorBBBBBBBBBBBBBBBBBBB")], reason: "below_threshold" },
    { name: "只有 1 条非空 + 20 条空（样本不足）", authors: [AUTHOR, ...repeat(20, null)], reason: "insufficient_samples" },
  ];
  for (const r of rejections) {
    it(`${r.name} → 不绑定、不创建猜测标识；rejected evidence 与问题可见；内容与检查点照常投影`, async () => {
      const env = await setupTracer(t);
      env.serve.profile("xiaohongshu");
      env.serve.list("xiaohongshu", withAuthors(r.authors));
      const rootId = await env.submit({ platform: "xiaohongshu", locator: XHS_LOCATOR });
      expect((await run(env, rootId)).kind).toBe("succeeded");

      const ids = await t.db.select().from(externalAccountIdentifiers);
      expect(ids.map((i) => i.namespaceCode)).toEqual(["xiaohongshu.profile.user_id"]); // 只有 profile 标识
      const [issue] = await t.db.select().from(dataQualityIssues);
      expect(issue).toMatchObject({ issueCode: "dominant_author_rejected", severity: "warning", status: "open" });
      const [batch] = await t.db.select().from(syncBatches);
      expect(issue!.batchId).toBe(batch!.batchId);
      expect(issue!.accountId).toBe((await t.db.select().from(externalAccounts))[0]!.accountId);
      expect(issue!.providerCallId).not.toBeNull();
      const evidence = parseEvidence(issue!.detail);
      expect(evidence).toMatchObject({ decision: "rejected", reason: r.reason, policy_version: "xhs-dominant-author.v1", candidate_identifier: null, total_entry_count: 21, evidence_batch_id: batch!.batchId.toString() });
      expect(evidence.non_empty_author_entry_count + evidence.empty_author_entry_count).toBe(21);
      expect(evidence.author_counts.reduce((n, c) => n + c.count, 0)).toBe(evidence.non_empty_author_entry_count);

      expect(await counts()).toMatchObject({ contents: 21, discoveries: 21, checkpoints: 1, accounts: 1 });
      const s = await env.status(rootId);
      expect(s.qualityIssues).toEqual([{ code: "dominant_author_rejected", status: "open" }]);
      expect(s.warnings).toEqual([{ code: "dominant_author_rejected", stage: "identity" }]);
    });
  }
});

describe("一年后：ODS lineage 清理，成功 / 拒绝的决定仍能由长期事实解释", () => {
  it("成功绑定：清理 task / call / raw 后，标识行里的 evidence、策略版本、批次引用、摘要仍完整可验证", async () => {
    const { env } = await happy();
    expect((await t.db.select().from(odsProviderCalls)).length).toBe(2);
    env.clock.advance(366 * DAY);
    const report = await cleanupExpired({ db: t.db, store: env.store, clock: env.clock });
    expect(report.callsDeleted).toBe(2);
    expect(await t.db.select().from(odsProviderCalls)).toHaveLength(0);
    expect(env.store.keys("ods/")).toHaveLength(0);

    const row = (await t.db.select().from(externalAccountIdentifiers).where(eq(externalAccountIdentifiers.namespaceCode, "xiaohongshu.content.user_id")))[0]!;
    const evidence = parseEvidence(row.bindingEvidence);
    expect(evidence).toMatchObject({ decision: "accepted", policy_version: "xhs-dominant-author.v1", candidate_identifier: { value: AUTHOR, count: 21 } });
    expect(row.bindingEvidenceSha256!.equals(evidenceDigest(evidence))).toBe(true);
    const [batch] = await t.db.select().from(syncBatches).where(eq(syncBatches.batchId, row.evidenceBatchId!));
    expect(batch).toBeDefined(); // 长期批次引用仍在
    expect(evidence.evidence_batch_id).toBe(batch!.batchId.toString());
    expect(row.bindingPolicyVersion).toBe(evidence.policy_version);
  });

  it("拒绝决定：清理后问题行的 detail 仍是完整 rejected evidence，来源调用引用被置空", async () => {
    const env = await setupTracer(t);
    env.serve.profile("xiaohongshu");
    env.serve.list("xiaohongshu", withAuthors([...repeat(10, "authorAAAAAAAAAAAAAAAAAAA"), ...repeat(10, "authorBBBBBBBBBBBBBBBBBBB"), null]));
    const rootId = await env.submit({ platform: "xiaohongshu", locator: XHS_LOCATOR });
    await run(env, rootId);
    env.clock.advance(366 * DAY);
    await cleanupExpired({ db: t.db, store: env.store, clock: env.clock });
    const [issue] = await t.db.select().from(dataQualityIssues);
    expect(issue!.providerCallId).toBeNull();
    expect(parseEvidence(issue!.detail)).toMatchObject({ decision: "rejected", reason: "tie_for_highest", total_entry_count: 21 });
  });
});

describe("evidence 写入前的校验（受限身份写入）", () => {
  const evidenceFor = (batchId: bigint, authors = repeat(21, AUTHOR)) =>
    buildEvidence(decideDominantAuthor(authors, XHS_DOMINANT_AUTHOR_V1), { batchId, namespace: "xiaohongshu.content.user_id" });

  async function setup() {
    const env = await setupTracer(t);
    const accountId = await insertAccount(t.db, "xiaohongshu", env.clock.now());
    const batchId = await insertBatch(t.db, env.clock.now());
    const bind = (evidence: unknown, batch = batchId) =>
      t.db.transaction((tx) => bindDominantListAuthor(tx, { accountId, evidence, batchId: batch, now: env.clock.now() }));
    return { env, accountId, batchId, bind };
  }

  it("合法 evidence：method / policy / evidence / 摘要 / 批次都由 evidence 推出，写入同一行", async () => {
    const { bind, batchId, accountId } = await setup();
    expect((await bind(evidenceFor(batchId))).kind).toBe("bound");
    const [row] = await t.db.select().from(externalAccountIdentifiers);
    expect(row).toMatchObject({ accountId, namespaceCode: "xiaohongshu.content.user_id", identifierValue: AUTHOR, bindingMethod: "dominant_list_author", bindingPolicyVersion: "xhs-dominant-author.v1", evidenceBatchId: batchId });
    expect(row!.bindingEvidenceSha256!.equals(evidenceDigest(parseEvidence(row!.bindingEvidence)))).toBe(true);
  });

  it("重放同一个绑定：already_bound，首次证据不被改写", async () => {
    const { bind, batchId } = await setup();
    await bind(evidenceFor(batchId));
    const first = (await t.db.select().from(externalAccountIdentifiers))[0]!;
    expect((await bind(evidenceFor(batchId, [...repeat(20, AUTHOR), "other0000000000000000000"]))).kind).toBe("already_bound");
    const after = (await t.db.select().from(externalAccountIdentifiers))[0]!;
    expect(after.bindingEvidenceSha256!.equals(first.bindingEvidenceSha256!)).toBe(true);
  });

  it("拒绝：rejected 决定、计数和不一致、未知字段、批次与参数不一致；一行都不写", async () => {
    const { bind, batchId } = await setup();
    const rejected = evidenceFor(batchId, repeat(21, null));
    await expect(bind(rejected)).rejects.toThrow("accepted");
    await expect(bind({ ...evidenceFor(batchId), non_empty_author_entry_count: 20 })).rejects.toThrow(EvidenceError);
    await expect(bind({ ...evidenceFor(batchId), extra: 1 })).rejects.toThrow(EvidenceError);
    await expect(bind(evidenceFor(batchId + 1n))).rejects.toThrow("batch");
    expect(await t.db.select().from(externalAccountIdentifiers)).toHaveLength(0);
  });

  it("该内容作者标识已绑定到另一个账号：不改绑，报告冲突", async () => {
    const { env, bind, batchId } = await setup();
    await bind(evidenceFor(batchId));
    const other = await insertAccount(t.db, "xiaohongshu", env.clock.now());
    const r = await t.db.transaction((tx) => bindDominantListAuthor(tx, { accountId: other, evidence: evidenceFor(batchId), batchId, now: env.clock.now() }));
    expect(r.kind).toBe("bound_to_other_account");
    expect(await t.db.select().from(externalAccountIdentifiers)).toHaveLength(1);
  });
});

describe("入口与归属：与抖音同一语义，且没有错误 owner 或后续付费副作用", () => {
  const VALIDATION_FAILED = () => loadFixtureBytes("raw7.C20.http500");

  it("平台错配（小红书命令 + 抖音链接）：拒绝，调用 0，无任何业务身份", async () => {
    const env = await setupTracer(t);
    const rootId = await env.submit({ platform: "xiaohongshu", locator: "https://v.douyin.com/MPOAlEqWpec/" });
    expect((await run(env, rootId)).kind).toBe("failed");
    expect(env.transport.calls).toHaveLength(0);
    expect(await counts()).toEqual(ZERO);
    expect((await env.root(rootId))).toMatchObject({ stopReason: "invalid_link", lastErrorCode: "platform_mismatch" });
  });

  it("笔记链接（explore / discovery/item）：非主页入口，调用 0", async () => {
    for (const locator of ["https://www.xiaohongshu.com/explore/65abc", "https://www.xiaohongshu.com/discovery/item/65abc"]) {
      const env = await setupTracer(t);
      const rootId = await env.submit({ platform: "xiaohongshu", locator });
      expect((await run(env, rootId)).kind).toBe("failed");
      expect(env.transport.calls).toHaveLength(0);
      expect(await counts()).toEqual(ZERO);
      expect((await env.status(rootId)).entryOutcome).toBe("invalid_link");
    }
  });

  it("连续三次 RESULT_VALIDATION_FAILED：invalid_link，三条独立调用，无业务身份", async () => {
    const env = await setupTracer(t);
    env.serve.profile("xiaohongshu", VALIDATION_FAILED(), 500);
    env.transport.register({ path: PROFILE_PATH, query: { async: "true" } }, { httpStatus: 500, body: VALIDATION_FAILED() }); // 第 2、3 次改走异步
    const rootId = await env.submit({ platform: "xiaohongshu", locator: XHS_LOCATOR });
    expect((await run(env, rootId)).kind).toBe("failed");
    expect(await t.db.select().from(odsProviderCalls)).toHaveLength(3);
    expect(await counts()).toEqual(ZERO);
    expect((await env.status(rootId)).entryOutcome).toBe("invalid_link");
  });

  it("账号已归属他人：原 owner 不变，只调主页 1 次，没有内容 / 检查点 / content 标识", async () => {
    const env = await setupTracer(t);
    env.serve.profile("xiaohongshu");
    env.serve.list("xiaohongshu");
    const accountId = await insertAccount(t.db, "xiaohongshu", env.clock.now());
    const assignmentId = await insertAssignment(t.db, { accountId, platform: "xiaohongshu", staffId: env.org.staffB, now: env.clock.now() });
    await t.db.insert(externalAccountIdentifiers).values({
      accountId,
      namespaceCode: "xiaohongshu.profile.user_id",
      identifierValue: PROFILE_ID,
      identifierSha256: sha(PROFILE_ID),
      bindingMethod: "same_payload",
      confidence: "observed",
      firstSeenAt: env.clock.now(),
      lastSeenAt: env.clock.now(),
      createdAt: env.clock.now(),
    });
    const rootId = await env.submit({ platform: "xiaohongshu", locator: XHS_LOCATOR, staffId: env.org.staffA });
    expect((await run(env, rootId)).kind).toBe("blocked");
    expect(env.transport.calls).toHaveLength(1);
    expect((await t.db.select().from(staffAccountAssignments))[0]).toMatchObject({ assignmentId, staffId: env.org.staffB });
    expect(await counts()).toMatchObject({ profiles: 0, contents: 0, discoveries: 0, checkpoints: 0, assignments: 1, identifiers: 1 });
    expect((await env.status(rootId)).state).toBe("blocked_assignment_conflict");
  });

  it("同一专员在小红书已占用名额：第二个账号阻塞，无新账号 / 归属 / 标识", async () => {
    const env = await setupTracer(t);
    env.serve.profile("xiaohongshu");
    const other = await insertAccount(t.db, "xiaohongshu", env.clock.now());
    await insertAssignment(t.db, { accountId: other, platform: "xiaohongshu", staffId: env.org.staffA, now: env.clock.now() });
    const rootId = await env.submit({ platform: "xiaohongshu", locator: XHS_LOCATOR, staffId: env.org.staffA });
    expect((await run(env, rootId)).kind).toBe("blocked");
    expect(env.transport.calls).toHaveLength(1);
    expect(await t.db.select().from(externalAccounts)).toHaveLength(1);
    expect(await t.db.select().from(externalAccountIdentifiers)).toHaveLength(0);
  });

  it("疑似空账号（粉丝 0 且作品 0）：写问题、intake_status=suspected_empty，不发列表、无检查点", async () => {
    const env = await setupTracer(t);
    const text = new TextDecoder().decode(loadFixtureBytes("raw3.xiaohongshu.media_user_info"));
    env.serve.profile("xiaohongshu", bytesOf(text.replace(/"(follower_number|follower_count|post_number|post_count)":\s*"?\d+"?/g, '"$1": 0')));
    env.serve.list("xiaohongshu");
    const rootId = await env.submit({ platform: "xiaohongshu", locator: XHS_LOCATOR });
    expect((await run(env, rootId)).kind).toBe("succeeded");
    expect(env.transport.calls).toHaveLength(1);
    expect((await t.db.select().from(staffAccountAssignments))[0]!.intakeStatus).toBe("suspected_empty");
    expect((await t.db.select().from(dataQualityIssues)).map((i) => i.issueCode)).toEqual(["suspected_empty_account"]);
    expect(await counts()).toMatchObject({ contents: 0, checkpoints: 0 });
    expect((await env.status(rootId)).entryOutcome).toBe("suspected_empty");
  });

  it("请求形态：同步、profile 与 list 路径正确", async () => {
    const { env } = await happy();
    expect(env.transport.calls.map((c) => [c.request.path, c.request.query.async])).toEqual([
      [PROFILE_PATH, "false"],
      [LIST_PATH, "false"],
    ]);
  });
});
