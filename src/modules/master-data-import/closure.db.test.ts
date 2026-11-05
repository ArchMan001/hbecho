// 任务 5：待确认撤店的确认、旧 issue 收敛、审计（MD-6/10，acceptance E1–E12、G5）。
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { useTestDb } from "../../../tests/harness/db";
import { bootstrapped, csv, seedStores, type MdEnv } from "../../../tests/harness/master-data";
import { dataQualityIssues, importBatches, stores } from "../../db/schema";

const t = useTestDb();
const byCode = async (code: string) => (await t.db.select().from(stores).where(eq(stores.storeCode, code)))[0]!;
const codes = (...xs: string[]) => xs.map((storeCode) => ({ storeCode }));
const precheck = (env: MdEnv, rows: Parameters<typeof csv>[0]) => env.md.imports.precheck({ fileName: "x.csv", bytes: csv(rows), mode: "import" }, env.importer);
const issuesOf = async (batchId: string) =>
  (await t.db.select().from(dataQualityIssues).where(eq(dataQualityIssues.importBatchId, BigInt(batchId)))).sort((a, b) => Number(a.entityId! - b.entityId!));

async function threeMissing(env: MdEnv) {
  await seedStores(env, codes("S1", "S2", "S3", "S4", "S5", "S6"));
  const p = await precheck(env, codes("S1", "S2", "S3")); // S4 S5 S6 消失
  const ids = await Promise.all(["S4", "S5", "S6"].map(async (c) => String((await byCode(c)).storeId)));
  return { p, ids };
}

describe("预检不关店；确认才关", () => {
  it("预检后消失门店全部仍 active，issue 数量等于消失门店数", async () => {
    const env = await bootstrapped(t);
    const { p } = await threeMissing(env);
    expect(p.summary.pending_closure_stores).toBe(3);
    expect((await issuesOf(p.batchId)).map((i) => i.status)).toEqual(["open", "open", "open"]);
    for (const c of ["S4", "S5", "S6"]) expect((await byCode(c)).status).toBe("active");
  });

  it("确认时不勾选任何门店：没有门店 closed，issue 仍 open", async () => {
    const env = await bootstrapped(t);
    const { p } = await threeMissing(env);
    await env.md.imports.confirm(p.batchId, {}, env.importer);
    for (const c of ["S4", "S5", "S6"]) expect((await byCode(c)).status).toBe("active");
    expect((await issuesOf(p.batchId)).map((i) => i.status)).toEqual(["open", "open", "open"]);
    expect(env.audit.of("store_closed")).toHaveLength(0);
  });

  it("勾选 3 家中 2 家：只有 2 家 closed，issue resolved 并记 actor；第 3 家 active 且 open；审计 store_closed ×2", async () => {
    const env = await bootstrapped(t);
    const { p, ids } = await threeMissing(env);
    const r = await env.md.imports.confirm(p.batchId, { closureStoreIds: [ids[0]!, ids[1]!] }, env.importer);
    expect(r.closedStores.sort()).toEqual([ids[0], ids[1]].sort());
    expect([(await byCode("S4")).status, (await byCode("S5")).status, (await byCode("S6")).status]).toEqual(["closed", "closed", "active"]);
    const issues = await issuesOf(p.batchId);
    expect(issues.map((i) => i.status)).toEqual(["resolved", "resolved", "open"]);
    expect(issues[0]).toMatchObject({ resolvedByActor: "service:test-import", resolutionNote: "confirmed_by_import" });
    expect(issues[0]!.resolvedAt).not.toBeNull();
    const ev = env.audit.of("store_closed");
    expect(ev).toHaveLength(2);
    expect(ev[0]).toMatchObject({ batch_id: p.batchId, before: { status: "active" }, after: { status: "closed" } });
    expect(JSON.stringify(ev)).not.toContain("raw"); // 审计不含整行原文
  });

  it("勾选了不属于本批待确认的门店：整条确认拒绝，批次仍 awaiting_confirm，零写入（包括本批的新门店）", async () => {
    const env = await bootstrapped(t);
    await seedStores(env, codes("S1", "S2", "S3"));
    const p = await precheck(env, [...codes("S1", "S9")]); // S9 new；S2 S3 消失
    const s1 = String((await byCode("S1")).storeId); // S1 在文件里，不是待确认
    await expect(env.md.imports.confirm(p.batchId, { closureStoreIds: [s1] }, env.importer)).rejects.toMatchObject({ code: "closure_store_not_pending" });
    await expect(env.md.imports.confirm(p.batchId, { closureStoreIds: ["abc"] }, env.importer)).rejects.toMatchObject({ code: "closure_store_not_pending" });
    const [b] = await t.db.select().from(importBatches).where(eq(importBatches.importBatchId, BigInt(p.batchId)));
    expect(b!.status).toBe("awaiting_confirm");
    expect((await t.db.select().from(stores).where(eq(stores.storeCode, "S9"))).length).toBe(0);
    expect((await byCode("S1")).status).toBe("active");
  });

  it("已 closed 的门店从文件消失不生成待确认项；确认关店后再预检不再提议同一家", async () => {
    const env = await bootstrapped(t);
    const { p, ids } = await threeMissing(env);
    await env.md.imports.confirm(p.batchId, { closureStoreIds: ids }, env.importer);
    const again = await precheck(env, codes("S1", "S2", "S3"));
    expect(again.summary.pending_closure_stores).toBe(0);
  });

  it("门店改码后，用新码的文件预检：命中原门店，不生成待确认项", async () => {
    const env = await bootstrapped(t);
    await seedStores(env, codes("S1", "S2"));
    const s2 = await byCode("S2");
    await env.md.structure.changeStoreCode(String(s2.storeId), "S2-NEW", env.admin);
    const p = await precheck(env, [{ storeCode: "S1" }, { storeCode: "S2-NEW", name: "门店-S2" }]);
    expect(p.summary).toMatchObject({ unchanged: 2, pending_closure_stores: 0 });
  });
});

