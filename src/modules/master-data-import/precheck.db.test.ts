// 任务 3：预检（MD-1/2/3/4/6，acceptance A/B/E）。预检只写批次、行结果、待确认 issue，业务主档零写入。
import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { useTestDb } from "../../../tests/harness/db";
import { adminActor, bootstrapped, csv, importActor, seedStores } from "../../../tests/harness/master-data";
import { dataQualityIssues, importBatches, importRowResults, stores } from "../../db/schema";
import { MasterDataError } from "./errors";

const t = useTestDb();
const fx = (n: string): Uint8Array => readFileSync(new URL(`../../../tests/fixtures/master-data/${n}`, import.meta.url));
const one = async <T>(q: string): Promise<T> => ((await t.pool.query(q))[0] as T[])[0]!;
const businessState = async () => JSON.stringify(await Promise.all(["brands", "regions", "branches", "sectors", "dealers", "stores"].map((n) => one<{ c: string; m: string }>(`SELECT COUNT(*) c, MAX(updated_at) m FROM \`${n}\``))));

const classes = async (batchId: string) => {
  const rows = await t.db.select().from(importRowResults).where(eq(importRowResults.importBatchId, BigInt(batchId))).orderBy(importRowResults.rowNo);
  return rows.map((r) => `${r.rowNo}:${r.precheckClass}/${r.reasonCode}`);
};

