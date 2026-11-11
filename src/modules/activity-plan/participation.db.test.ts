// 参与关系与负责人名额（任务 5）。并发用例用显式闸门，不用 Promise.all。
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { useTestDb } from "../../../tests/harness/db";
import { insertAccount, insertAssignment } from "../../../tests/harness/factories";
import { FakeClock } from "../../../tests/harness/fake-clock";
import { insertPlan, insertRosterEntry, insertStaff, MemoryPlanAudit, planActor, T0 } from "../../../tests/harness/plan";
import { seedOrg, type OrgSeed } from "../../../tests/harness/seed";
import { activityPlanBranches, activityPlanChanges, activityPlanOwners, activityPlanRoster, branches, staffAccountAssignments as aa } from "../../db/schema";
import { claimIfNeeded } from "./owners";
import { createOwners } from "./owners";
import { createParticipation } from "./participation";
import { createPlans } from "./plans";
import { noDownstream } from "./downstream";

const t = useTestDb();
let org: OrgSeed;
let phone = 13600000000;
let bj: bigint; // 分公司 101
let sh: bigint; // 分公司 102
async function world() {
  org = await seedOrg(t.db, T0);
  bj = org.branchIds.get("101")!;
  sh = org.branchIds.get("102")!;
  const clock = new FakeClock(T0);
  const audit = new MemoryPlanAudit();
  const deps = { db: t.db, clock, audit: audit.sink };
  return { clock, audit, part: createParticipation(deps), owners: createOwners(deps), plans: createPlans({ ...deps, downstream: noDownstream }) };
}
const branchActor = (name: string, ...ids: bigint[]) => planActor("branch", { actor: name, branches: ids });
const admin = planActor("admin");
const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    const x = e as { category?: string; code?: string };
    return `${x.category}/${x.code}`;
  }
  return "ok";
};
async function acct() {
  const staffId = await insertStaff(t.db, { storeId: org.storeId, phone: String(++phone) });
  const accountId = await insertAccount(t.db, "douyin", T0);
  await insertAssignment(t.db, { accountId, platform: "douyin", staffId, now: T0 });
  return { accountId, staffId };
}
const entry = (planId: bigint, a: { accountId: bigint; staffId: bigint }, branchId = bj, state: "in_roster" | "removed" = "in_roster") =>
  insertRosterEntry(t.db, { planId, accountId: a.accountId, staffId: a.staffId, storeId: org.storeId, branchId, state });
const on = async (accountId: bigint) => (await t.db.select().from(aa).where(eq(aa.accountId, accountId)))[0]!.monitoringEnabled;
const participation = async (planId: bigint, branchId: bigint) => (await t.db.select().from(activityPlanBranches).where(and(eq(activityPlanBranches.planId, planId), eq(activityPlanBranches.branchId, branchId))))[0];

describe("加入", () => {
  it("同品牌同平台的任意分公司都可加入；重复加入为空操作", async () => {
    const { part } = await world();
    const p = await insertPlan(t.db, org);
    expect((await part.join(branchActor("user:a", bj), p, bj)).kind).toBe("joined");
    expect((await part.join(branchActor("user:a", bj), p, bj)).kind).toBe("noop");
    expect((await part.join(admin, p, sh)).kind).toBe("joined");
    expect((await t.db.select().from(activityPlanChanges)).filter((c) => c.eventType === "branch_joined")).toHaveLength(2);
  });
  it("拒绝：越分公司、无 Capability、非采集中、停用分公司、他品牌计划、已删除计划", async () => {
    const { part } = await world();
    const p = await insertPlan(t.db, org);
    expect(await code(part.join(branchActor("user:a", bj), p, sh))).toBe("authorization/branch_out_of_scope");
    expect(await code(part.join(planActor("none"), p, bj))).toBe("authorization/forbidden");
    for (const status of ["paused", "archived"] as const) {
      const q = await insertPlan(t.db, org, { status });
      expect(await code(part.join(admin, q, bj)), status).toBe("conflict/plan_not_collecting");
    }
    await t.db.update(branches).set({ status: "inactive" }).where(eq(branches.branchId, sh));
    expect(await code(part.join(admin, p, sh))).toBe("input/branch_inactive");
    expect(await code(part.join(admin, p, 987654n))).toBe("not_found/branch_not_found");
    const other = await insertPlan(t.db, org, { brandId: org.hisenseBrandId });
    expect(await code(part.join(branchActor("user:a", bj), other, bj))).toBe("not_found/not_found");
    const del = await insertPlan(t.db, org, { status: "deleted" });
    expect(await code(part.join(admin, del, bj))).toBe("not_found/not_found");
  });
});