describe("重复关闭", () => {
  it("两个批次都勾选了同一家：只有一个 closed 终态、一条 store_closed；第二个批次照常完成", async () => {
    const env = await bootstrapped(t);
    await seedStores(env, codes("S1", "S2"));
    const a = await precheck(env, codes("S1")); // S2 消失
    const b = await precheck(env, codes("S1")); // S2 消失
    const s2 = String((await byCode("S2")).storeId);
    const ra = await env.md.imports.confirm(a.batchId, { closureStoreIds: [s2] }, env.importer);
    const rb = await env.md.imports.confirm(b.batchId, { closureStoreIds: [s2] }, env.importer);
    expect(ra.closedStores).toEqual([s2]);
    expect(rb.closedStores).toEqual([]); // 已经是 closed，空操作
    expect(rb.status).toBe("completed");
    expect(env.audit.of("store_closed")).toHaveLength(1);
    expect((await byCode("S2")).status).toBe("closed");
  });
});

describe("旧批次遗留 issue 的收敛", () => {
  it("批次 B 确认时：被关闭的 → resolved(closed_by_other_batch)；重新出现的 → resolved(store_reappeared)；其余 → ignored(superseded)；B 自己接续", async () => {
    const env = await bootstrapped(t);
    await seedStores(env, codes("S1", "S2", "S3", "S4"));
    const a = await precheck(env, codes("S4")); // S1 S2 S3 消失（从未确认）
    const b = await precheck(env, codes("S2", "S4")); // S1 S3 消失；S2 重新出现
    const s1 = String((await byCode("S1")).storeId);
    await env.md.imports.confirm(b.batchId, { closureStoreIds: [s1] }, env.importer);

    const bySid = new Map((await issuesOf(a.batchId)).map((i) => [i.entityId, i]));
    const note = async (code: string) => bySid.get((await byCode(code)).storeId)!;
    expect(await note("S1")).toMatchObject({ status: "resolved", resolutionNote: "closed_by_other_batch" });
    expect(await note("S2")).toMatchObject({ status: "resolved", resolutionNote: "store_reappeared" });
    expect(await note("S3")).toMatchObject({ status: "ignored", resolutionNote: `superseded_by_batch:${b.batchId}` });

    // B 自己：S1 resolved（本批关闭），S3 仍 open 接续
    const own = new Map((await issuesOf(b.batchId)).map((i) => [i.entityId, i]));
    expect(own.get((await byCode("S1")).storeId)).toMatchObject({ status: "resolved", resolutionNote: "confirmed_by_import" });
    expect(own.get((await byCode("S3")).storeId)!.status).toBe("open");
    // 没有任何旧批次的 issue 停留在 open
    const open = (await t.db.select().from(dataQualityIssues).where(eq(dataQualityIssues.status, "open"))).filter((i) => i.importBatchId === BigInt(a.batchId));
    expect(open).toEqual([]);
  });
});
