// 预检（任务 6）：只读、可追溯、两阶段的第一阶段。零业务写入、文件级失败不建批次。
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { businessCounts, rosterWorld, type RosterWorld } from "../../../../tests/harness/roster";
import { useTestDb } from "../../../../tests/harness/db";
import { FakeClock } from "../../../../tests/harness/fake-clock";
import { insertAccount, insertAssignment } from "../../../../tests/harness/factories";
import { insertRosterEntry, insertStaff, planActor, T0 } from "../../../../tests/harness/plan";
import { importBatches, importRowResults } from "../../../db/schema";
import { precheck, type PrecheckAccepted } from "./precheck";
import { ROSTER_HEADER } from "../constants";

const t = useTestDb();
const fx = (n: string): Uint8Array => readFileSync(new URL(`../../../../tests/fixtures/roster/${n}`, import.meta.url));
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const HEADER = ROSTER_HEADER.join(",");
let w: RosterWorld;
async function setup(over: Parameters<typeof rosterWorld>[1] = {}) {
  w = await rosterWorld(t, over);
  const deps = { db: t.db, clock: new FakeClock(T0), audit: w.audit.sink };
  const hq = planActor("hq");
  const branch = planActor("branch", { branches: [w.bj] });
  return { deps, hq, branch };
}
const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    const x = e as { category?: string; code?: string };
    return `${x.category}/${x.code}`;
  }
  return "ok";
};
const rowsOf = async (batchId: string) => (await t.db.select().from(importRowResults).where(eq(importRowResults.importBatchId, BigInt(batchId))).orderBy(importRowResults.rowNo));
const batchCount = async () => (await t.db.select().from(importBatches)).length;

describe("混合样例", () => {
  it("每行恰好一条结果；表头与示例行不产生结果；分类与原因符合预期；零业务写入", async () => {
    const { deps, hq } = await setup();
    const before = await businessCounts(t);
    const r = await precheck(deps, { planId: w.planId, fileName: "mixed.csv", bytes: fx("mixed.utf8.csv") }, hq);
    expect(await businessCounts(t)).toEqual(before);
    expect(r.totalRows).toBe(9);
    expect(r.summary.precheck).toMatchObject({ new: 1, new_staff: 1, update: 1, unchanged: 1, error: 5, example_rows: [1], possible_new_accounts: 2 });
    const rows = await rowsOf(r.batchId);
    expect(rows.map((x) => x.rowNo)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10]); // 行号 = 文件行号（示例行占位）
    expect(rows.map((x) => [x.precheckClass, x.reasonCode])).toEqual([
      ["new_staff", null],
      ["new", null],
      ["unchanged", "already_in_roster"],
      ["update", "restore_roster_entry"],
      ["error", "store_not_found"],
      ["error", "phone_invalid"],
      ["error", "non_home_locator"],
      ["error", "platform_mismatch"],
      ["error", "branch_not_joined"],
    ]);
    expect(rows.every((x) => x.outcome === null)).toBe(true);
    expect(rows[0]?.rawRow).toEqual({ 门店编码: "S-W1", 专员姓名: "新人甲", 手机号: "13800020001", 主页链接: "https://www.douyin.com/user/AAA" });
    expect(rows[1]?.staffId).toBe(w.staff.zhang);
    expect(rows[2]?.accountId).toBe(w.accZhao);
    const [b] = await t.db.select().from(importBatches).where(eq(importBatches.importBatchId, BigInt(r.batchId)));
    expect(b).toMatchObject({ importKind: "roster", planId: w.planId, submitterBranchId: null, status: "awaiting_confirm", templateVersion: "roster-import.v1", totalRows: 9, uploadedByActor: "user:hq" });
    expect(w.audit.of("roster_precheck_completed")).toHaveLength(1);
  });
  it("同一文件连续预检两次：两个批次，分类与行号一致，仍无业务写入", async () => {
    const { deps, hq } = await setup();
    const a = await precheck(deps, { planId: w.planId, fileName: "m.csv", bytes: fx("mixed.utf8.csv") }, hq);
    const b = await precheck(deps, { planId: w.planId, fileName: "m.csv", bytes: fx("mixed.utf8.csv") }, hq);
    expect(a.batchId).not.toBe(b.batchId);
    const strip = (rs: Awaited<ReturnType<typeof rowsOf>>) => rs.map((x) => [x.rowNo, x.precheckClass, x.reasonCode, x.reasonDetail]);
    expect(strip(await rowsOf(a.batchId))).toEqual(strip(await rowsOf(b.batchId)));
  });
  it("UTF-8 / BOM / GB18030 同内容，预检结果完全相同", async () => {
    const { deps, hq } = await setup();
    const out: unknown[] = [];
    for (const f of ["basic.utf8.csv", "basic.utf8-bom.csv", "basic.gb18030.csv"]) {
      const r = await precheck(deps, { planId: w.planId, fileName: f, bytes: fx(f) }, hq);
      out.push([r.summary.precheck, (await rowsOf(r.batchId)).map((x) => [x.rowNo, x.precheckClass, x.rawRow])]);
    }
    expect(out[1]).toEqual(out[0]);
    expect(out[2]).toEqual(out[0]);
    expect((out[0] as [{ new_staff: number; new: number }])[0]).toMatchObject({ new_staff: 1, new: 1 });
  });
});