describe("退出与重新加入", () => {
  it("预览零写入", async () => {
    const { part } = await world();
    const p = await insertPlan(t.db, org, { joined: [bj] });
    const a = await acct();
    await entry(p, a);
    const pv = await part.exit(branchActor("user:a", bj), p, bj);
    expect(pv).toMatchObject({ kind: "preview", rosterEntries: 1, accountsToClose: 1, apply: false });
    expect((await participation(p, bj))?.status).toBe("joined");
    expect((await t.db.select().from(activityPlanRoster))[0]?.entryState).toBe("in_roster");
  });
  it("apply：名单项全部 removed(branch_exit)、名额释放、仅本计划引用的账号立即关闭，另一计划引用的保持开启", async () => {
    const { part, audit } = await world();
    const p = await insertPlan(t.db, org, { joined: [bj, sh] });
    const other = await insertPlan(t.db, org, { name: "另一个", joined: [bj] });
    const only = await acct();
    const shared = await acct();
    const otherBranch = await acct();
    await entry(p, only);
    await entry(p, shared);
    await entry(other, shared);
    await entry(p, otherBranch, sh);
    await t.db.insert(activityPlanOwners).values({ planId: p, branchId: bj, slotNo: 1, ownerActor: "user:a", claimedAt: T0, claimedVia: "import" });
    const r = await part.exit(branchActor("user:a", bj), p, bj, { apply: true });
    expect(r).toMatchObject({ kind: "applied", rosterEntries: 2, releasedOwners: ["user:a"], accountsClosed: 1 });
    const rows = await t.db.select().from(activityPlanRoster).where(eq(activityPlanRoster.planId, p));
    const byBranch = (b: bigint) => rows.filter((x) => x.branchId === b).map((x) => [x.entryState, x.removedReason]);
    expect(byBranch(bj)).toEqual([["removed", "branch_exit"], ["removed", "branch_exit"]]);
    expect(byBranch(sh)).toEqual([["in_roster", null]]);
    expect(rows.find((x) => x.accountId === only.accountId)).toMatchObject({ removedByActor: "user:a" });
    expect(rows[0]?.removedAt).toEqual(T0);
    expect(await t.db.select().from(activityPlanOwners)).toEqual([]);
    expect(await on(only.accountId)).toBe(false);
    expect(await on(shared.accountId)).toBe(true);
    expect(await on(otherBranch.accountId)).toBe(true);
    expect((await participation(p, bj))?.status).toBe("exited");
    expect(audit.of("branch_exited")).toHaveLength(1);
    expect(audit.of("owner_released")).toHaveLength(1);
    expect(audit.of("monitoring_closed_unreferenced")).toHaveLength(1);
    expect((await t.db.select().from(activityPlanChanges)).map((c) => c.eventType)).toContain("branch_exited");
  });
  it("重新加入后名单项仍是 removed，恢复靠重新提交（恢复原行不新增）", async () => {
    const { part } = await world();
    const p = await insertPlan(t.db, org, { joined: [bj] });
    const a = await acct();
    await entry(p, a);
    await part.exit(admin, p, bj, { apply: true });
    expect((await part.join(admin, p, bj)).kind).toBe("rejoined");
    expect((await participation(p, bj))?.status).toBe("joined");
    expect((await t.db.select().from(activityPlanRoster))[0]?.entryState).toBe("removed");
    expect(await t.db.select().from(activityPlanRoster)).toHaveLength(1);
  });
  it("未参加不能退出；非采集中不能退出", async () => {
    const { part } = await world();
    const p = await insertPlan(t.db, org);
    expect(await code(part.exit(admin, p, bj, { apply: true }))).toBe("conflict/branch_not_joined");
    const q = await insertPlan(t.db, org, { status: "paused", joined: [bj] });
    expect(await code(part.exit(admin, q, bj, { apply: true }))).toBe("conflict/plan_not_collecting");
    expect(await code(part.exit(branchActor("user:a", sh), q, bj, { apply: true }))).toBe("authorization/branch_out_of_scope");
  });
});

