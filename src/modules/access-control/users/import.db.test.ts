// 用户批量导入（任务 8；AX-3，acceptance H1–H17）。全程假短信、无网络。
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { accessEnv, accessLinkage, insertAccessUser, loginAs, seedAccessOrg, type AccessEnv, type AccessOrg } from "../../../../tests/harness/access";
import { useTestDb } from "../../../../tests/harness/db";
import { accessUserBranches, accessUserBrands, accessUsers, auditEvents, authUsers, importBatches, importRowResults } from "../../../db/schema";
import { createAuthenticator } from "../authenticate";
import { createAuthorizer, type AuthContext } from "../authorize";
import { AccessError } from "../errors";
import { createOrgDirectory } from "../scope";
import { createUserAdmin } from "./admin";
import { createUserImport, RETURN_COLUMNS, USER_IMPORT_HEADER, type UserImport } from "./import";

const t = useTestDb();
let env: AccessEnv;
let org: AccessOrg;
let imp: UserImport;
let authenticate: ReturnType<typeof createAuthenticator>["authenticate"];

beforeEach(async () => {
  env = accessEnv(t);
  org = await seedAccessOrg(env);
  const dir = createOrgDirectory(t.db);
  const admin = createUserAdmin({ db: t.db, clock: env.clock, audit: env.audit, dir, authorizer: createAuthorizer() });
  imp = createUserImport({ db: t.db, clock: env.clock, audit: env.audit, admin });
  authenticate = createAuthenticator({ db: t.db, auth: env.auth, dir, linkage: accessLinkage(env, { dir }) }).authenticate;
});

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`../../../../tests/fixtures/access/user-import/${name}`, import.meta.url)));
const csv = (rows: string[][]) => new TextEncoder().encode([USER_IMPORT_HEADER.join(","), ...rows.map((r) => r.join(","))].join("\r\n") + "\r\n");
async function ctxOf(phone: string): Promise<AuthContext> {
  const r = await authenticate(await loginAs(env, phone));
  if (!r.ok) throw new Error(`认证失败：${r.reason}`);
  return r.ctx;
}
async function actors() {
  await insertAccessUser(env, { role: "platform_admin", phone: "13000000001" });
  await insertAccessUser(env, { role: "hq_manager", phone: "13000000002", brandIds: [org.hisense] });
  await insertAccessUser(env, { role: "branch_manager", phone: "13000000003", brandIds: [org.hisense], branchIds: [org.bj] });
  return { adminCtx: await ctxOf("13000000001"), hqCtx: await ctxOf("13000000002"), bmCtx: await ctxOf("13000000003") };
}
const errCode = async (p: Promise<unknown>): Promise<string> => {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(AccessError);
  return (e as AccessError).code;
};
const counts = async () => ({
  auth: (await t.db.select().from(authUsers)).length,
  access: (await t.db.select().from(accessUsers)).length,
  brands: (await t.db.select().from(accessUserBrands)).length,
  branches: (await t.db.select().from(accessUserBranches)).length,
  batches: (await t.db.select().from(importBatches)).length,
});
const reasons = (v: { rows: Array<{ rowNo: number; reasonCode: string | null }> }) => Object.fromEntries(v.rows.map((r) => [r.rowNo, r.reasonCode]));

