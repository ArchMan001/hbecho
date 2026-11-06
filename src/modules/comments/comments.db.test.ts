// 评论（FS-10；acceptance J）：一级评论最新态、完整性口径、疑似删除与恢复、覆盖不完整的质量问题。全程离线。
// 真实响应取自 raw4.C07（抖音 20 条、has_more=1）、raw9.A4.poll1（小红书 total=28 只返回 2 条）、raw4.C08（小红书间歇 500）；
// 第二页等合成响应用 tests/harness/list-bytes.ts 的 commentsBytes（结构取自 C07，合成）。
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { serviceActor } from "../../../tests/harness/actors";
import { useTestDb } from "../../../tests/harness/db";
import { FakeRuleSource } from "../../../tests/harness/fake-rule-source";
import { loadFixtureBytes } from "../../../tests/harness/fixtures";
import { commentsBytes, type SyntheticComment } from "../../../tests/harness/list-bytes";
import { nextRound, runPeriodic } from "../../../tests/harness/periodic";
import { COMMENTS_PATH, setupSync, type SyncEnv } from "../../../tests/harness/sync-env";
import { comments, contentSnapshots, contents, dataQualityIssues, staffAccountAssignments, syncSettings, syncTasks } from "../../db/schema";
import { createAccountRunners, createDemandRunners } from "../sync-runner";

const t = useTestDb();
const DY_POST = "7676403385372904742";
const XHS_POST = "6a869a5c0000000014028682";
const runAll = (env: SyncEnv) => env.worker({ ...createAccountRunners(env.deps), ...createDemandRunners(env.deps) }).run({ untilIdle: true });
const commentCursors = (env: SyncEnv) => env.transport.calls.filter((c) => c.request.path === COMMENTS_PATH).map((c) => /"max_cursor":("(?:[^"\\]|\\.)*"|[^,}]*)/.exec(new TextDecoder().decode(c.request.body!))?.[1]);
const rows = async (contentId: bigint) => (await t.db.select().from(comments).where(eq(comments.contentId, contentId))).sort((a, b) => a.platformCommentId.localeCompare(b.platformCommentId));
const issues = (code: string) => t.db.select().from(dataQualityIssues).then((r) => r.filter((i) => i.issueCode === code));
const commentsTask = async () => (await t.db.select().from(syncTasks).where(eq(syncTasks.requestedAction, "fetch_comments")).orderBy(syncTasks.taskId)).at(-1)!;
type Final = { complete: boolean; coverage: string; fetched: number; reported_total: string | null; suspected_deleted_marked: number };
const finalOf = (task: { resultSummary: unknown }) => (task.resultSummary as { final: Final; ignored_replies: number; pages_done: number }).final;

async function world() {
  const env = await setupSync(t);
  const [dy, xhs] = await runPeriodic(t, env, [
    { platform: "douyin", staffId: env.org.staffA, postIds: [DY_POST] },
    { platform: "xiaohongshu", staffId: env.org.staffB, postIds: [XHS_POST] },
  ]);
  const cid = { dy: dy!.contentIds.get(DY_POST)!, xhs: xhs!.contentIds.get(XHS_POST)! };
  return { env, cid, source: new FakeRuleSource(env.demand, serviceActor()) };
}
const c = (id: string, extra: Partial<SyntheticComment> = {}): SyntheticComment => ({ id, postId: DY_POST, ...extra });
/** 抖音两页：第 1 页是真实 C07（20 条，has_more=1，游标 "20"），第 2 页合成。 */
const douyinTwoPages = (env: SyncEnv, page2: SyntheticComment[]) => {
  env.routeComments(({ cursor }) => (cursor === "0" ? loadFixtureBytes("raw4.C07") : commentsBytes(page2, { hasMore: false, cursorJson: '""', total: 125 })));
};