describe("名额占用（claimIfNeeded）", () => {
  const claim = (planId: bigint, branchId: bigint, actor: ReturnType<typeof planActor>, possiblyNew = true) =>
    t.db.transaction((tx) => claimIfNeeded(tx, { planId, branchId, actor, possiblyNew, now: T0 }));
  it("第 1、2 位占用，第 3 位 owner_slots_full（带现有负责人），零写入", async () => {
    await world();
    const p = await insertPlan(t.db, org, { joined: [bj] });
    expect(await claim(p, bj, branchActor("user:one", bj))).toMatchObject({ claimed: true, slotNo: 1 });
    expect(await claim(p, bj, branchActor("user:two", bj))).toMatchObject({ claimed: true, slotNo: 2 });
    let err: { code?: string; message?: string; detail?: unknown } = {};
    try {
      await claim(p, bj, branchActor("user:three", bj));
    } catch (e) {
      err = e as typeof err;
    }
    expect(err.code).toBe("owner_slots_full");
    expect(err.message).toContain("user:one、user:two");
    expect((await t.db.select().from(activityPlanOwners)).map((o) => o.ownerActor)).toEqual(["user:one", "user:two"]);
  });
  it("豁免（分公司范围 all）、已是负责人、没有可能新增的行：都不占用", async () => {
    await world();
    const p = await insertPlan(t.db, org, { joined: [bj] });
    expect(await claim(p, bj, admin)).toMatchObject({ claimed: false, reason: "exempt" });
    expect(await claim(p, bj, planActor("hq"))).toMatchObject({ claimed: false, reason: "exempt" });
    expect(await claim(p, bj, branchActor("user:a", bj), false)).toMatchObject({ claimed: false, reason: "no_new_rows" });
    expect(await claim(p, bj, branchActor("user:a", bj))).toMatchObject({ claimed: true });
    expect(await claim(p, bj, branchActor("user:a", bj))).toMatchObject({ claimed: false, reason: "already_owner" });
    expect(await t.db.select().from(activityPlanOwners)).toHaveLength(1);
  });
  it("名额已满时，豁免者与已是负责人者照常通过", async () => {
    await world();
    const p = await insertPlan(t.db, org, { joined: [bj] });
    await claim(p, bj, branchActor("user:one", bj));
    await claim(p, bj, branchActor("user:two", bj));
    expect(await claim(p, bj, admin)).toMatchObject({ claimed: false });
    expect(await claim(p, bj, branchActor("user:one", bj))).toMatchObject({ claimed: false, reason: "already_owner" });
  });
  it("未参加的分公司不能占", async () => {
    await world();
    const p = await insertPlan(t.db, org);
    expect(await code(claim(p, bj, branchActor("user:a", bj)))).toBe("conflict/branch_not_joined");
  });
  it("并发：两个提交抢最后一个槽，恰好一个成功（参与关系行锁串行化）", async () => {
    await world();
    const p = await insertPlan(t.db, org, { joined: [bj] });
    await t.db.insert(activityPlanOwners).values({ planId: p, branchId: bj, slotNo: 1, ownerActor: "user:first", claimedAt: T0, claimedVia: "import" });
    let releaseA!: () => void;
    const gateA = new Promise<void>((r) => (releaseA = r));
    let aHolds!: () => void;
    const aHoldsLock = new Promise<void>((r) => (aHolds = r));
    const a = t.db.transaction(async (tx) => {
      const r = await claimIfNeeded(tx, { planId: p, branchId: bj, actor: branchActor("user:A", bj), possiblyNew: true, now: T0 });
      aHolds();
      await gateA; // 持锁不提交
      return r;
    });
    await aHoldsLock;
    let bSettled = false;
    const b = claim(p, bj, branchActor("user:B", bj)).then(
      (v) => ((bSettled = true), { ok: v }),
      (e: unknown) => ((bSettled = true), { err: e as { code?: string } }),
    );
    await new Promise((r) => setTimeout(r, 300));
    expect(bSettled).toBe(false); // B 阻塞在参与关系行锁上
    releaseA();
    expect(await a).toMatchObject({ claimed: true, slotNo: 2 });
    expect(await b).toMatchObject({ err: { code: "owner_slots_full" } });
    expect((await t.db.select().from(activityPlanOwners)).map((o) => o.ownerActor).sort()).toEqual(["user:A", "user:first"]);
  });
});

