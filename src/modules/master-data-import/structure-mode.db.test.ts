// 任务 6：structure 模式与门店改码（MD-5，acceptance D1–D7、C13）。
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { useTestDb } from "../../../tests/harness/db";
import { adminActor, bootstrapped, csv, importActor, seedStores, type MdEnv } from "../../../tests/harness/master-data";
import { dealers, importRowResults, stores } from "../../db/schema";

const t = useTestDb();
const n = async (table: string): Promise<number> => Number((((await t.pool.query(`SELECT COUNT(*) c FROM \`${table}\``))[0]) as Array<{ c: string }>)[0]!.c);
const structureCounts = async () => [await n("brands"), await n("regions"), await n("branches"), await n("sectors")];
const byCode = async (code: string) => (await t.db.select().from(stores).where(eq(stores.storeCode, code)))[0]!;
const dealerBy = async (code: string) => (await t.db.select().from(dealers).where(eq(dealers.dealerCode, code)))[0];
const outcomes = async (batchId: string) =>
  (await t.db.select().from(importRowResults).where(eq(importRowResults.importBatchId, BigInt(batchId))).orderBy(importRowResults.rowNo)).map((r) => `${r.rowNo}:${r.outcome}/${r.reasonCode ?? ""}`);
const run = async (env: MdEnv, rows: Parameters<typeof csv>[0], mode: "import" | "structure") => {
  const p = await env.md.imports.precheck({ fileName: "x.csv", bytes: csv(rows), mode }, mode === "import" ? env.importer : env.admin);
  return { p, r: await env.md.imports.confirm(p.batchId, {}, mode === "import" ? env.importer : env.admin) };
};

describe("structure 模式确认", () => {
  const file = [
    { storeCode: "A1", dealerCode: "9000001", dealerName: "商家甲" },
    { storeCode: "A2", dealerCode: "9000001", dealerName: "商家甲" }, // 同一新经销商被多行引用
    { storeCode: "B1", dealerCode: "9000002", dealerName: "商家乙", mainCode: "23", mainName: "海信家装" },
  ];

  it("同一文件先用 import 模式：结构类行全是 Q，经销商与门店零写入；再用 structure 模式：经销商、门店写入，品牌/大区/分公司/板块数量不变", async () => {
    const env = await bootstrapped(t);
    const base = await structureCounts();
    const imp = await run(env, file, "import");
    expect(imp.r.summary).toMatchObject({ imported: 0, needs_superadmin: 3 });
    expect([await n("dealers"), await n("stores")]).toEqual([0, 0]);

    const st = await run(env, file, "structure");
    expect(await outcomes(st.p.batchId)).toEqual(["1:imported/create_dealer", "2:imported/create_dealer", "3:imported/create_dealer"]);
    expect([await n("dealers"), await n("stores")]).toEqual([2, 3]); // 同一经销商只建一次
    expect(await structureCounts()).toEqual(base);
    expect(env.audit.of("structure_changed").filter((e) => e.reason_code === "create_dealer")).toHaveLength(2);

    // 同一超管再用 import 模式确认同一文件：结构不变，行全是 unchanged
    const again = await run(env, file, "import");
    expect(again.p.summary).toMatchObject({ unchanged: 3 });
  });

  it("重复执行同一 structure 模式导入（新批次）：全部 unchanged，没有第二条记录", async () => {
    const env = await bootstrapped(t);
    await run(env, file, "structure");
    const again = await run(env, file, "structure");
    expect(again.p.summary).toMatchObject({ unchanged: 3, new: 0, update: 0 });
    expect(again.r.summary).toMatchObject({ imported: 0, unchanged_written: 3 });
    expect([await n("dealers"), await n("stores")]).toEqual([2, 3]);
  });

  it("经销商改名 / 启用 / 门店换经销商：写入当前值；同经销商后续行不被误判 precheck_stale（已收敛）", async () => {
    const env = await bootstrapped(t);
    await seedStores(env, [
      { storeCode: "S1", dealerCode: "9000001", dealerName: "商家甲" },
      { storeCode: "S2", dealerCode: "9000001", dealerName: "商家甲" },
      { storeCode: "S3", dealerCode: "9000002", dealerName: "商家乙" },
    ]);
    await t.db.update(dealers).set({ status: "inactive" }).where(eq(dealers.dealerCode, "9000002"));
    const { p, r } = await run(
      env,
      [
        { storeCode: "S1", dealerCode: "9000001", dealerName: "商家甲（改名）" }, // 改名
        { storeCode: "S2", dealerCode: "9000001", dealerName: "商家甲（改名）" }, // 同一经销商：前一行已改名，这一行收敛
        { storeCode: "S3", dealerCode: "9000002", dealerName: "商家乙" }, // 启用
      ],
      "structure",
    );
    expect(p.summary).toMatchObject({ update: 3 });
    expect(await outcomes(p.batchId)).toEqual(["1:imported/update_dealer_name", "2:unchanged/update_dealer_name", "3:imported/activate_dealer"]);
    expect(r.summary).toMatchObject({ imported: 2, unchanged_written: 1, conflict: 0 });
    expect((await dealerBy("9000001"))!.dealerName).toBe("商家甲（改名）");
    expect((await dealerBy("9000002"))!.status).toBe("active");

    // 门店换经销商
    const move = await run(env, [{ storeCode: "S1", dealerCode: "9000002", dealerName: "商家乙" }, { storeCode: "S2", dealerCode: "9000001", dealerName: "商家甲（改名）" }, { storeCode: "S3", dealerCode: "9000002", dealerName: "商家乙" }], "structure");
    expect(await outcomes(move.p.batchId)).toEqual(["1:imported/change_store_relation", "2:unchanged/", "3:unchanged/"]);
    expect((await byCode("S1")).dealerId).toBe((await dealerBy("9000002"))!.dealerId);
    expect(env.audit.of("structure_changed").some((e) => e.reason_code === "change_store_relation")).toBe(true);
  });

  it("structure 模式不创建品牌 / 大区 / 分公司 / 板块：未知分公司仍是 Q，确认后什么都不建", async () => {
    const env = await bootstrapped(t);
    const base = await structureCounts();
    const { p, r } = await run(env, [{ storeCode: "A1", branchCode: "999", branchName: "不存在的分公司" }], "structure");
    expect(await outcomes(p.batchId)).toEqual(["1:null/branch_not_found"]);
    expect(r.summary.imported).toBe(0);
    expect(await structureCounts()).toEqual(base);
    expect([await n("dealers"), await n("stores")]).toEqual([0, 0]);
  });

  it("非超管不能确认 structure 模式批次，零写入", async () => {
    const env = await bootstrapped(t);
    const p = await env.md.imports.precheck({ fileName: "x.csv", bytes: csv(file), mode: "structure" }, env.admin);
    await expect(env.md.imports.confirm(p.batchId, {}, importActor())).rejects.toMatchObject({ category: "authorization" });
    expect([await n("dealers"), await n("stores")]).toEqual([0, 0]);
  });
});