describe("抖音：自然翻完是完整抓取", () => {
  it("两页翻完：游标 \"20\" 作为字符串回发；一级评论入库、回复被忽略并计数；完整 → coverage=complete；不动内容快照（FS-10.7）", async () => {
    const { env, cid, source } = await world();
    douyinTwoPages(env, [c("p2-a"), c("p2-b"), c("reply-1", { parentId: "p2-a" }), c("reply-2", { parentId: "p2-a" })]);
    const snapsBefore = await t.db.select().from(contentSnapshots).where(eq(contentSnapshots.contentId, cid.dy));
    const r = await source.request([{ contentId: cid.dy, wants: ["comments"] }]);
    await runAll(env);

    expect(commentCursors(env)).toEqual(["0", '"20"']);
    const task = await commentsTask();
    expect(task).toMatchObject({ status: "succeeded", stopReason: "natural_end", pageCount: 2 });
    expect(finalOf(task)).toMatchObject({ complete: true, coverage: "complete", fetched: 22, suspected_deleted_marked: 0 });
    expect((task.resultSummary as { ignored_replies: number }).ignored_replies).toBeGreaterThanOrEqual(2);
    expect(await rows(cid.dy)).toHaveLength(22);
    expect((await rows(cid.dy)).every((x) => x.status === "active")).toBe(true);
    expect((await rows(cid.dy)).some((x) => x.platformCommentId.startsWith("reply"))).toBe(false); // 回复不入库
    // 内容快照与 current 不变
    expect(await t.db.select().from(contentSnapshots).where(eq(contentSnapshots.contentId, cid.dy))).toEqual(snapsBefore);
    // get：评论指针（抓取时间、覆盖口径、条数、平台报告总数）
    const view = await env.demand.get(r.batchId, serviceActor());
    expect(view.items[0]).toMatchObject({ state: "ready", pointers: { comments: { coverage: "complete", fetchedCount: 22, reportedTotal: "125" } } });
  });

  it("下一轮抓取少了一条 → 疑似删除（完整抓取）；再下一轮又出现 → 恢复 active、清除疑似删除时间；幂等：不产生重复行", async () => {
    const { env, cid, source } = await world();
    douyinTwoPages(env, [c("p2-a"), c("p2-b")]);
    await source.request([{ contentId: cid.dy, wants: ["comments"] }]);
    await runAll(env);
    expect(await rows(cid.dy)).toHaveLength(22);

    await nextRound(t, env);
    env.transport.clearRoutes();
    douyinTwoPages(env, [c("p2-a")]); // p2-b 不见了
    await source.request([{ contentId: cid.dy, wants: ["comments"] }]);
    await runAll(env);
    const gone = (await rows(cid.dy)).find((x) => x.platformCommentId === "p2-b")!;
    expect(gone).toMatchObject({ status: "suspected_deleted" });
    expect(gone.suspectedDeletedAt).not.toBeNull();
    expect((await rows(cid.dy)).filter((x) => x.status === "active")).toHaveLength(21);
    expect(finalOf(await commentsTask())).toMatchObject({ suspected_deleted_marked: 1 });
    expect(await rows(cid.dy)).toHaveLength(22); // 没有重复行

    await nextRound(t, env);
    env.transport.clearRoutes();
    douyinTwoPages(env, [c("p2-a"), c("p2-b")]);
    await source.request([{ contentId: cid.dy, wants: ["comments"] }]);
    await runAll(env);
    const back = (await rows(cid.dy)).find((x) => x.platformCommentId === "p2-b")!;
    expect(back).toMatchObject({ status: "active", suspectedDeletedAt: null });
  });

  it("触达 page_limit：不标记疑似删除，记 comment_coverage_incomplete(page_limit)，coverage=partial", async () => {
    const { env, cid, source } = await world();
    await t.db.update(syncSettings).set({ commentPageLimit: 1 });
    // 先放一条「以前见过」的评论，若被错误标记就会暴露
    await t.db.insert(comments).values({ contentId: cid.dy, platformCommentId: "old", platformCommentIdSha256: Buffer.alloc(32, 9), status: "active", likeState: "missing", replyState: "missing", firstSeenAt: new Date(0), lastSeenAt: new Date(1), createdAt: new Date(0), updatedAt: new Date(0) });
    douyinTwoPages(env, [c("never-requested")]);
    await source.request([{ contentId: cid.dy, wants: ["comments"] }]);
    await runAll(env);
    expect(commentCursors(env)).toEqual(["0"]); // 只请求了第 1 页
    const task = await commentsTask();
    expect(task).toMatchObject({ status: "succeeded", stopReason: "page_limit" });
    expect(finalOf(task)).toMatchObject({ complete: false, coverage: "partial", suspected_deleted_marked: 0 });
    expect((await rows(cid.dy)).find((x) => x.platformCommentId === "old")!.status).toBe("active");
    expect((await issues("comment_coverage_incomplete"))[0]!.detail).toMatchObject({ reason: "page_limit", fetched: 20, reported_total: "125" });
  });

  it("total>0 而结果为空数组：comments_total_mismatch，不当作 0 条评论，也不把已有评论标成疑似删除", async () => {
    const { env, cid, source } = await world();
    await t.db.insert(comments).values({ contentId: cid.dy, platformCommentId: "old", platformCommentIdSha256: Buffer.alloc(32, 9), status: "active", likeState: "missing", replyState: "missing", firstSeenAt: new Date(0), lastSeenAt: new Date(1), createdAt: new Date(0), updatedAt: new Date(0) });
    env.routeComments(() => commentsBytes([], { hasMore: false, cursorJson: '"0"', total: 5 }));
    await source.request([{ contentId: cid.dy, wants: ["comments"] }]);
    await runAll(env);
    expect(await issues("comments_total_mismatch")).toHaveLength(1);
    expect((await rows(cid.dy))[0]).toMatchObject({ status: "active" });
    expect(finalOf(await commentsTask())).toMatchObject({ complete: false, fetched: 0 });
  });

  it("total=0 且自然翻完：确实没有评论，已有评论才标记疑似删除", async () => {
    const { env, cid, source } = await world();
    await t.db.insert(comments).values({ contentId: cid.dy, platformCommentId: "old", platformCommentIdSha256: Buffer.alloc(32, 9), status: "active", likeState: "missing", replyState: "missing", firstSeenAt: new Date(0), lastSeenAt: new Date(1), createdAt: new Date(0), updatedAt: new Date(0) });
    env.routeComments(() => loadFixtureBytes("raw10.V4"));
    await source.request([{ contentId: cid.dy, wants: ["comments"] }]);
    await runAll(env);
    expect((await rows(cid.dy))[0]).toMatchObject({ status: "suspected_deleted" });
    expect(await issues("comments_total_mismatch")).toHaveLength(0);
  });

  it("评论的值状态：点赞 null 保持 explicit_null，真实 0 保持 0；评论 ID 缺失 / 非法的条目计数并留问题，不阻塞其余", async () => {
    const { env, cid, source } = await world();
    env.routeComments(() => commentsBytes([c("x1", { like: null }), c("x2", { like: 0 }), { id: "" } as SyntheticComment], { hasMore: false, cursorJson: '""', total: 3 }));
    await source.request([{ contentId: cid.dy, wants: ["comments"] }]);
    await runAll(env);
    const r = await rows(cid.dy);
    expect(r.map((x) => [x.platformCommentId, x.likeState, x.likeValue])).toEqual([["x1", "explicit_null", null], ["x2", "value", 0n]]);
    expect((await issues("field_contract_anomaly"))[0]!.detail).toMatchObject({ reason: "comment_id_unusable" });
  });
});