describe("指派与替换", () => {
  const creator = planActor("hq", { actor: "user:creator" });
  it("默认只预览；apply 才写；空槽指派 / 替换同一命令，并记变更", async () => {
    const { owners, audit } = await world();
    const p = await insertPlan(t.db, org, { joined: [bj] });
    const pv = await owners.assign(creator, { planId: p, branchId: bj, owner: "user:new" });
    expect(pv).toMatchObject({ kind: "preview", slotNo: 1, before: null });
    expect(await t.db.select().from(activityPlanOwners)).toEqual([]);
    expect(await owners.assign(creator, { planId: p, branchId: bj, owner: "user:new", apply: true })).toMatchObject({ kind: "applied", slotNo: 1 });
    await owners.assign(creator, { planId: p, branchId: bj, owner: "user:second", apply: true });
    expect(await code(owners.assign(creator, { planId: p, branchId: bj, owner: "user:third", apply: true }))).toBe("input/slot_required");
    const r = await owners.replace(creator, { planId: p, branchId: bj, owner: "user:third", slotNo: 1, apply: true });
    expect(r).toMatchObject({ kind: "applied", before: "user:new", slotNo: 1 });
    expect((await t.db.select().from(activityPlanOwners).where(eq(activityPlanOwners.slotNo, 1)))[0]).toMatchObject({ ownerActor: "user:third", claimedVia: "replace" });
    expect(audit.of("owner_replaced")).toHaveLength(1);
    expect((await t.db.select().from(activityPlanChanges)).filter((c) => c.eventType === "owner_replaced")).toHaveLength(1);
    expect(await owners.assign(creator, { planId: p, branchId: bj, owner: "user:third", slotNo: 1, apply: true })).toMatchObject({ kind: "noop" });
    expect(await code(owners.assign(creator, { planId: p, branchId: bj, owner: "user:second", slotNo: 1, apply: true }))).toBe("conflict/owner_already_in_slot");
  });
  it("超管可替换；其他总部、分公司人员（包括负责人本人）不能", async () => {
    const { owners } = await world();
    const p = await insertPlan(t.db, org, { joined: [bj] });
    const a = { planId: p, branchId: bj, owner: "user:x", apply: true };
    expect(await code(owners.assign(admin, a))).toBe("ok");
    expect(await code(owners.assign(planActor("hq", { actor: "user:other-hq" }), { ...a, owner: "user:y", slotNo: 1 }))).toBe("authorization/not_plan_creator");
    // 负责人只是责任标记：user:x 是负责人，但仍没有替换权限
    expect(await code(owners.assign(branchActor("user:x", bj), { ...a, owner: "user:y", slotNo: 1 }))).toBe("authorization/forbidden");
  });
  it("非采集中被拒；分公司未参加被拒；槽位号非法被拒", async () => {
    const { owners } = await world();
    const paused = await insertPlan(t.db, org, { status: "paused", joined: [bj] });
    expect(await code(owners.assign(creator, { planId: paused, branchId: bj, owner: "u", apply: true }))).toBe("conflict/plan_not_collecting");
    const p = await insertPlan(t.db, org);
    expect(await code(owners.assign(creator, { planId: p, branchId: bj, owner: "u", apply: true }))).toBe("conflict/branch_not_joined");
    expect(await code(owners.assign(creator, { planId: p, branchId: bj, owner: "u", slotNo: 3 }))).toBe("input/slot_invalid");
  });
  it("list：分公司人员只看到自己分公司的槽位", async () => {
    const { owners } = await world();
    const p = await insertPlan(t.db, org, { joined: [bj, sh] });
    await owners.assign(admin, { planId: p, branchId: bj, owner: "user:bj", apply: true });
    await owners.assign(admin, { planId: p, branchId: sh, owner: "user:sh", apply: true });
    expect((await owners.list(admin, p)).map((o) => o.owner).sort()).toEqual(["user:bj", "user:sh"]);
    expect((await owners.list(branchActor("user:q", bj), p)).map((o) => o.owner)).toEqual(["user:bj"]);
  });
});
