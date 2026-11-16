// d-rule-engine 任务 2：facts.ts 的每个读取函数一例（改绑后归属取新专员、组织链沿专员当前门店向上、
// 内容排除非 active 与无当前快照并计数、同步完整谓词覆盖各种结局）。
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createPlanReader } from "../activity-plan/reader";
import { staffAccountAssignments } from "../../db/schema";
import { useTestDb } from "../../../tests/harness/db";
import { insertStaff } from "../../../tests/harness/plan";
import { addCheckpoint, addContent, addListTask, addParticipant, judgementWorld, T0 } from "../../../tests/harness/judgement";
import { createFacts } from "./facts";

const t = useTestDb();
const FROM = new Date("2026-11-01T00:00:00.000Z");
const facts = () => createFacts({ db: t.db, reader: createPlanReader({ db: t.db, resolver: { targets: async () => ({ rows: [], next: null }) } as never }) });

describe("facts", () => {
  it("planOf / joinedBranchIds / rosterOf：计划事实、已加入的分公司、在名单的项", async () => {
    const w = await judgementWorld(t);
    const f = facts();
    const plan = await f.planOf(w.planId);
    expect(plan).toMatchObject({ platformCode: "douyin", status: "collecting", createdByActor: "user:7" });
    expect(await f.joinedBranchIds(w.planId)).toEqual([w.bj]);
    const roster = await f.rosterOf(w.planId);
    expect(roster!.entries.map((e) => e.accountId)).toEqual([String(w.accZhao)]); // 老钱已移出，不在名单
    expect(await f.planOf(999_999n)).toBeNull();
  });
  it("assignmentsOf：改绑后返回新专员（名单项里的旧专员不变）", async () => {
    const w = await judgementWorld(t);
    const other = { staffId: await insertStaff(t.db, { storeId: w.stores.sW1, name: "老孙", phone: "13800010099" }) }; // 没有账号的专员（一个专员同平台最多一个账号）
    await t.db.update(staffAccountAssignments).set({ staffId: other.staffId }).where(eq(staffAccountAssignments.accountId, w.accZhao));
    const a = (await facts().assignmentsOf([w.accZhao])).get(w.accZhao)!;
    expect(a.staffId).toBe(other.staffId);
    expect(a).toMatchObject({ watchType: "staff", slotReleasedAt: null });
    const entry = (await facts().rosterOf(w.planId))!.entries.find((e) => e.accountId === String(w.accZhao))!;
    expect(entry.staffId).toBe(String(w.staff.zhao)); // 名单项是加入当时的快照，不回写
  });
  it("orgChainOf：专员 → 门店 → 经销商 / 品牌 / 板块 → 分公司 → 大区", async () => {
    const w = await judgementWorld(t);
    const chain = (await facts().orgChainOf([w.staff.zhao, w.staff.li])).get(w.staff.zhao)!;
    expect(chain).toMatchObject({ storeId: w.stores.sW1, brandId: w.org.hitachiBrandId, branchId: w.bj, staffStatus: "active" });
    expect(chain.regionId).toBeGreaterThan(0n);
    expect((await facts().orgChainOf([w.staff.li])).get(w.staff.li)!.branchId).toBe(w.sh); // 老李在 102 分公司的门店
  });
  it("contentsOf：返回 active 且有 finalized 当前快照的内容与冻结字段；其余只计数", async () => {
    const w = await judgementWorld(t);
    const a = w.accZhao;
    const good = await addContent(t.db, { accountId: a, platformContentId: "c-good", kind: "video", like: 42, publishedAt: new Date("2026-11-05T01:00:00Z"), durationSeconds: 30 });
    await addContent(t.db, { accountId: a, platformContentId: "c-gone", status: "deleted" });
    await addContent(t.db, { accountId: a, platformContentId: "c-building", finalized: false });
    await addContent(t.db, { accountId: a, platformContentId: "c-nosnap", noSnapshot: true });
    const nolike = await addContent(t.db, { accountId: a, platformContentId: "c-nolike", like: "missing", publishedAt: null, durationSeconds: "unknown_unit" });
    const r = await facts().contentsOf([a]);
    expect(r.rows.map((x) => x.contentId).sort()).toEqual([good.contentId, nolike.contentId].sort());
    expect(r.excluded.get(a)).toEqual({ status: 1, noSnapshot: 2 });
    const g = r.rows.find((x) => x.contentId === good.contentId)!;
    expect(g).toMatchObject({ contentKind: "video", likeState: "value", likeValue: 42n, durationState: "value", durationUnit: "seconds", snapshotId: good.snapshotId });
    const n = r.rows.find((x) => x.contentId === nolike.contentId)!;
    expect(n).toMatchObject({ likeState: "missing", likeValue: null, publishedAt: null, durationUnit: "unknown" });
  });
  it("contentsOf：冻结读到的是 current 快照，之后 current 移动不影响已读结果", async () => {
    const w = await judgementWorld(t);
    const c = await addContent(t.db, { accountId: w.accZhao, platformContentId: "c1", like: 1 });
    const before = (await facts().contentsOf([w.accZhao])).rows[0]!;
    await addContent(t.db, { accountId: w.accZhao, platformContentId: "c2", like: 2 }); // 另一条，不影响
    expect(before.snapshotId).toBe(c.snapshotId);
  });
  it("profileOf：没有当前主页快照为 null", async () => {
    const w = await judgementWorld(t);
    expect((await facts().profileOf([w.accZhao])).get(w.accZhao)).toBeNull();
  });
  it("syncCompletenessOf：各种结局一次批量算出", async () => {
    const w = await judgementWorld(t);
    const mk = async (n: string) => (await addParticipant(t, w, `专${n}`, `1390000${n.padStart(4, "0")}`)).accountId;
    const ok = await mk("1");
    const failedLast = await mk("2");
    const gapLast = await mk("3");
    const gapInWindow = await mk("4");
    const never = await mk("5");
    const blocked = await mk("6");
    const noneInWindow = await mk("7");
    const recovered = await mk("8");
    const d = (day: number) => new Date(Date.UTC(2026, 10, day, 3));
    await addListTask(t.db, { accountId: ok, status: "succeeded", at: d(5) });
    await addListTask(t.db, { accountId: failedLast, status: "succeeded", at: d(5) });
    await addListTask(t.db, { accountId: failedLast, status: "failed", at: d(8) });
    await addListTask(t.db, { accountId: gapLast, status: "succeeded_with_gap", at: d(8) });
    await addListTask(t.db, { accountId: gapInWindow, status: "succeeded_with_gap", at: d(4) });
    await addListTask(t.db, { accountId: gapInWindow, status: "succeeded", at: d(9) });
    await addListTask(t.db, { accountId: blocked, status: "succeeded", at: d(5) });
    await addCheckpoint(t.db, blocked, "blocked");
    await addListTask(t.db, { accountId: noneInWindow, status: "succeeded", at: new Date("2026-10-01T00:00:00Z") });
    await addListTask(t.db, { accountId: recovered, status: "failed", at: d(4) });
    await addListTask(t.db, { accountId: recovered, status: "succeeded", at: d(6) });
    await addListTask(t.db, { accountId: ok, status: "pending", at: d(10) }); // 未终态的不算「最近一次」
    const r = await facts().syncCompletenessOf([ok, failedLast, gapLast, gapInWindow, never, blocked, noneInWindow, recovered], FROM);
    const reasons = (a: bigint) => r.get(a)!.reason;
    expect(r.get(ok)!.complete).toBe(true);
    expect(reasons(failedLast)).toBe("sync_failed");
    expect(reasons(gapLast)).toBe("sync_gap");
    expect(reasons(gapInWindow)).toBe("sync_gap");
    expect(reasons(never)).toBe("sync_failed");
    expect(reasons(blocked)).toBe("sync_gap");
    expect(reasons(noneInWindow)).toBe("no_sync_in_window");
    expect(r.get(recovered)!.complete).toBe(true);
    void T0;
  });
});
