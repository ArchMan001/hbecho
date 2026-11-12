// 任务 1 + 2：迁移与约束、bootstrap（MD-5、MD-12、D5、H4、H7、H12）。
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { expectRejected, useTestDb } from "../../../tests/harness/db";
import { adminActor, importActor, mdEnv, T0 } from "../../../tests/harness/master-data";
import { branches, brands, importBatches, importRowResults, sectors } from "../../db/schema";
import { loadSeed } from "./index";
import { MasterDataError } from "./errors";

const t = useTestDb();
const count = async (table: string): Promise<number> => {
  const [r] = await t.pool.query(`SELECT COUNT(*) c FROM \`${table}\``);
  return Number((r as Array<{ c: string }>)[0]!.c);
};

describe("导入表与约束（任务 1）", () => {
  it("import_batches / import_row_results 存在；v2 现有四个计数列仍在；precheck_class 与 outcome 可空", async () => {
    const [cols] = await t.pool.query(
      "SELECT table_name t, column_name c, is_nullable n FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name IN ('import_batches','import_row_results')",
    );
    const has = (tbl: string, col: string) => (cols as Array<{ t: string; c: string; n: string }>).find((x) => x.t === tbl && x.c === col);
    for (const c of ["new_rows", "skipped_rows", "error_rows", "conflict_rows", "summary", "writing_token", "heartbeat_at", "uploaded_by_actor", "confirmed_by_actor"]) {
      expect(has("import_batches", c), c).toBeTruthy();
    }
    expect(has("import_batches", "uploaded_by_user_id")!.n).toBe("YES");
    expect(has("import_row_results", "precheck_class")!.n).toBe("YES");
    expect(has("import_row_results", "outcome")!.n).toBe("YES");
    expect(has("import_row_results", "resolved_by_actor")).toBeTruthy();
  });

  it("没有 ON DELETE CASCADE；stores.source_batch_id 与 data_quality_issues.import_batch_id 有外键", async () => {
    const [rules] = await t.pool.query(
      "SELECT k.table_name t, k.column_name c FROM information_schema.key_column_usage k JOIN information_schema.referential_constraints r USING (constraint_schema, constraint_name) WHERE k.table_schema = DATABASE() AND r.delete_rule = 'CASCADE'",
    );
    expect(rules).toEqual([]);
    const [fks] = await t.pool.query(
      "SELECT table_name t, column_name c FROM information_schema.key_column_usage WHERE table_schema = DATABASE() AND referenced_table_name = 'import_batches'",
    );
    const pairs = (fks as Array<{ t: string; c: string }>).map((x) => `${x.t}.${x.c}`).sort();
    // activity_plan_* 的两个外键是 a-activity-plan（v2 §22）加的：名额与名单项记录来源批次
    expect(pairs).toEqual([
      "activity_plan_owners.claimed_batch_id",
      "activity_plan_roster.added_batch_id",
      "data_quality_issues.import_batch_id",
      "import_row_results.import_batch_id",
      "stores.source_batch_id",
    ]);
  });

  const batch = (over: Record<string, unknown> = {}) =>
    t.db.insert(importBatches).values({
      importKind: "master_data",
      uploadedByActor: "a",
      uploadedAt: T0,
      totalRows: 1,
      status: "awaiting_confirm",
      createdAt: T0,
      updatedAt: T0,
      ...over,
    });
  const rowResult = (batchId: bigint, over: Record<string, unknown> = {}) =>
    t.db.insert(importRowResults).values({ importBatchId: batchId, rowNo: 1, rawRow: {}, createdAt: T0, ...over });

  it("CHECK：import_kind、status、precheck_class、outcome、row_no", async () => {
    await expectRejected(batch({ importKind: "x" }), "ck_import_batches_kind");
    await expectRejected(batch({ status: "paused" }), "ck_import_batches_status");
    const [b] = await batch();
    const id = BigInt(b.insertId);
    await expectRejected(rowResult(id, { precheckClass: "pending_closure" }), "ck_import_rows_precheck");
    await expectRejected(rowResult(id, { outcome: "done" }), "ck_import_rows_outcome");
    await expectRejected(rowResult(id, { rowNo: 0 }), "ck_import_rows_row_no");
  });

  it("precheck_class 为 NULL 的行（名单导入式）可写入；同一批次同一行号只有一条", async () => {
    const [b] = await batch({ importKind: "roster", planId: 1n });
    const id = BigInt(b.insertId);
    await rowResult(id, { rowNo: 1 });
    await expectRejected(rowResult(id, { rowNo: 1 }), "uq_import_rows_batch_row");
  });

  it("data_quality_issues 的同步批次引用与导入批次引用不得同时非空", async () => {
    await expectRejected(
      t.pool.query(
        "INSERT INTO data_quality_issues (issue_fingerprint, issue_code, severity, status, batch_id, import_batch_id, detail, first_seen_at, last_seen_at, created_at, updated_at) VALUES (UNHEX(SHA2('x',256)), 'c', 'warning', 'open', 1, 1, '{}', NOW(), NOW(), NOW(), NOW())",
      ),
      "ck_issues_one_batch_kind",
    );
  });

  it("批次被引用后不能删除（RESTRICT）", async () => {
    const [b] = await batch();
    await rowResult(BigInt(b.insertId));
    await expectRejected(t.db.delete(importBatches).where(eq(importBatches.importBatchId, BigInt(b.insertId))), "fk_import_rows_batch");
  });
});

