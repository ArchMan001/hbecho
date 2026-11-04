// 任务 6：编排层的完整页契约（R9–R11、R14、R18；acceptance D7、D11、E4、E10、E11）。
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { useTestDb } from "../../../tests/harness/db";
import { listBytes, type SyntheticEntry } from "../../../tests/harness/list-bytes";
import { setupTracer, type TracerEnv } from "../../../tests/harness/tracer-env";
import {
  contentDiscoveries,
  contentSnapshots,
  contents,
  dataQualityIssues,
  externalAccounts,
  mediaReferences,
  syncCheckpoints,
  syncTasks,
} from "../../db/schema";
import { projectContentPage } from "../projection";
import { runTracerRoot, type ContentListProjector } from "./index";

const t = useTestDb();
const run = (env: TracerEnv, rootId: bigint, projector?: ContentListProjector) =>
  runTracerRoot({ db: t.db, clock: env.clock, gateway: env.gateway, workerId: "w1", ...(projector ? { projector } : {}) }, rootId);

async function withList(entries: SyntheticEntry[], o: Parameters<typeof listBytes>[1] = {}, limit?: number, projector?: ContentListProjector) {
  const env = await setupTracer(t);
  env.serve.profile("douyin");
  env.serve.list("douyin", listBytes(entries, o));
  const rootId = await env.submit(limit === undefined ? {} : { limit });
  const result = await run(env, rootId, projector);
  return { env, rootId, result };
}
const posts = (n: number): SyntheticEntry[] => Array.from({ length: n }, (_, i) => ({ postId: `p${i}`, createdMs: 1788169004000 - i * 1000 }));
const childOf = async (rootId: bigint) => (await t.db.select().from(syncTasks).where(eq(syncTasks.parentTaskId, rootId)))[0]!;
const checkpoints = () => t.db.select().from(syncCheckpoints);

describe("空列表是真实空页，不是技术失败（D11、E8）", () => {
  it("0 条 + has_more=false：任务成功，empty 锚点，没有内容 / 发现 / 媒资引用，没有质量问题", async () => {
    const { env, rootId, result } = await withList([], { hasMore: false, cursorJson: "0" });
    expect(result.kind).toBe("succeeded");
    expect((await checkpoints())[0]).toMatchObject({ anchorMode: "empty", highWatermarkPublishedAt: null, highWatermarkContentIds: [], cursorEnvelope: { kind: "integer", lexeme: "0" } });
    expect(await t.db.select().from(contents)).toHaveLength(0);
    expect(await t.db.select().from(dataQualityIssues)).toHaveLength(0);
    expect((await childOf(rootId))).toMatchObject({ status: "succeeded", fetchedItemCount: 0, pageCount: 1, hasMoreAtStop: false });
    expect((await env.status(rootId)).structured).toMatchObject({ returnedEntries: 0, checkpointEstablished: true });
  });
});

describe("limit 只决定是否请求下一页，不决定是否处理已返回的页（E9、E10）", () => {
  it("25 条一页、limit=1：25 条全部处理，只请求了一页", async () => {
    const { env } = await withList(posts(25), { hasMore: true, cursorJson: '"next-token"' }, 1);
    expect(await t.db.select().from(contentDiscoveries)).toHaveLength(25);
    expect(env.transport.calls).toHaveLength(2); // 主页 + 列表一页，没有第二页
  });

  it("首屏不足 limit 且 has_more=true：不请求第二页，按首屏建立基线，不记连续性缺口", async () => {
    const { env, rootId } = await withList(posts(3), { hasMore: true, cursorJson: "1782701295000" }, 20);
    expect(env.transport.calls).toHaveLength(2);
    expect(await checkpoints()).toHaveLength(1);
    expect((await childOf(rootId)).hasMoreAtStop).toBe(true);
    expect((await t.db.select().from(dataQualityIssues)).filter((i) => i.issueCode === "continuity_gap")).toHaveLength(0);
  });
});