describe("文件级（H1、H2）", () => {
  it("1,001 行 / 10 MB + 1 / 表头不符 / 无法识别编码 / 引号未闭合 / 空文件：整批拒绝，无批次", async () => {
    const a = await actors();
    const before = await counts();
    const many = csv(Array.from({ length: 1001 }, (_, i) => [`人${i}`, "总部人员", `139${String(10000000 + i)}`, "HISENSE", "", ""]));
    expect(await errCode(imp.precheck(a.adminCtx, { name: "many.csv", bytes: many }))).toBe("too_many_rows");
    expect(await errCode(imp.precheck(a.adminCtx, { name: "big.csv", bytes: new Uint8Array(10 * 1024 * 1024 + 1) }))).toBe("file_too_large");
    expect(await errCode(imp.precheck(a.adminCtx, { name: "h.csv", bytes: new TextEncoder().encode("姓名,角色,手机号\r\n张,总部人员,13911110001\r\n") }))).toBe("header_mismatch");
    expect(await errCode(imp.precheck(a.adminCtx, { name: "g.csv", bytes: fixture("garbage.bin") }))).toBe("encoding_unrecognized");
    expect(await errCode(imp.precheck(a.adminCtx, { name: "q.csv", bytes: new TextEncoder().encode(`${USER_IMPORT_HEADER.join(",")}\r\n"张,总部人员,13911110001,HISENSE,,\r\n`) }))).toBe("csv_malformed");
    expect(await errCode(imp.precheck(a.adminCtx, { name: "e.csv", bytes: new Uint8Array(0) }))).toBe("empty_file");
    expect(await counts()).toEqual(before);
  });

  it("恰好 1,000 行可以预检", async () => {
    const a = await actors();
    const rows = Array.from({ length: 1000 }, (_, i) => [`人${i}`, "总部人员", `139${String(10000000 + i)}`, "HISENSE", "", ""]);
    const v = await imp.precheck(a.adminCtx, { name: "1000.csv", bytes: csv(rows) });
    expect(v).toMatchObject({ totalRows: 1000, newRows: 1000, status: "awaiting_confirm" });
  });

  it("UTF-8、带 BOM、GB18030 同内容，预检结果完全相同", async () => {
    const a = await actors();
    const views: Awaited<ReturnType<UserImport["precheck"]>>[] = [];
    for (const f of ["basic.utf8.csv", "basic.utf8-bom.csv", "basic.gb18030.csv"]) views.push(await imp.precheck(a.adminCtx, { name: f, bytes: fixture(f) }));
    const shape = (v: (typeof views)[number]) => v.rows.map((r) => [r.rowNo, r.precheckClass, r.reasonCode]);
    expect(shape(views[1]!)).toEqual(shape(views[0]!));
    expect(shape(views[2]!)).toEqual(shape(views[0]!));
    expect(views[0]).toMatchObject({ newRows: 3, errorRows: 0 });
    expect((views[2]!.summary as { encoding: string }).encoding).toBe("gb18030");
  });
});