describe("预检：六类、只读、可追溯", () => {
  it("六类各一行 + 一家消失的门店：计数、行结果、业务表零写入", async () => {
    const env = await bootstrapped(t);
    await seedStores(env, [{ storeCode: "S1" }, { storeCode: "S2" }, { storeCode: "S3" }, { storeCode: "S4" }]);
    const before = await businessState();

    const p = await env.md.imports.precheck(
      {
        fileName: "e.csv",
        mode: "import",
        bytes: csv([
          { storeCode: "S1" }, // unchanged
          { storeCode: "S2", name: "改名后" }, // update
          { storeCode: "S3", tier: "一级经销商旗舰店" }, // update（等级）
          { storeCode: "S5" }, // new
          { storeCode: "S6", dealerCode: "9000009", dealerName: "新商家" }, // needs_superadmin
          { storeCode: "S7", dealerCode: "--" }, // error
        ]),
      },
      env.importer,
    );
    expect(p.status).toBe("awaiting_confirm");
    expect(p.summary).toMatchObject({ mode: "import", new: 1, update: 2, unchanged: 1, error: 1, needs_superadmin: 1, pending_closure_stores: 1 });
    const s = p.summary;
    expect(s.new + s.update + s.unchanged + s.error + s.needs_superadmin).toBe(6); // 五类行分类之和 = 数据行数
    expect(await classes(p.batchId)).toEqual([
      "1:unchanged/null",
      "2:update/store_fields_changed",
      "3:update/store_fields_changed",
      "4:new/null",
      "5:needs_superadmin/dealer_not_found",
      "6:error/dealer_code_missing",
    ]);
    expect(await businessState()).toBe(before);

    // 每行恰好一条，raw_row 是 11 列原文
    const rows = await t.db.select().from(importRowResults).where(eq(importRowResults.importBatchId, BigInt(p.batchId)));
    expect(rows).toHaveLength(6);
    expect(Object.keys(rows[0]!.rawRow as object)).toHaveLength(11);
    expect(rows.every((r) => r.outcome === null)).toBe(true); // 预检不写 outcome

    // 批次账
    const [b] = await t.db.select().from(importBatches).where(eq(importBatches.importBatchId, BigInt(p.batchId)));
    expect(b).toMatchObject({ status: "awaiting_confirm", totalRows: 6, uploadedByActor: "service:test-import", templateVersion: "master-data-export.v1" });
    expect(b!.fileSha256).toHaveLength(32);
    expect(b!.newRows + b!.errorRows + b!.conflictRows + b!.skippedRows).toBe(0); // 主数据批次不写名单导入的四列
    // 待确认：S4 消失，仍 active
    const issues = await t.db.select().from(dataQualityIssues);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ issueCode: "store_missing_from_export", status: "open", entityType: "store", importBatchId: BigInt(p.batchId), batchId: null });
    const [s4] = await t.db.select().from(stores).where(eq(stores.storeCode, "S4"));
    expect(s4!.status).toBe("active");
    expect(issues[0]!.entityId).toBe(s4!.storeId);
    expect(issues[0]!.detail).toMatchObject({ store_code: "S4", brand_code: "hitachi", dealer_code: "9000001", sector_code: "110-home" });
  });

  it("同一文件连续预检两次：两个批次，分类与行号一致，无业务写入", async () => {
    const env = await bootstrapped(t);
    await seedStores(env, [{ storeCode: "S1" }]);
    const before = await businessState();
    const bytes = csv([{ storeCode: "S1" }, { storeCode: "S2" }]);
    const a = await env.md.imports.precheck({ fileName: "x.csv", bytes, mode: "import" }, env.importer);
    const b = await env.md.imports.precheck({ fileName: "x.csv", bytes, mode: "import" }, env.importer);
    expect(a.batchId).not.toBe(b.batchId);
    expect(await classes(a.batchId)).toEqual(await classes(b.batchId));
    expect(await businessState()).toBe(before);
  });

  it("UTF-8 与 GB18030 的同一份内容预检结果完全相同", async () => {
    const env = await bootstrapped(t);
    const a = await env.md.imports.precheck({ fileName: "u.csv", bytes: fx("small.utf8.csv"), mode: "structure" }, env.admin);
    const b = await env.md.imports.precheck({ fileName: "g.csv", bytes: fx("small.gb18030.csv"), mode: "structure" }, env.admin);
    expect(await classes(b.batchId)).toEqual(await classes(a.batchId));
    expect(a.summary.new).toBe(3);
    const rows = await t.db.select().from(importRowResults).where(eq(importRowResults.importBatchId, BigInt(b.batchId)));
    expect(JSON.stringify(rows.map((r) => r.rawRow))).not.toContain("\uFFFD");
  });

  it("文件级失败：不建批次、不写行；业务表零写入", async () => {
    const env = await bootstrapped(t);
    const bad: Array<[string, Uint8Array]> = [
      ["12 列", fx("with-owner-12cols.csv")],
      ["乱码", fx("garbage.bin")],
      ["空", new Uint8Array()],
      ["列数不一致", new TextEncoder().encode("门店名称,撤店情况\n只有一列\n")],
    ];
    for (const [, bytes] of bad) {
      await expect(env.md.imports.precheck({ fileName: "bad.csv", bytes, mode: "import" }, env.importer)).rejects.toBeInstanceOf(MasterDataError);
    }
    expect((await one<{ c: string }>("SELECT COUNT(*) c FROM import_batches")).c).toBe("0");
    expect((await one<{ c: string }>("SELECT COUNT(*) c FROM import_row_results")).c).toBe("0");
  });

  it("权限：import 模式要 import Capability；structure 模式要平台级身份", async () => {
    const env = await bootstrapped(t);
    const bytes = csv([{ storeCode: "S1" }]);
    await expect(env.md.imports.precheck({ fileName: "x.csv", bytes, mode: "structure" }, env.importer)).rejects.toMatchObject({ category: "authorization" });
    await expect(env.md.imports.precheck({ fileName: "x.csv", bytes, mode: "import" }, { ...adminActor(), capabilities: new Set() })).rejects.toMatchObject({ category: "authorization" });
    expect((await one<{ c: string }>("SELECT COUNT(*) c FROM import_batches")).c).toBe("0");
  });
});