describe("分公司人员", () => {
  it("单一分公司范围：submitter_branch_id 记为该分公司；他分公司门店 → store_branch_not_authorized", async () => {
    const { deps, branch } = await setup();
    const csv = `${HEADER}\r\nS-W1,新人甲,13800020001,https://www.douyin.com/user/AAA\r\nS-H2,某某,13800020009,https://www.douyin.com/user/ZZZ\r\n`;
    const r = await precheck(deps, { planId: w.planId, fileName: "b.csv", bytes: enc(csv) }, branch);
    const [b] = await t.db.select().from(importBatches).where(eq(importBatches.importBatchId, BigInt(r.batchId)));
    expect(b?.submitterBranchId).toBe(w.bj);
    expect((await rowsOf(r.batchId)).map((x) => x.reasonCode)).toEqual([null, "store_branch_not_authorized"]);
  });
  it("所在分公司未加入计划 → 整个预检被拒绝，不建批次", async () => {
    const { deps } = await setup();
    const other = planActor("branch", { branches: [w.sh] });
    expect(await code(precheck(deps, { planId: w.planId, fileName: "x.csv", bytes: fx("basic.utf8.csv") }, other))).toBe("conflict/branch_not_joined");
    expect(await batchCount()).toBe(0);
  });
  it("多分公司范围必须指定提交分公司；指定了范围外的被拒", async () => {
    const { deps } = await setup();
    const multi = planActor("branch", { branches: [w.bj, w.sh] });
    expect(await code(precheck(deps, { planId: w.planId, fileName: "x.csv", bytes: fx("basic.utf8.csv") }, multi))).toBe("input/branch_required");
    expect(await code(precheck(deps, { planId: w.planId, fileName: "x.csv", bytes: fx("basic.utf8.csv"), branchId: 999n }, multi))).toBe("authorization/branch_out_of_scope");
    expect(await code(precheck(deps, { planId: w.planId, fileName: "x.csv", bytes: fx("basic.utf8.csv"), branchId: w.bj }, multi))).toBe("ok");
  });
});

describe("前置检查失败：不建批次", () => {
  it("计划非采集中、无 Capability、越品牌、已删除", async () => {
    const { deps, hq } = await setup({ status: "paused" });
    const bytes = fx("basic.utf8.csv");
    expect(await code(precheck(deps, { planId: w.planId, fileName: "x", bytes }, hq))).toBe("conflict/plan_not_collecting");
    expect(await code(precheck(deps, { planId: w.planId, fileName: "x", bytes }, planActor("none")))).toBe("authorization/forbidden");
    expect(await code(precheck(deps, { planId: w.planId, fileName: "x", bytes }, planActor("hq", { brandScope: new Set(["HISENSE"]) })))).toBe("not_found/not_found");
    expect(await batchCount()).toBe(0);
  });
});

describe("文件级失败：批次与行结果行数为 0", () => {
  it("逐项", async () => {
    const { deps, hq } = await setup();
    const many = enc(`${HEADER}\r\n${Array.from({ length: 2001 }, (_, i) => `S-W1,甲,138${String(i).padStart(8, "0")},u${i}`).join("\r\n")}\r\n`);
    const cases: Array<[string, Uint8Array, string]> = [
      ["超大", new Uint8Array(10 * 1024 * 1024 + 1), "input/file_too_large"],
      ["2001 行", many, "input/too_many_rows"],
      ["列数不一致", enc(`${HEADER}\r\nS-W1,甲,13800000000\r\n`), "input/csv_malformed"],
      ["引号未闭合", enc(`${HEADER}\r\nS-W1,"甲,13800000000,u\r\n`), "input/csv_malformed"],
      ["乱码", fx("garbage.bin"), "input/encoding_unrecognized"],
      ["表头改名", enc("门店编号,专员姓名,手机号,主页链接\r\nS-W1,甲,13800000000,u\r\n"), "input/header_mismatch"],
      ["只有表头", enc(`${HEADER}\r\n`), "input/no_data_rows"],
    ];
    for (const [label, bytes, expected] of cases) expect(await code(precheck(deps, { planId: w.planId, fileName: "x", bytes }, hq)), label).toBe(expected);
    expect(await batchCount()).toBe(0);
    expect((await t.db.select().from(importRowResults)).length).toBe(0);
  });
});