describe("预检（H3–H10）", () => {
  it("预检只读：用户 / 认证 / 授权集合行数不变，假短信为空（H3、H17）", async () => {
    const a = await actors();
    const before = { ...(await counts()) };
    await imp.precheck(a.adminCtx, { name: "basic.csv", bytes: fixture("basic.utf8.csv") });
    const after = await counts();
    expect({ ...after, batches: 0 }).toEqual({ ...before, batches: 0 });
    expect(env.sender.sent).toHaveLength(0);
  });

  it("总部导入含 hq_manager / platform_admin 行：这些行跳过，其余行正常，整批不失败（H4）", async () => {
    const a = await actors();
    const v = await imp.precheck(a.hqCtx, {
      name: "x.csv",
      bytes: csv([
        ["甲", "分公司人员", "13911110001", "HISENSE", "BR-BJ", ""],
        ["乙", "总部人员", "13911110002", "HISENSE", "", ""],
        ["丙", "超级管理员", "13911110003", "", "", ""],
        ["丁", "经销商人员", "13800000001", "", "", "S-A"],
      ]),
    });
    expect(reasons(v)).toEqual({ 1: null, 2: "role_not_grantable", 3: "role_not_grantable", 4: null });
    expect(v).toMatchObject({ newRows: 2, skippedRows: 2, errorRows: 0, status: "awaiting_confirm" });
  });

  it("分公司人员导入他分公司门店、超出自己品牌的行被拒（H5）", async () => {
    const a = await actors();
    const v = await imp.precheck(a.bmCtx, {
      name: "x.csv",
      bytes: csv([
        ["甲", "经销商人员", "13800000003", "", "", "S-C"], // 上海店
        ["乙", "经销商人员", "13800000002", "", "", "S-B"], // 北京日立店：不在 bm 的海信品牌范围
        ["丙", "经销商人员", "13800000001", "", "", "S-A"], // 北京海信店：可
      ]),
    });
    expect(reasons(v)).toEqual({ 1: "store_not_in_scope", 2: "store_not_in_scope", 3: null });
  });

  it("手机号已被待激活 / 有效用户占用 → phone_exists；停用用户的号码可新建（H6、H7）", async () => {
    const a = await actors();
    await insertAccessUser(env, { role: "branch_manager", phone: "13911110001", brandIds: [org.hisense], branchIds: [org.bj], status: "pending_activation" });
    await insertAccessUser(env, { role: "branch_manager", phone: "13911110002", brandIds: [org.hisense], branchIds: [org.bj] });
    await insertAccessUser(env, { role: "branch_manager", phone: "13911110003", brandIds: [org.hisense], branchIds: [org.bj], status: "disabled" });
    const v = await imp.precheck(a.adminCtx, {
      name: "x.csv",
      bytes: csv([
        ["甲", "总部人员", "13911110001", "HISENSE", "", ""],
        ["乙", "总部人员", "13911110002", "HISENSE", "", ""],
        ["丙", "总部人员", "13911110003", "HISENSE", "", ""],
      ]),
    });
    expect(reasons(v)).toEqual({ 1: "phone_exists", 2: "phone_exists", 3: null });
  });

  it("同文件内同号两行：两行都报 duplicate_phone_in_file；写法不同的同一号码也算（H8）", async () => {
    const a = await actors();
    const v = await imp.precheck(a.adminCtx, {
      name: "x.csv",
      bytes: csv([
        ["甲", "总部人员", "13911110001", "HISENSE", "", ""],
        ["乙", "总部人员", "139 1111 0001", "HISENSE", "", ""],
        ["丙", "总部人员", "13911110002", "HISENSE", "", ""],
      ]),
    });
    expect(reasons(v)).toEqual({ 1: "duplicate_phone_in_file", 2: "duplicate_phone_in_file", 3: null });
  });

  it("经销商人员定位失败：手机号不存在 / 专员停用（H9）；不建用户", async () => {
    const a = await actors();
    const v = await imp.precheck(a.adminCtx, {
      name: "x.csv",
      bytes: csv([
        ["甲", "经销商人员", "13800000099", "", "", "S-A"],
        ["乙", "经销商人员", "13800000009", "", "", "S-A"],
        ["丙", "经销商人员", "13800000001", "", "", "S-B"], // 手机号在 A 店，填了 B 店编码
      ]),
    });
    expect(reasons(v)).toEqual({ 1: "staff_not_found", 2: "staff_inactive", 3: "staff_not_found" });
  });

  it("角色与列不匹配、必填缺失、品牌 / 分公司编码不存在（H10）", async () => {
    const a = await actors();
    const v = await imp.precheck(a.adminCtx, {
      name: "x.csv",
      bytes: csv([
        ["甲", "总部人员", "13911110001", "HISENSE", "BR-BJ", ""], // hq 填了分公司
        ["乙", "经销商人员", "13800000001", "HISENSE", "", "S-A"], // staff 填了品牌
        ["丙", "超级管理员", "13911110003", "HISENSE", "", ""], // admin 填了品牌
        ["丁", "分公司人员", "13911110004", "HISENSE", "", ""], // 缺分公司
        ["戊", "总部人员", "13911110005", "", "", ""], // 缺品牌
        ["己", "总部人员", "13911110006", "NOPE", "", ""],
        ["庚", "分公司人员", "13911110007", "HISENSE", "NOPE", ""],
        ["", "总部人员", "13911110008", "HISENSE", "", ""],
        ["辛", "老板", "13911110009", "HISENSE", "", ""],
        ["壬", "总部人员", "123", "HISENSE", "", ""],
        ["癸", "总部人员", "13911110010", "HISENSE", "", "S-A"], // hq 填了门店编码
      ]),
    });
    expect(reasons(v)).toEqual({
      1: "scope_fields_not_allowed",
      2: "scope_fields_not_allowed",
      3: "scope_fields_not_allowed",
      4: "branch_required",
      5: "brand_required",
      6: "brand_not_found",
      7: "branch_not_found",
      8: "missing_required_field",
      9: "role_invalid",
      10: "phone_invalid",
      11: "scope_fields_not_allowed",
    });
  });

  it("角色名认中文名和角色码；品牌可用分号 / 顿号 / 竖线分隔", async () => {
    const a = await actors();
    const v = await imp.precheck(a.adminCtx, {
      name: "x.csv",
      bytes: csv([
        ["甲", "hq_manager", "13911110001", "HISENSE；HITACHI", "", ""],
        ["乙", "总部人员", "13911110002", "HISENSE、HITACHI|YORK", "", ""],
      ]),
    });
    expect(reasons(v)).toEqual({ 1: null, 2: null });
  });

  it("没有 user.manage 的人不能预检", async () => {
    await actors();
    await insertAccessUser(env, { role: "store_staff", phone: "13800000001", mediaStaffId: org.staffA });
    const staffCtx = await ctxOf("13800000001");
    expect(await errCode(imp.precheck(staffCtx, { name: "x.csv", bytes: fixture("basic.utf8.csv") }))).toBe("forbidden");
  });
});