describe("预检：分类细节（落库）", () => {
  it("品牌范围 {hitachi} 遇海信行 → error/brand_not_authorized；该行不影响其他行", async () => {
    const env = await bootstrapped(t);
    const p = await env.md.imports.precheck({ fileName: "x.csv", mode: "import", bytes: csv([{ storeCode: "A" }, { storeCode: "B", mainCode: "23" }]) }, importActor(["hitachi"]));
    expect(await classes(p.batchId)).toEqual(["1:needs_superadmin/dealer_not_found", "2:error/brand_not_authorized"]);
  });

  it("文件内重复：组内所有行 error，即使其中一行还缺经销商", async () => {
    const env = await bootstrapped(t);
    const p = await env.md.imports.precheck({ fileName: "x.csv", mode: "structure", bytes: csv([{ storeCode: "A" }, { storeCode: "A", dealerCode: "9000002" }, { storeCode: "B" }]) }, env.admin);
    expect(await classes(p.batchId)).toEqual(["1:error/duplicate_store_code_in_file", "2:error/duplicate_store_code_in_file", "3:new/create_dealer"]);
  });

  it("同一商家渠道编码在文件内对应两个名称 → 该编码下所有行 error", async () => {
    const env = await bootstrapped(t);
    const p = await env.md.imports.precheck({ fileName: "x.csv", mode: "structure", bytes: csv([{ storeCode: "A" }, { storeCode: "B", dealerName: "另一个名字" }, { storeCode: "C", dealerCode: "9000002" }]) }, env.admin);
    expect(await classes(p.batchId)).toEqual(["1:error/dealer_name_conflict_in_file", "2:error/dealer_name_conflict_in_file", "3:new/create_dealer"]);
  });

  it("structure 模式：新经销商 → new/create_dealer；不写结构", async () => {
    const env = await bootstrapped(t);
    const before = await businessState();
    const p = await env.md.imports.precheck({ fileName: "x.csv", mode: "structure", bytes: csv([{ storeCode: "A" }, { storeCode: "B" }]) }, env.admin);
    expect(p.summary).toMatchObject({ mode: "structure", new: 2 });
    expect(await businessState()).toBe(before);
  });

  it("已 closed 的门店再次出现 → update/reactivate_store；分公司名称写法不同只记提示", async () => {
    const env = await bootstrapped(t);
    await seedStores(env, [{ storeCode: "S1" }]);
    await t.db.update(stores).set({ status: "closed" }).where(eq(stores.storeCode, "S1"));
    const p = await env.md.imports.precheck({ fileName: "x.csv", mode: "import", bytes: csv([{ storeCode: "S1", branchName: "写法不同的上海分公司" }]) }, env.importer);
    expect(await classes(p.batchId)).toEqual(["1:update/reactivate_store"]);
    const [r] = await t.db.select().from(importRowResults).where(eq(importRowResults.importBatchId, BigInt(p.batchId)));
    expect(r!.reasonDetail).toContain("branch_name_differs");
  });

  it("门店换经销商 → needs_superadmin/store_relation_change（import）；structure 模式 update/change_store_relation", async () => {
    const env = await bootstrapped(t);
    await seedStores(env, [{ storeCode: "S1" }, { storeCode: "S2", dealerCode: "9000002", dealerName: "商家乙" }]);
    const bytes = csv([{ storeCode: "S1", dealerCode: "9000002", dealerName: "商家乙" }, { storeCode: "S2", dealerCode: "9000002", dealerName: "商家乙" }]);
    const a = await env.md.imports.precheck({ fileName: "x.csv", mode: "import", bytes }, env.importer);
    expect(await classes(a.batchId)).toEqual(["1:needs_superadmin/store_relation_change", "2:unchanged/null"]);
    const b = await env.md.imports.precheck({ fileName: "x.csv", mode: "structure", bytes }, env.admin);
    expect(await classes(b.batchId)).toEqual(["1:update/change_store_relation", "2:unchanged/null"]);
  });

  it("店面标准为空合法；预检的 store_id 命中既有门店", async () => {
    const env = await bootstrapped(t);
    await seedStores(env, [{ storeCode: "S1" }]);
    const p = await env.md.imports.precheck({ fileName: "x.csv", mode: "import", bytes: csv([{ storeCode: "S1", tier: "" }]) }, env.importer);
    expect(await classes(p.batchId)).toEqual(["1:update/store_fields_changed"]);
    const [r] = await t.db.select().from(importRowResults).where(eq(importRowResults.importBatchId, BigInt(p.batchId)));
    const [s] = await t.db.select().from(stores).where(eq(stores.storeCode, "S1"));
    expect(r!.storeId).toBe(s!.storeId);
  });
});

