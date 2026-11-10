// 规模演练（任务 12）：1,000 行用户导入的预检与确认耗时、内存。数字记入 design §12。
// 阈值很宽松，只防止退化到不可用；真实数字看 stdout 的 [perf] 行。
import { describe, expect, it } from "vitest";
import { accessEnv, accessLinkage, insertAccessUser, loginAs, seedAccessOrg } from "../../../../tests/harness/access";
import { useTestDb } from "../../../../tests/harness/db";
import { createAuthenticator } from "../authenticate";
import { createAuthorizer } from "../authorize";
import { createOrgDirectory } from "../scope";
import { createUserAdmin } from "./admin";
import { createUserImport, USER_IMPORT_HEADER } from "./import";

const t = useTestDb();

describe("1,000 行用户导入", () => {
  it("预检 + 确认在可接受时间内完成（含 300 行门店专员，每行都要定位专员）", async () => {
    const env = accessEnv(t);
    const org = await seedAccessOrg(env);
    // 300 个专员（手机号 138 00 01xx xx），都在 A 店
    const staffRows: unknown[][] = [];
    for (let i = 0; i < 300; i++) staffRows.push([org.storeA, `专员${i}`, `1380001${String(i).padStart(4, "0")}`, "active"]);
    await t.pool.query("INSERT INTO media_staff (store_id, staff_name, phone, status, created_at, updated_at) VALUES " + staffRows.map(() => "(?, ?, ?, ?, NOW(6), NOW(6))").join(","), staffRows.flat());

    await insertAccessUser(env, { role: "platform_admin", phone: "13000000001" });
    const dir = createOrgDirectory(t.db);
    const authn = createAuthenticator({ db: t.db, auth: env.auth, dir, linkage: accessLinkage(env, { dir }) });
    const r = await authn.authenticate(await loginAs(env, "13000000001"));
    if (!r.ok) throw new Error(r.reason);
    const admin = createUserAdmin({ db: t.db, clock: env.clock, audit: env.audit, dir, authorizer: createAuthorizer() });
    const imp = createUserImport({ db: t.db, clock: env.clock, audit: env.audit, admin });

    const lines: string[] = [];
    for (let i = 0; i < 700; i++) lines.push(`总部${i},总部人员,1391${String(i).padStart(7, "0")},HISENSE;HITACHI,,`);
    for (let i = 0; i < 300; i++) lines.push(`专员${i},经销商人员,1380001${String(i).padStart(4, "0")},,,S-A`);
    const bytes = new TextEncoder().encode([USER_IMPORT_HEADER.join(","), ...lines].join("\r\n") + "\r\n");

    const t0 = Date.now();
    const v = await imp.precheck(r.ctx, { name: "1000.csv", bytes });
    const t1 = Date.now();
    expect(v).toMatchObject({ totalRows: 1000, newRows: 1000, errorRows: 0 });
    const done = await imp.confirm(r.ctx, BigInt(v.batchId));
    const t2 = Date.now();
    expect(done.summary).toMatchObject({ imported: 1000, conflict: 0, invalid: 0 });
    process.stderr.write(`[perf] 1000 行用户导入：预检 ${t1 - t0} ms，确认 ${t2 - t1} ms，RSS ${Math.round(process.memoryUsage().rss / 1048576)} MB\n`);
    expect(t1 - t0).toBeLessThan(60_000);
    expect(t2 - t1).toBeLessThan(120_000);
  }, 240_000);
});