describe("确认（H11、H12、H15）", () => {
  it("确认写入：每个新用户走与单个邀请相同的创建逻辑，每条有审计，批次 completed；不发短信（H12）", async () => {
    const a = await actors();
    const v = await imp.precheck(a.adminCtx, { name: "basic.csv", bytes: fixture("basic.utf8.csv") });
    const before = await counts();
    const done = await imp.confirm(a.adminCtx, BigInt(v.batchId));
    expect(done).toMatchObject({ status: "completed", alreadyCompleted: false, summary: expect.objectContaining({ imported: 3, conflict: 0, invalid: 0 }) });
    const after = await counts();
    expect(after.access - before.access).toBe(3);
    const users = await t.db.select().from(accessUsers).where(eq(accessUsers.createdByActor, a.adminCtx.actor));
    expect(users.map((u) => [u.roleCode, u.status]).sort()).toEqual([
      ["branch_manager", "pending_activation"],
      ["hq_manager", "pending_activation"],
      ["store_staff", "pending_activation"],
    ]);
    expect(users.find((u) => u.roleCode === "store_staff")!.mediaStaffId).toBe(org.staffA);
    const created = await t.db.select().from(auditEvents).where(eq(auditEvents.eventType, "user_created"));
    expect(created).toHaveLength(3);
    expect(created.every((e) => e.batchRef === BigInt(v.batchId))).toBe(true);
    expect(await t.db.select().from(auditEvents).where(eq(auditEvents.eventType, "user_import_confirmed"))).toHaveLength(1);
    expect(env.sender.sent).toHaveLength(0);
    // 再确认一次：幂等，不产生额外用户
    expect((await imp.confirm(a.adminCtx, BigInt(v.batchId))).alreadyCompleted).toBe(true);
    expect((await counts()).access).toBe(after.access);
  });

  it("越权行不写入：2 成功 1 跳过（批量 3 行含 1 行越权）", async () => {
    const a = await actors();
    const v = await imp.precheck(a.hqCtx, {
      name: "x.csv",
      bytes: csv([
        ["甲", "分公司人员", "13911110001", "HISENSE", "BR-BJ", ""],
        ["乙", "总部人员", "13911110002", "HISENSE", "", ""],
        ["丙", "经销商人员", "13800000001", "", "", "S-A"],
      ]),
    });
    const before = (await counts()).access;
    const done = await imp.confirm(a.hqCtx, BigInt(v.batchId));
    expect((await counts()).access - before).toBe(2);
    expect(done.summary).toMatchObject({ imported: 2 });
    expect(done.rows.map((r) => r.outcome)).toEqual(["imported", null, "imported"]);
  });

  it("预检后有人先建了同号用户，再确认：该行 conflict，不重复创建，其余行照常（H11）", async () => {
    const a = await actors();
    const v = await imp.precheck(a.adminCtx, { name: "basic.csv", bytes: fixture("basic.utf8.csv") });
    await insertAccessUser(env, { role: "branch_manager", phone: "13911110002", brandIds: [org.hisense], branchIds: [org.bj] });
    const before = (await counts()).access;
    const done = await imp.confirm(a.adminCtx, BigInt(v.batchId));
    expect(done.rows.map((r) => r.outcome)).toEqual(["imported", "conflict", "imported"]);
    expect(done.conflictRows).toBe(1);
    expect((await counts()).access - before).toBe(2);
    expect(await t.db.select().from(accessUsers).where(eq(accessUsers.phone, "13911110002"))).toHaveLength(1);
    // 冲突的那一行没有留下认证行（整行事务回滚）
    expect(await t.db.select().from(authUsers).where(eq(authUsers.phoneNumber, "13911110002"))).toHaveLength(1);
  });

  it("确认时重新校验：预检后操作者的授权变了 → 该行 invalid，不写入", async () => {
    const a = await actors();
    const v = await imp.precheck(a.bmCtx, { name: "x.csv", bytes: csv([["甲", "经销商人员", "13800000001", "", "", "S-A"]]) });
    // 预检之后，分公司人员的北京分公司范围被拿掉（换成上海）；ctx 是每请求现建的，这里重新认证
    await t.db.delete(accessUserBranches).where(eq(accessUserBranches.branchId, org.bj));
    await t.db.insert(accessUserBranches).values({ userId: BigInt(a.bmCtx.userId!), branchId: org.sh });
    const bm2 = await ctxOf("13000000003");
    const before = (await counts()).access;
    const done = await imp.confirm(bm2, BigInt(v.batchId));
    expect(done.rows[0]).toMatchObject({ outcome: "invalid", reasonCode: "store_not_in_scope" });
    expect((await counts()).access).toBe(before);
  });

  it("预检为 error 的行不会在确认时被升级为新增", async () => {
    const a = await actors();
    const holder = await insertAccessUser(env, { role: "branch_manager", phone: "13911110001", brandIds: [org.hisense], branchIds: [org.bj] });
    const v = await imp.precheck(a.adminCtx, { name: "x.csv", bytes: csv([["甲", "总部人员", "13911110001", "HISENSE", "", ""]]) });
    expect(reasons(v)).toEqual({ 1: "phone_exists" });
    await t.db.update(accessUsers).set({ status: "disabled", statusBeforeDisable: "active", disabledAt: env.clock.now(), disabledByActor: "user:0", disabledReason: "manual" }).where(eq(accessUsers.userId, holder));
    const before = (await counts()).access;
    await imp.confirm(a.adminCtx, BigInt(v.batchId));
    expect((await counts()).access).toBe(before);
  });

  it("重复提交同一文件：第二次全部 phone_exists，无额外用户（H15）", async () => {
    const a = await actors();
    const first = await imp.precheck(a.adminCtx, { name: "basic.csv", bytes: fixture("basic.utf8.csv") });
    await imp.confirm(a.adminCtx, BigInt(first.batchId));
    const base = (await counts()).access;
    const second = await imp.precheck(a.adminCtx, { name: "basic.csv", bytes: fixture("basic.utf8.csv") });
    expect(reasons(second)).toEqual({ 1: "phone_exists", 2: "phone_exists", 3: "phone_exists" });
    await imp.confirm(a.adminCtx, BigInt(second.batchId));
    expect((await counts()).access).toBe(base);
  });

  it("只有提交人能确认 / 查看 / 下载；他人（含更高级别）一律批次不存在", async () => {
    const a = await actors();
    const v = await imp.precheck(a.hqCtx, { name: "basic.csv", bytes: csv([["甲", "分公司人员", "13911110001", "HISENSE", "BR-BJ", ""]]) });
    for (const who of [a.adminCtx, a.bmCtx]) {
      expect(await errCode(imp.confirm(who, BigInt(v.batchId)))).toBe("batch_not_found");
      expect(await errCode(imp.get(who, BigInt(v.batchId)))).toBe("batch_not_found");
      expect(await errCode(imp.returnFile(who, BigInt(v.batchId)))).toBe("batch_not_found");
    }
    expect((await imp.get(a.hqCtx, BigInt(v.batchId))).batchId).toBe(v.batchId);
  });
});