describe("待确认撤店（识别部分）", () => {
  it("只含日立行的文件不会把海信门店列为消失（范围 = 文件中出现的品牌）", async () => {
    const env = await bootstrapped(t);
    await seedStores(env, [{ storeCode: "H1" }, { storeCode: "H2" }, { storeCode: "K1", mainCode: "23", mainName: "海信家装" }, { storeCode: "K2", mainCode: "23", mainName: "海信家装" }]);
    const p = await env.md.imports.precheck({ fileName: "x.csv", mode: "import", bytes: csv([{ storeCode: "H1" }]) }, env.importer);
    expect(p.summary.pending_closure_stores).toBe(1); // 只有日立的 H2
    const issues = await t.db.select().from(dataQualityIssues);
    expect(issues.map((i) => (i.detail as { store_code: string }).store_code)).toEqual(["H2"]);
  });

  it("授权范围外的品牌不会产生待确认，即使文件里出现了它的行", async () => {
    const env = await bootstrapped(t);
    await seedStores(env, [{ storeCode: "H1" }, { storeCode: "K1", mainCode: "23", mainName: "海信家装" }, { storeCode: "K2", mainCode: "23", mainName: "海信家装" }]);
    const p = await env.md.imports.precheck({ fileName: "x.csv", mode: "import", bytes: csv([{ storeCode: "H1" }, { storeCode: "K1", mainCode: "23", mainName: "海信家装" }]) }, importActor(["hitachi"]));
    expect(p.summary.pending_closure_stores).toBe(0); // K2 在范围外
  });

  it("品牌无法解析的行里的门店编码不会被当作消失；已 closed 的门店不进入待确认", async () => {
    const env = await bootstrapped(t);
    await seedStores(env, [{ storeCode: "S1" }, { storeCode: "S2" }, { storeCode: "S3" }]);
    await t.db.update(stores).set({ status: "closed" }).where(eq(stores.storeCode, "S3"));
    const p = await env.md.imports.precheck({ fileName: "x.csv", mode: "import", bytes: csv([{ storeCode: "S1" }, { storeCode: "S2", mainCode: "14" }]) }, env.importer);
    expect(await classes(p.batchId)).toEqual(["1:unchanged/null", "2:error/main_business_code_unmapped"]);
    expect(p.summary.pending_closure_stores).toBe(0);
  });

  it("撤店情况=审核失败 的行：该行 error/row_withdrawn，门店仍在文件中出现，不进入待确认", async () => {
    const env = await bootstrapped(t);
    await seedStores(env, [{ storeCode: "S1" }, { storeCode: "S2" }]);
    const p = await env.md.imports.precheck({ fileName: "x.csv", mode: "import", bytes: csv([{ storeCode: "S1" }, { storeCode: "S2", withdrawn: "审核失败" }]) }, env.importer);
    expect(await classes(p.batchId)).toEqual(["1:unchanged/null", "2:error/row_withdrawn"]);
    expect(p.summary.pending_closure_stores).toBe(0);
    expect((await t.db.select().from(stores).where(eq(stores.storeCode, "S2")))[0]!.status).toBe("active");
  });

  it("待确认数占比超过 20% → suspect_incomplete_export；不超过则不提示", async () => {
    const env = await bootstrapped(t);
    await seedStores(env, Array.from({ length: 10 }, (_, i) => ({ storeCode: `S${i}` })));
    const few = await env.md.imports.precheck({ fileName: "x.csv", mode: "import", bytes: csv(Array.from({ length: 9 }, (_, i) => ({ storeCode: `S${i}` }))) }, env.importer);
    expect(few.summary).toMatchObject({ pending_closure_stores: 1, suspect_incomplete_export: false });
    const many = await env.md.imports.precheck({ fileName: "x.csv", mode: "import", bytes: csv(Array.from({ length: 5 }, (_, i) => ({ storeCode: `S${i}` }))) }, env.importer);
    expect(many.summary).toMatchObject({ pending_closure_stores: 5, suspect_incomplete_export: true });
  });

  it("不同批次对同一门店各有一条 issue；同一批次不重复", async () => {
    const env = await bootstrapped(t);
    await seedStores(env, [{ storeCode: "S1" }, { storeCode: "S2" }]);
    const bytes = csv([{ storeCode: "S1" }]);
    await env.md.imports.precheck({ fileName: "x.csv", mode: "import", bytes }, env.importer);
    await env.md.imports.precheck({ fileName: "x.csv", mode: "import", bytes }, env.importer);
    const [n] = (await t.db.select({ n: sql<number>`COUNT(*)` }).from(dataQualityIssues)) as Array<{ n: number }>;
    expect(Number(n!.n)).toBe(2);
  });
});

