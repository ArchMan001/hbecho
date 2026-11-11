// 页面入口的读取辅助（web.ts）：名称补全、审计计数与读取授权、导入原始行的归属检查。
// 页面本身的端到端点击在 b-access-control 界面验收里逐条走；这里只证明页面依赖的数据形状与权限边界。
import { beforeEach, describe, expect, it } from "vitest";
import { accessEnv, insertAccessUser, loginAs, seedAccessOrg, type AccessEnv, type AccessOrg } from "../../../tests/harness/access";
import { useTestDb } from "../../../tests/harness/db";
import { USER_IMPORT_HEADER } from "./users/import";
import { createWebServices } from "./web";

const t = useTestDb();
let env: AccessEnv;
let org: AccessOrg;
let web: ReturnType<typeof createWebServices>;
beforeEach(async () => {
  env = accessEnv(t);
  org = await seedAccessOrg(env);
  web = createWebServices({ db: t.db, clock: env.clock, auth: env.auth });
});

const ctxOf = async (phone: string) => {
  const r = await web.authenticate(await loginAs(env, phone));
  if (!r.ok) throw new Error(r.reason);
  return r.ctx;
};
const csv = (rows: string[][]) => new TextEncoder().encode([USER_IMPORT_HEADER.join(","), ...rows.map((r) => r.join(","))].join("\r\n"));

describe("名称补全", () => {
  it("用户行带品牌 / 分公司 / 门店名称与创建者姓名；ID 不进展示字段", async () => {
    const admin = await insertAccessUser(env, { role: "platform_admin", phone: "13000000001", name: "超管甲" });
    await insertAccessUser(env, { role: "branch_manager", phone: "13000000002", name: "李强", brandIds: [org.hisense], branchIds: [org.bj], createdByActor: `user:${admin}` });
    await insertAccessUser(env, { role: "store_staff", phone: "13800000001", name: "专员甲", mediaStaffId: org.staffA });
    const ctx = await ctxOf("13000000001");
    const orgView = await web.directory();
    const rows = await web.decorateUsers(await web.admin.list(ctx), orgView);
    const bm = rows.find((r) => r.name === "李强")!;
    expect(bm.brandNames).toEqual(["海信"]);
    expect(bm.branchNames).toEqual(["北京分公司"]);
    const staff = rows.find((r) => r.name === "专员甲")!;
    expect(staff.storeLabel).toContain("北京海信店");
    expect(staff.brandNames).toEqual([]); // 门店专员的范围由门店决定，授权表里没有品牌行
    expect(rows.find((r) => r.name === "超管甲")!.lastLoginAt).not.toBeNull(); // loginAs 写了一条登录成功审计
  });
});

describe("审计页的读取", () => {
  it("只有超管能计数和读取；非超管被拒；操作者与对象显示姓名，服务身份显示为系统任务", async () => {
    await insertAccessUser(env, { role: "platform_admin", phone: "13000000001", name: "超管甲" });
    const hq = await insertAccessUser(env, { role: "hq_manager", phone: "13000000002", name: "王敏", brandIds: [org.hisense] });
    await env.audit.write({ actor: "service:access-worker", eventType: "audit_purged", outcome: "succeeded", reasonCode: "audit_purged" }, { risk: "low" });
    await env.audit.write({ actor: `user:${hq}`, actorUserId: hq, eventType: "password_changed", outcome: "succeeded", reasonCode: "password_changed", targetType: "user", targetId: hq.toString() }, { risk: "low" });
    const admin = await ctxOf("13000000001");
    const count = await web.auditReader.count(admin, {});
    expect(count.total).toBeGreaterThanOrEqual(2);
    const views = await web.decorateAudit(await web.auditReader.read(admin, { limit: 50 }));
    expect(views.find((v) => v.eventType === "audit_purged")).toMatchObject({ actorName: "访问控制维护任务", actorKind: "service" });
    expect(views.find((v) => v.eventType === "password_changed")).toMatchObject({ actorName: "王敏", targetName: "王敏", actorKind: "user" });
    const other = await ctxOf("13000000002");
    await expect(web.auditReader.count(other, {})).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("导入批次原始行", () => {
  it("提交人本人能读到原始行；其他人（含超管）读不到", async () => {
    await insertAccessUser(env, { role: "platform_admin", phone: "13000000001", name: "超管甲" });
    await insertAccessUser(env, { role: "branch_manager", phone: "13000000002", name: "李强", brandIds: [org.hisense], branchIds: [org.bj] });
    const bm = await ctxOf("13000000002");
    const batch = await web.imp.precheck(bm, { name: "u.csv", bytes: csv([["专员甲", "经销商人员", "13800000001", "", "", "S-A"]]) });
    const own = await web.importRows(bm, BigInt(batch.batchId));
    expect(own.raw.get(1)).toMatchObject({ 姓名: "专员甲", 门店编码: "S-A" });
    await expect(web.importRows(await ctxOf("13000000001"), BigInt(batch.batchId))).rejects.toMatchObject({ code: "batch_not_found" });
  });
});