describe("bootstrap（任务 2）", () => {
  it("空库跑一次：3 品牌 / 4 大区 / 42 分公司 / 84 板块；板块编码带分公司前缀", async () => {
    const env = mdEnv(t);
    const r = await env.md.structure.bootstrap(loadSeed(), env.admin);
    expect([r.brands.created, r.regions.created, r.branches.created, r.sectors.created]).toEqual([3, 4, 42, 84]);
    expect([await count("brands"), await count("regions"), await count("branches"), await count("sectors")]).toEqual([3, 4, 42, 84]);
    const [s] = await t.db.select().from(sectors).where(eq(sectors.sectorCode, "110-water"));
    expect(s!.sectorName).toBe("水机");
    const [perBranch] = await t.pool.query("SELECT COUNT(*) n FROM (SELECT branch_id FROM sectors GROUP BY branch_id HAVING COUNT(*) = 2) x");
    expect(Number((perBranch as Array<{ n: string }>)[0]!.n)).toBe(42);
    expect(env.audit.of("bootstrap_completed")).toHaveLength(1);
  });

  it("再跑一次：计数不变，全部 unchanged，没有第二条审计之外的写入", async () => {
    const env = mdEnv(t);
    await env.md.structure.bootstrap(loadSeed(), env.admin);
    const r = await env.md.structure.bootstrap(loadSeed(), env.admin);
    expect(r).toEqual({
      brands: { created: 0, unchanged: 3, conflict: 0 },
      regions: { created: 0, unchanged: 4, conflict: 0 },
      branches: { created: 0, unchanged: 42, conflict: 0 },
      sectors: { created: 0, unchanged: 84, conflict: 0 },
    });
    expect(await count("sectors")).toBe(84);
  });

  it("自然键存在但字段不同 → conflict，不覆盖", async () => {
    const env = mdEnv(t);
    await env.md.structure.bootstrap(loadSeed(), env.admin);
    await t.db.update(brands).set({ brandName: "被人改过" }).where(eq(brands.brandCode, "hitachi"));
    await t.db.update(branches).set({ branchName: "被人改过" }).where(eq(branches.branchCode, "110"));
    const r = await env.md.structure.bootstrap(loadSeed(), env.admin);
    expect(r.brands.conflict).toBe(1);
    expect(r.branches.conflict).toBe(1);
    const [b] = await t.db.select().from(brands).where(eq(brands.brandCode, "hitachi"));
    expect(b!.brandName).toBe("被人改过");
  });

  it("新增分公司 = 种子补一行后重跑：只新增那一个分公司和它的两个板块", async () => {
    const env = mdEnv(t);
    await env.md.structure.bootstrap(loadSeed(), env.admin);
    const r = await env.md.structure.bootstrap([...loadSeed(), { regionCode: "1130", regionName: "华东", branchCode: "999", branchName: "新分公司" }], env.admin);
    expect([r.branches.created, r.sectors.created]).toEqual([1, 2]);
    expect(await count("regions")).toBe(4);
  });

  it("种子里一个分公司对应两个大区：整批失败（在写库之前）", async () => {
    const { parseSeed } = await import("./bootstrap");
    expect(() => parseSeed("大区编码,大区,分公司编码,分公司\n1,华东,110,甲\n2,北区,110,甲\n")).toThrow(MasterDataError);
    expect(await count("brands")).toBe(0);
  });

  it("非超管（import 能力 / 品牌范围不是 all）被拒绝，库中零写入", async () => {
    const env = mdEnv(t);
    await expect(env.md.structure.bootstrap(loadSeed(), importActor())).rejects.toMatchObject({ category: "authorization" });
    await expect(env.md.structure.bootstrap(loadSeed(), { ...adminActor(), brandScope: new Set(["hitachi"]) })).rejects.toMatchObject({ category: "authorization" });
    expect([await count("brands"), await count("regions"), await count("branches"), await count("sectors")]).toEqual([0, 0, 0, 0]);
    expect(env.audit.events).toEqual([]);
  });

  it("迁移幂等：再跑一次 migrate 无变更", async () => {
    const { runMigrations } = await import("../../db/client");
    const { createDb } = await import("../../db/client");
    await runMigrations(createDb(t.pool));
    // v2 的 35 张表（29 张数据底座 + 6 张活动计划）；b-access-control 的 11 张（auth_* / access_* / audit_events）、g-learning-min 的 6 张、c-signals 的 9 张不属于 v2，单独不计
    const [tables] = await t.pool.query(
      "SELECT COUNT(*) n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type='BASE TABLE' AND table_name <> '__drizzle_migrations' AND table_name NOT LIKE 'auth\\_%' AND table_name NOT LIKE 'access\\_%' AND table_name <> 'audit_events' AND table_name NOT IN ('courses','course_brand_scopes','tags','course_tags','learning_progress','course_media_deletions','content_features','comment_features','signal_history','signal_results','monitoring_segments','segment_images','signal_tasks','signal_cursors','signal_recompute_runs')",
    );
    expect(Number((tables as Array<{ n: string }>)[0]!.n)).toBe(35);
  });
});