describe("小红书：永远不算完整（D-50）", () => {
  it("total=28 只返回 2 条（raw9.A4.poll1）：不标记疑似删除，记 comment_coverage_incomplete(platform_partial)，coverage=partial", async () => {
    const { env, cid, source } = await world();
    await t.db.insert(comments).values({ contentId: cid.xhs, platformCommentId: "old", platformCommentIdSha256: Buffer.alloc(32, 7), status: "active", likeState: "missing", replyState: "missing", firstSeenAt: new Date(0), lastSeenAt: new Date(1), createdAt: new Date(0), updatedAt: new Date(0) });
    env.routeComments(() => loadFixtureBytes("raw9.A4.poll1"));
    await source.request([{ contentId: cid.xhs, wants: ["comments"] }]);
    await runAll(env);
    const task = await commentsTask();
    expect(finalOf(task)).toMatchObject({ complete: false, coverage: "partial", fetched: 2, reported_total: "28", suspected_deleted_marked: 0 });
    expect((await rows(cid.xhs)).find((x) => x.platformCommentId === "old")!.status).toBe("active");
    expect((await issues("comment_coverage_incomplete"))[0]!.detail).toMatchObject({ reason: "platform_partial", reported_total: "28", fetched: 2 });
  });

  it("间歇性 RESULT_VALIDATION_FAILED：任务回队尾（retry_wait），之后重试成功，不在进程内原地重试（raw4.C08）", async () => {
    const { env, cid, source } = await world();
    let calls = 0;
    env.routeComments(() => (calls++ === 0 ? { httpStatus: 500, body: loadFixtureBytes("raw4.C08.attempt1.http500") } : loadFixtureBytes("raw4.C08.attempt2")));
    await source.request([{ contentId: cid.xhs, wants: ["comments"] }]);
    await runAll(env);
    expect(await commentsTask()).toMatchObject({ status: "retry_wait", lastErrorCode: "provider_validation_failed", attemptCount: 1 });
    expect(commentCursors(env)).toHaveLength(1);
    env.clock.advance(10 * 60_000);
    await runAll(env);
    expect(await commentsTask()).toMatchObject({ status: "succeeded", attemptCount: 1 });
    expect((await rows(cid.xhs)).length).toBe(1);
  });
});