describe("租约与续跑", () => {
  it("别的确认进程持有未陈旧租约 → batch_busy；心跳陈旧后可接手，已写入的行不重复", async () => {
    const a = await actors();
    const v = await imp.precheck(a.adminCtx, { name: "basic.csv", bytes: fixture("basic.utf8.csv") });
    const id = BigInt(v.batchId);
    // 模拟：另一个进程已认领并写完第 1 行后死亡
    await t.db.update(importBatches).set({ status: "writing", writingToken: "dead-process", heartbeatAt: env.clock.now() }).where(eq(importBatches.importBatchId, id));
    expect(await errCode(imp.confirm(a.adminCtx, id))).toBe("batch_busy");
    env.clock.advance(3 * 60_000); // 超过 2 分钟
    const done = await imp.confirm(a.adminCtx, id);
    expect(done.status).toBe("completed");
    expect(done.rows.map((r) => r.outcome)).toEqual(["imported", "imported", "imported"]);
  });
});

describe("回流文件（H13、H14）", () => {
  it("列 = 原 6 列 + 结果 / 原因 / 指引；只含没成功的行；手机号明文；提交人可下，记审计", async () => {
    const a = await actors();
    await insertAccessUser(env, { role: "branch_manager", phone: "13911110002", brandIds: [org.hisense], branchIds: [org.bj] });
    const v = await imp.precheck(a.hqCtx, {
      name: "分公司导入.csv",
      bytes: csv([
        ["甲", "分公司人员", "13911110001", "HISENSE", "BR-BJ", ""],
        ["=乙", "总部人员", "13911110003", "HISENSE", "", ""], // 越权，且姓名以 = 开头
        ["丙", "分公司人员", "13911110002", "HISENSE", "BR-BJ", ""], // 手机号已存在
      ]),
    });
    await imp.confirm(a.hqCtx, BigInt(v.batchId));
    const f = await imp.returnFile(a.hqCtx, BigInt(v.batchId));
    expect(f.fileName).toBe("分公司导入-回流.csv");
    expect(f.rows).toBe(2);
    expect(f.csv.startsWith("\uFEFF")).toBe(true);
    const lines = f.csv.slice(1).trim().split("\r\n");
    expect(lines[0]).toBe(RETURN_COLUMNS.join(","));
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("13911110003"); // 手机号明文
    expect(lines[1]).toContain("'=乙"); // 公式注入保护
    expect(lines[1]).toContain("role_not_grantable");
    expect(lines[1]).toContain("未导入");
    expect(lines[2]).toContain("phone_exists");
    expect(lines[2]).toMatch(/停用旧用户/);
    expect(await t.db.select().from(auditEvents).where(eq(auditEvents.eventType, "user_import_returnfile_downloaded"))).toHaveLength(1);
  });

  it("回流文件改后作为新文件重传：新批次，旧批次结果不变（H14）", async () => {
    const a = await actors();
    const first = await imp.precheck(a.hqCtx, { name: "a.csv", bytes: csv([["乙", "总部人员", "13911110003", "HISENSE", "", ""]]) });
    await imp.returnFile(a.hqCtx, BigInt(first.batchId));
    const fixed = new TextEncoder().encode(
      [USER_IMPORT_HEADER.join(","), "乙,分公司人员,13911110003,HISENSE,BR-BJ,"].join("\r\n") + "\r\n",
    );
    const second = await imp.precheck(a.hqCtx, { name: "a-fixed.csv", bytes: fixed });
    expect(second.batchId).not.toBe(first.batchId);
    expect(reasons(second)).toEqual({ 1: null });
    expect((await imp.get(a.hqCtx, BigInt(first.batchId))).rows.map((r) => r.reasonCode)).toEqual(["role_not_grantable"]);
    expect((await t.db.select().from(importRowResults)).length).toBe(2);
  });
});

describe("静态约束（H16）", () => {
  it("导入模块没有更新 / 覆盖已有用户的入口", () => {
    const src = readFileSync(new URL("./import.ts", import.meta.url), "utf8").replace(/\/\/.*$/gm, "");
    expect(src).not.toMatch(/update(Existing|User)|overwrite|upsert|onDuplicateKeyUpdate/i);
    expect(src).not.toMatch(/\.update\(\s*accessUsers\s*\)/);
  });
});
