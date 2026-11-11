// 名单导入测试的组织与计划种子（与 tests/fixtures/roster/mixed.utf8.csv 对应）。
import type { TestDb } from "./db";
import { insertAccount, insertAssignment } from "./factories";
import { insertPlan, insertRosterEntry, insertStaff, insertStore, MemoryPlanAudit, T0 } from "./plan";
import { seedOrg, type OrgSeed } from "./seed";
import { eq } from "drizzle-orm";
import { sectors } from "../../src/db/schema";

export async function insertSector(t: TestDb, branchId: bigint, branchCode: string, key: "water" | "home"): Promise<bigint> {
  const [r] = await t.db.insert(sectors).values({ branchId, sectorCode: `${branchCode}-${key}`, sectorName: key === "water" ? "水机" : "家装", status: "active", createdAt: T0, updatedAt: T0 });
  return BigInt(r.insertId);
}
/**
 * 品牌 HITACHI；分公司 101（已加入）、102（未加入）；
 * 门店 S-W1（101 水机）、S-H1（101 家装）、S-H2（102 家装）、S-CLOSED（101 水机，已撤）；HISENSE 品牌下的 HS-001；
 * 专员 老张 13800010001@S-W1、老李 13800010002@S-H2、老王(停用) 13800010003@S-W1、老赵 13800010004@S-W1(账号 CCC 在名单)、老钱 13800010005@S-W1(账号 DDD 已移出)。
 */
export async function rosterWorld(t: TestDb, planOver: Parameters<typeof insertPlan>[2] = {}) {
  const org: OrgSeed = await seedOrg(t.db, T0);
  const bj = org.branchIds.get("101")!;
  const sh = org.branchIds.get("102")!;
  const water101 = await insertSector(t, bj, "101", "water");
  // seedOrg 已为 101 建了「家装」板块（编码 SEC-HOME）；改成约定形态 101-home 复用，避免唯一键冲突
  await t.db.update(sectors).set({ sectorCode: "101-home" }).where(eq(sectors.sectorId, org.sectorId));
  const home101 = org.sectorId;
  const home102 = await insertSector(t, sh, "102", "home");
  const store = (code: string, sectorId: bigint, extra: { status?: "active" | "closed"; brandId?: bigint } = {}) => insertStore(t.db, org, { code, sectorId, ...extra });
  const sW1 = await store("S-W1", water101);
  const sH1 = await store("S-H1", home101);
  const sH2 = await store("S-H2", home102);
  const sClosed = await store("S-CLOSED", water101, { status: "closed" });
  const sHisense = await store("HS-001", water101, { brandId: org.hisenseBrandId });
  const staff = {
    zhang: await insertStaff(t.db, { storeId: sW1, name: "老张", phone: "13800010001" }),
    li: await insertStaff(t.db, { storeId: sH2, name: "老李", phone: "13800010002" }),
    wangInactive: await insertStaff(t.db, { storeId: sW1, name: "老王", phone: "13800010003", status: "inactive" }),
    zhao: await insertStaff(t.db, { storeId: sW1, name: "老赵", phone: "13800010004" }),
    qian: await insertStaff(t.db, { storeId: sW1, name: "老钱", phone: "13800010005" }),
  };
  const planId = await insertPlan(t.db, org, { joined: [bj], ...planOver });
  // 老赵的账号 CCC 在名单（unchanged）；老钱的账号 DDD 已被移出（update）
  const account = async (staffId: bigint, locator: string, state: "in_roster" | "removed") => {
    const accountId = await insertAccount(t.db, "douyin", T0);
    await insertAssignment(t.db, { accountId, platform: "douyin", staffId, now: T0, locator });
    await insertRosterEntry(t.db, { planId, accountId, staffId, storeId: sW1, branchId: bj, state });
    return accountId;
  };
  const accZhao = await account(staff.zhao, "https://www.douyin.com/user/CCC", "in_roster");
  const accQian = await account(staff.qian, "https://www.douyin.com/user/DDD", "removed");
  return { org, bj, sh, planId, stores: { sW1, sH1, sH2, sClosed, sHisense }, staff, accZhao, accQian, audit: new MemoryPlanAudit() };
}
export type RosterWorld = Awaited<ReturnType<typeof rosterWorld>>;

/** 业务表（预检必须一行都不能多）的行数快照。 */
export async function businessCounts(t: TestDb): Promise<Record<string, number>> {
  const tables = ["media_staff", "external_accounts", "staff_account_assignments", "activity_plan_roster", "activity_plan_owners", "activity_plan_branches", "sync_tasks", "sync_batches", "ods_provider_calls"];
  const out: Record<string, number> = {};
  for (const name of tables) {
    const [rows] = await t.pool.query(`SELECT COUNT(*) n FROM \`${name}\``);
    out[name] = Number((rows as Array<{ n: string }>)[0]!.n);
  }
  return out;
}