describe("规模限制", () => {
  const manyNewStaff = (n: number) =>
    enc(`${HEADER}\r\n${Array.from({ length: n }, (_, i) => `S-W1,新${i},139${String(i).padStart(8, "0")},https://www.douyin.com/user/N${i}`).join("\r\n")}\r\n`);
  it("1,001 个将新建专员整批拒绝且无批次；1,000 个可以", async () => {
    const { deps, hq } = await setup();
    expect(await code(precheck(deps, { planId: w.planId, fileName: "x", bytes: manyNewStaff(1001) }, hq))).toBe("limit/too_many_new_staff");
    expect(await batchCount()).toBe(0);
    const ok = await precheck(deps, { planId: w.planId, fileName: "x", bytes: manyNewStaff(1000) }, hq);
    expect(ok.summary.precheck.new_staff).toBe(1000);
  });
  it("计划已有 1,150 个账号再提交 100 行：软提示，仍可确认", async () => {
    const { deps, hq } = await setup();
    // 造 1,148 个名单项（连同种子里的 2 个名单项，其中 1 个 in_roster 1 个 removed → 现有 1,149）
    const staffId = await insertStaff(t.db, { storeId: w.stores.sW1, phone: "13911110000" });
    for (let i = 0; i < 1149; i++) {
      const accountId = await insertAccount(t.db, "douyin", T0);
      await insertRosterEntry(t.db, { planId: w.planId, accountId, staffId, storeId: w.stores.sW1, branchId: w.bj });
    }
    const bytes = enc(`${HEADER}\r\n${Array.from({ length: 100 }, (_, i) => `S-W1,新${i},137${String(i).padStart(8, "0")},https://www.douyin.com/user/M${i}`).join("\r\n")}\r\n`);
    const r: PrecheckAccepted = await precheck(deps, { planId: w.planId, fileName: "x", bytes }, hq);
    expect(r.summary.precheck).toMatchObject({ plan_entries_now: 1150, plan_entries_after: 1250, soft_cap_exceeded: true });
    expect(r.status).toBe("awaiting_confirm");
  });
  it("未超线时不提示", async () => {
    const { deps, hq } = await setup();
    const r = await precheck(deps, { planId: w.planId, fileName: "x", bytes: fx("basic.utf8.csv") }, hq);
    expect(r.summary.precheck).toMatchObject({ plan_entries_now: 1, plan_entries_after: 3, soft_cap_exceeded: false });
  });
});

describe("入口本地命中", () => {
  it("命中同专员已有账号但不在本计划 → new + known_account_same_owner；哈希命中但原文不同不算命中", async () => {
    const { deps, hq } = await setup();
    const acc = await insertAccount(t.db, "douyin", T0);
    await insertAssignment(t.db, { accountId: acc, platform: "douyin", staffId: w.staff.zhang, now: T0, locator: "https://www.douyin.com/user/KNOWN" });
    const csv = `${HEADER}\r\nS-W1,老张,13800010001,https://www.douyin.com/user/KNOWN 复制此链接\r\n`;
    const r = await precheck(deps, { planId: w.planId, fileName: "x", bytes: enc(csv) }, hq);
    const [row] = await rowsOf(r.batchId);
    expect(row).toMatchObject({ precheckClass: "new", reasonCode: "known_account_same_owner", accountId: acc });
    expect(r.summary.precheck.possible_new_accounts).toBe(0);
  });
  it("命中归属他人的账号 → 预检类不变，提示 known_account_other_owner", async () => {
    const { deps, hq } = await setup();
    const acc = await insertAccount(t.db, "douyin", T0);
    await insertAssignment(t.db, { accountId: acc, platform: "douyin", staffId: w.staff.li, now: T0, locator: "https://www.douyin.com/user/OWNED" });
    const csv = `${HEADER}\r\nS-W1,老张,13800010001,https://www.douyin.com/user/OWNED\r\n`;
    const [row] = await rowsOf((await precheck(deps, { planId: w.planId, fileName: "x", bytes: enc(csv) }, hq)).batchId);
    expect(row).toMatchObject({ precheckClass: "new", reasonCode: "known_account_other_owner" });
  });
});

describe("其他错误来自真实库", () => {
  it("门店已撤、同号停用专员、手机号属于他店、品牌不符与范围外品牌", async () => {
    const { deps } = await setup();
    const hq = planActor("hq", { brandScope: new Set(["HITACHI", "HISENSE"]) });
    const csv = [
      HEADER,
      "S-CLOSED,甲,13800030001,https://www.douyin.com/user/a1",
      "S-W1,老王,13800010003,https://www.douyin.com/user/a2",
      "S-W1,老李,13800010002,https://www.douyin.com/user/a3",
      "HS-001,乙,13800030002,https://www.douyin.com/user/a4",
    ].join("\r\n");
    const rows = await rowsOf((await precheck(deps, { planId: w.planId, fileName: "x", bytes: enc(csv) }, hq)).batchId);
    expect(rows.map((x) => x.reasonCode)).toEqual(["store_closed", "staff_inactive_restore_needed", "phone_belongs_to_other_store", "store_brand_mismatch"]);
    // 同一个文件换成只授权日立的总部：海信门店编码对他表现为「不存在」
    const hitachiOnly = planActor("hq", { brandScope: new Set(["HITACHI"]) });
    const rows2 = await rowsOf((await precheck(deps, { planId: w.planId, fileName: "x", bytes: enc(csv) }, hitachiOnly)).batchId);
    expect(rows2[3]?.reasonCode).toBe("store_not_found");
  });
});