describe("门店改码", () => {
  it("store_id 不变；新码可命中，旧码不再命中；记审计", async () => {
    const env = await bootstrapped(t);
    await seedStores(env, [{ storeCode: "OLD" }]);
    const before = await byCode("OLD");
    const r = await env.md.structure.changeStoreCode(String(before.storeId), " NEW ", env.admin);
    expect(r).toMatchObject({ result: "changed", storeCode: "NEW" });
    const after = await byCode("NEW");
    expect(after.storeId).toBe(before.storeId);
    expect((await t.db.select().from(stores).where(eq(stores.storeCode, "OLD"))).length).toBe(0);
    expect(env.audit.of("structure_changed").at(-1)).toMatchObject({ reason_code: "change_store_code", before: { store_code: "OLD" }, after: { store_code: "NEW" } });
    // 重复执行是 unchanged
    expect((await env.md.structure.changeStoreCode(String(before.storeId), "NEW", env.admin)).result).toBe("unchanged");
  });

  it("新码与同品牌其他门店冲突 → 冲突，原码不变；不同品牌同码允许", async () => {
    const env = await bootstrapped(t);
    await seedStores(env, [{ storeCode: "A" }, { storeCode: "B" }, { storeCode: "K", mainCode: "23", mainName: "海信家装" }]);
    await expect(env.md.structure.changeStoreCode(String((await byCode("A")).storeId), "B", env.admin)).rejects.toMatchObject({ category: "conflict", code: "store_code_conflict" });
    expect((await byCode("A")).storeCode).toBe("A");
    expect((await env.md.structure.changeStoreCode(String((await byCode("K")).storeId), "A", env.admin)).result).toBe("changed");
  });

  it("非超管被拒；门店不存在 → 未找到；非法输入", async () => {
    const env = await bootstrapped(t);
    await seedStores(env, [{ storeCode: "A" }]);
    const id = String((await byCode("A")).storeId);
    await expect(env.md.structure.changeStoreCode(id, "X", importActor())).rejects.toMatchObject({ category: "authorization" });
    await expect(env.md.structure.changeStoreCode(id, "X", { ...adminActor(), brandScope: new Set(["hitachi"]) })).rejects.toMatchObject({ category: "authorization" });
    await expect(env.md.structure.changeStoreCode("999999", "X", env.admin)).rejects.toMatchObject({ category: "not_found" });
    await expect(env.md.structure.changeStoreCode(id, "  ", env.admin)).rejects.toMatchObject({ category: "input" });
    expect((await byCode("A")).storeCode).toBe("A");
  });
});