describe("崩溃恢复与门禁", () => {
  it("第 1 页提交后丢进程：重新领取后从已提交页的下一游标继续，第 1 页不重复请求", async () => {
    let crashed = false;
    let armed = false; // 周期列表也会走 afterPageProjection：只在评论阶段才丢进程
    const env = await setupSync(t, {
      runnerHooks: {
        afterPageProjection: () => {
          if (armed && !crashed) {
            crashed = true;
            throw new Error("进程丢失");
          }
        },
      },
    });
    const [dy] = await runPeriodic(t, env, [{ platform: "douyin", staffId: env.org.staffA, postIds: [DY_POST] }]);
    const cid = dy!.contentIds.get(DY_POST)!;
    douyinTwoPages(env, [c("p2-a")]);
    await new FakeRuleSource(env.demand, serviceActor()).request([{ contentId: cid, wants: ["comments"] }]);
    armed = true;
    await runAll(env);
    expect(await commentsTask()).toMatchObject({ status: "retry_wait", pageCount: 1 });
    env.clock.advance(10 * 60_000);
    await runAll(env);
    expect(commentCursors(env)).toEqual(["0", '"20"']);
    expect(await commentsTask()).toMatchObject({ status: "succeeded", pageCount: 2 });
    expect(await rows(cid)).toHaveLength(21);
  });

  it("领取时监控资格复核：账号监控被关闭 → 评论任务 cancelled/monitoring_closed，零调用", async () => {
    const { env, cid, source } = await world();
    env.routeComments(() => loadFixtureBytes("raw4.C07"));
    await source.request([{ contentId: cid.dy, wants: ["comments"] }]);
    const [content] = await t.db.select().from(contents).where(eq(contents.contentId, cid.dy));
    await t.db.update(staffAccountAssignments).set({ monitoringEnabled: false, monitoringClosedReason: "manual" }).where(eq(staffAccountAssignments.accountId, content!.accountId));
    await runAll(env);
    expect(await commentsTask()).toMatchObject({ status: "cancelled", lastErrorCode: "monitoring_closed" });
    expect(commentCursors(env)).toHaveLength(0);
  });
});


describe("技术失败不标记任何评论（J6、FS-10.4）", () => {
  it("上一轮完整抓取后，这一轮传输失败（5xx）/ 解析失败：已有评论一条都不被标 suspected_deleted，也不写出新的最终覆盖口径", async () => {
    const { env, cid, source } = await world();
    douyinTwoPages(env, [c("p2-a"), c("p2-b")]);
    await source.request([{ contentId: cid.dy, wants: ["comments"] }]);
    await runAll(env);
    expect(await rows(cid.dy)).toHaveLength(22);
    for (const bytes of [{ httpStatus: 500, body: loadFixtureBytes("raw7.C20.http500") }, { httpStatus: 200, body: new TextEncoder().encode("not json at all") }]) {
      await nextRound(t, env);
      env.transport.clearRoutes();
      env.routeComments(() => bytes);
      await source.request([{ contentId: cid.dy, wants: ["comments"] }]);
      await runAll(env);
      const task = await commentsTask();
      expect(["retry_wait", "failed", "dead"]).toContain(task.status);
      expect((await rows(cid.dy)).filter((x) => x.status === "suspected_deleted")).toHaveLength(0);
      expect(await rows(cid.dy)).toHaveLength(22);
    }
  });
});