describe("has_more=true 但游标为空 / null / 缺失（E11；与 D-53 一致）", () => {
  const cases: Array<[string, string | undefined, unknown]> = [
    ["null", "null", { kind: "null" }],
    ["空字符串", '""', { kind: "string", value: "" }],
    ["缺失", undefined, null],
  ];
  for (const [name, cursorJson, envelope] of cases) {
    it(`${name}：记质量问题，按已处理页建立基线，不再请求`, async () => {
      const { env, rootId, result } = await withList(posts(3), { hasMore: true, cursorJson });
      expect(result.kind).toBe("succeeded");
      expect(env.transport.calls).toHaveLength(2);
      expect((await checkpoints())[0]!.cursorEnvelope).toEqual(envelope);
      const issues = await t.db.select().from(dataQualityIssues);
      expect(issues.map((i) => [i.issueCode, i.severity])).toEqual([["field_contract_anomaly", "warning"]]);
      expect(issues[0]!.detail).toMatchObject({ reason: "cursor_missing_while_has_more", has_more: true });
      expect(issues[0]!.providerCallId).not.toBeNull();
      expect((await env.status(rootId)).warnings).toEqual([{ code: "field_contract_anomaly", stage: "list" }]);
    });
  }

  it("has_more=false 时空 / null 游标是正常结束，不记问题", async () => {
    for (const cursorJson of ["null", '""', undefined]) {
      const { env } = await withList(posts(2), { hasMore: false, cursorJson });
      expect(env.transport.calls).toHaveLength(2);
      expect(await t.db.select().from(dataQualityIssues)).toHaveLength(0);
    }
  });
});

describe("重复条目：全部处理，证据留在页 / 调用 lineage 与质量摘要里（D7）", () => {
  it("同一 post_id 出现 3 次：一个内容、一个发现；子任务摘要记录重复位置；质量问题可查", async () => {
    const entries: SyntheticEntry[] = [{ postId: "dup" }, { postId: "other" }, { postId: "dup" }, { postId: "dup" }];
    const { env, rootId } = await withList(entries, { hasMore: false, cursorJson: "0" });
    expect(await t.db.select().from(contents)).toHaveLength(2);
    expect(await t.db.select().from(contentDiscoveries)).toHaveLength(2);
    const child = await childOf(rootId);
    expect(child.fetchedItemCount).toBe(4); // 返回 4 条，全部计入
    expect((child.resultSummary as { duplicate_entries: unknown }).duplicate_entries).toEqual([{ platformContentId: "dup", positions: [0, 2, 3] }]);
    const issues = await t.db.select().from(dataQualityIssues);
    expect(issues.map((i) => i.issueCode)).toEqual(["field_contract_anomaly"]);
    expect(issues[0]!.detail).toMatchObject({ reason: "duplicate_list_entries", entries: [{ platform_content_id: "dup", positions: [0, 2, 3] }] });
    expect((await env.status(rootId)).structured).toMatchObject({ returnedEntries: 4, projectedEntries: 2 });
  });
});

describe("条目投影失败 / 页未处理完：检查点不前进（E4、R10.5）", () => {
  it("投影在写完全部内容之后失败：整页回滚（无内容 / 发现 / 引用 / 检查点），主页事实保留，root 以 projection 类别失败", async () => {
    const failing: ContentListProjector = {
      async projectCompletePage(tx, input) {
        await projectContentPage(tx, input); // 真的写了
        throw new Error("第 N 条投影失败（注入）");
      },
    };
    const { rootId, result, env } = await withList(posts(5), { hasMore: false, cursorJson: "0" }, undefined, failing);
    expect(result.kind).toBe("failed");
    expect(await t.db.select().from(contents)).toHaveLength(0);
    expect(await t.db.select().from(contentSnapshots)).toHaveLength(0);
    expect(await t.db.select().from(contentDiscoveries)).toHaveLength(0);
    expect(await t.db.select().from(mediaReferences).where(eq(mediaReferences.role, "cover"))).toHaveLength(0);
    expect(await checkpoints()).toHaveLength(0);
    expect(await t.db.select().from(externalAccounts)).toHaveLength(1);
    expect(await env.root(rootId)).toMatchObject({ status: "failed", lastErrorCode: "page_projection_failed" });
    expect((await env.status(rootId)).failure).toMatchObject({ category: "projection", code: "page_projection_failed" });
    expect(await childOf(rootId)).toMatchObject({ status: "failed" });
  });

  it("已处理条数小于返回条数（页没处理完）：不建立检查点，以 page_incomplete 失败", async () => {
    const lying: ContentListProjector = {
      async projectCompletePage(tx, input) {
        const r = await projectContentPage(tx, input);
        return { ...r, processedEntries: r.returnedEntries - 1 };
      },
    };
    const { rootId, result } = await withList(posts(5), { hasMore: false, cursorJson: "0" }, undefined, lying);
    expect(result.kind).toBe("failed");
    expect(await checkpoints()).toHaveLength(0);
    expect(await t.db.select().from(contents)).toHaveLength(0);
    expect((await (async () => (await t.db.select().from(syncTasks).where(eq(syncTasks.taskId, rootId)))[0]!)()).lastErrorCode).toBe("page_incomplete");
  });
});
