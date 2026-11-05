// 任务 4：import 模式确认写入（MD-4/7/9/12，acceptance C、D1–D2）。
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { useTestDb } from "../../../tests/harness/db";
import { bootstrapped, csv, importActor, mdEnv, seedStores, T0, type MdEnv } from "../../../tests/harness/master-data";
import { dealers, importBatches, importRowResults, stores } from "../../db/schema";

const t = useTestDb();
const one = async <T>(q: string): Promise<T> => ((await t.pool.query(q))[0] as T[])[0]!;
const outcomes = async (batchId: string) =>
  (await t.db.select().from(importRowResults).where(eq(importRowResults.importBatchId, BigInt(batchId))).orderBy(importRowResults.rowNo)).map((r) => `${r.rowNo}:${r.outcome ?? "null"}${r.reasonCode ? `/${r.reasonCode}` : ""}`);
const storeBy = async (code: string) => (await t.db.select().from(stores).where(eq(stores.storeCode, code)))[0];
const precheck = (env: MdEnv, rows: Parameters<typeof csv>[0], mode: "import" | "structure" = "import") =>
  env.md.imports.precheck({ fileName: "x.csv", bytes: csv(rows), mode }, mode === "import" ? env.importer : env.admin);

describe("确认写入（import 模式）", () => {
  it("new / update / unchanged：门店新建、改名改级生效；unchanged 行不改 updated_at 与 source_batch_id", async () => {
    const env = await bootstrapped(t);
    const seedBatch = await seedStores(env, [{ storeCode: "S1" }, { storeCode: "S2" }, { storeCode: "S3" }]);
    const s1 = (await storeBy("S1"))!;
    env.clock.advance(60_000);
    const p = await precheck(env, [{ storeCode: "S1" }, { storeCode: "S2", name: "改名后" }, { storeCode: "S3", tier: "一级经销商旗舰店" }, { storeCode: "S9" }]);
    const r = await env.md.imports.confirm(p.batchId, {}, env.importer);
    expect(r).toMatchObject({ status: "completed", alreadyCompleted: false, closedStores: [] });
    expect(r.summary).toMatchObject({ imported: 3, unchanged_written: 1, conflict: 0 });
    expect(await outcomes(p.batchId)).toEqual(["1:unchanged", "2:imported/store_fields_changed", "3:imported/store_fields_changed", "4:imported"]);

    const after1 = (await storeBy("S1"))!;
    expect(after1.updatedAt).toEqual(s1.updatedAt);
    expect(after1.sourceBatchId).toBe(BigInt(seedBatch)); // unchanged：不写 source_batch_id
    expect((await storeBy("S2"))).toMatchObject({ storeName: "改名后", sourceBatchId: BigInt(p.batchId) });
    expect((await storeBy("S3"))!.storeTier).toBe("一级经销商旗舰店");
    const s9 = (await storeBy("S9"))!;
    expect(s9).toMatchObject({ sourceBatchId: BigInt(p.batchId), status: "active", storeName: "门店-S9" });
    const [b] = await t.db.select().from(importBatches).where(eq(importBatches.importBatchId, BigInt(p.batchId)));
    expect(b).toMatchObject({ status: "completed", confirmedByActor: "service:test-import", writingToken: null, heartbeatAt: null });
    expect(b!.confirmedAt).toEqual(new Date(T0.getTime() + 60_000));
    expect(env.audit.of("import_confirmed").filter((e) => e.batch_id === p.batchId)).toHaveLength(1);
  });

  it("店面标准为空 → store_tier 是 NULL，不是空串", async () => {
    const env = await bootstrapped(t);
    await seedStores(env, [{ storeCode: "S1" }]);
    const p = await precheck(env, [{ storeCode: "S1", tier: "" }, { storeCode: "S2", tier: "" }]);
    await env.md.imports.confirm(p.batchId, {}, env.importer);
    expect((await storeBy("S1"))!.storeTier).toBeNull();
    expect((await storeBy("S2"))!.storeTier).toBeNull();
  });

  it("已撤店门店再次出现：恢复 active，store_id 不变，审计 store_reactivated", async () => {
    const env = await bootstrapped(t);
    await seedStores(env, [{ storeCode: "S1" }]);
    const before = (await storeBy("S1"))!;
    await t.db.update(stores).set({ status: "closed" }).where(eq(stores.storeCode, "S1"));
    const p = await precheck(env, [{ storeCode: "S1" }]);
    await env.md.imports.confirm(p.batchId, {}, env.importer);
    const after = (await storeBy("S1"))!;
    expect(after).toMatchObject({ status: "active", storeId: before.storeId });
    expect(env.audit.of("store_reactivated")).toMatchObject([{ target_id: String(before.storeId), target_code: "S1", batch_id: p.batchId }]);
  });

  it("同一批次连续 confirm 两次：第二次不再写，返回同一汇总，审计不重复", async () => {
    const env = await bootstrapped(t);
    await seedStores(env, [{ storeCode: "S1" }]);
    const p = await precheck(env, [{ storeCode: "S1" }, { storeCode: "S2" }]);
    const a = await env.md.imports.confirm(p.batchId, {}, env.importer);
    const n1 = await one<{ c: string }>("SELECT COUNT(*) c FROM stores");
    const b = await env.md.imports.confirm(p.batchId, {}, env.importer);
    expect(b.alreadyCompleted).toBe(true);
    expect(b.summary).toEqual(a.summary);
    expect(await one("SELECT COUNT(*) c FROM stores")).toEqual(n1);
    expect(env.audit.of("import_confirmed").filter((e) => e.batch_id === p.batchId)).toHaveLength(1);
  });

  it("预检不通过的行不写：新经销商 / 换关系 → needs_superadmin，门店与经销商不变", async () => {
    const env = await bootstrapped(t);
    await seedStores(env, [{ storeCode: "S1" }, { storeCode: "S2", dealerCode: "9000002", dealerName: "商家乙" }]);
    const dealers0 = await one<{ c: string }>("SELECT COUNT(*) c FROM dealers");
    const p = await precheck(env, [
      { storeCode: "S1", dealerCode: "9000002", dealerName: "商家乙" }, // 换关系
      { storeCode: "S5", dealerCode: "9000009", dealerName: "新商家" }, // 新经销商
      { storeCode: "S6", dealerCode: "--" }, // error
    ]);
    const r = await env.md.imports.confirm(p.batchId, {}, env.importer);
    expect(r.summary).toMatchObject({ imported: 0, conflict: 0, needs_superadmin: 2, error: 1 });
    expect(await outcomes(p.batchId)).toEqual(["1:null/store_relation_change", "2:null/dealer_not_found", "3:null/dealer_code_missing"]);
    expect(await one("SELECT COUNT(*) c FROM dealers")).toEqual(dealers0);
    expect(await storeBy("S5")).toBeUndefined();
    const s1 = (await storeBy("S1"))!;
    const d1 = (await t.db.select().from(dealers).where(eq(dealers.dealerCode, "9000001")))[0]!;
    expect(s1.dealerId).toBe(d1.dealerId);
  });

  it("权限：import 身份不能确认 structure 模式批次（并记 import_confirmation_rejected）；不存在的批次稳定「未找到」", async () => {
    const env = await bootstrapped(t);
    const p = await precheck(env, [{ storeCode: "S1" }], "structure");
    await expect(env.md.imports.confirm(p.batchId, {}, env.importer)).rejects.toMatchObject({ category: "authorization" });
    expect(env.audit.of("import_confirmation_rejected")).toHaveLength(1);
    expect(await storeBy("S1")).toBeUndefined();
    await expect(env.md.imports.confirm("999999", {}, env.admin)).rejects.toMatchObject({ category: "not_found" });
    await expect(env.md.imports.confirm("abc", {}, env.admin)).rejects.toMatchObject({ category: "input" });
  });

  it("预检失败 / 未完成的批次不能确认", async () => {
    const env = await bootstrapped(t);
    const p = await precheck(env, [{ storeCode: "S1" }]);
    await t.db.update(importBatches).set({ status: "precheck_failed" }).where(eq(importBatches.importBatchId, BigInt(p.batchId)));
    await expect(env.md.imports.confirm(p.batchId, {}, env.importer)).rejects.toMatchObject({ code: "batch_not_confirmable" });
  });
});

describe("确认写入：预检之后事实变化", () => {
  it("人为改了一行门店的经销商 → 该行 conflict/precheck_stale，门店不变，其他行正常", async () => {
    const env = await bootstrapped(t);
    await seedStores(env, [{ storeCode: "S1" }, { storeCode: "S2" }, { storeCode: "S3", dealerCode: "9000002", dealerName: "商家乙" }]);
    const p = await precheck(env, [{ storeCode: "S1", name: "新名1" }, { storeCode: "S2", name: "新名2" }]);
    const d2 = (await t.db.select().from(dealers).where(eq(dealers.dealerCode, "9000002")))[0]!;
    await t.db.update(stores).set({ dealerId: d2.dealerId }).where(eq(stores.storeCode, "S1"));
    const r = await env.md.imports.confirm(p.batchId, {}, env.importer);
    expect(await outcomes(p.batchId)).toEqual(["1:conflict/precheck_stale", "2:imported/store_fields_changed"]);
    expect(r.summary).toMatchObject({ imported: 1, conflict: 1 });
    expect((await storeBy("S1"))!.storeName).toBe("门店-S1");
    expect((await storeBy("S2"))!.storeName).toBe("新名2");
    expect(r.alreadyCompleted).toBe(false);
  });

  it("预检后别处已建同编码门店（new → 已存在）→ conflict/precheck_stale", async () => {
    const env = await bootstrapped(t);
    await seedStores(env, [{ storeCode: "S1" }]);
    const p = await precheck(env, [{ storeCode: "S2" }]);
    const s1 = (await storeBy("S1"))!;
    await t.db.insert(stores).values({ storeCode: "S2", storeName: "别处建的", dealerId: s1.dealerId, brandId: s1.brandId, sectorId: s1.sectorId, status: "active", createdAt: T0, updatedAt: T0 });
    await env.md.imports.confirm(p.batchId, {}, env.importer);
    expect(await outcomes(p.batchId)).toEqual(["1:conflict/precheck_stale"]);
    expect((await storeBy("S2"))!.storeName).toBe("别处建的");
  });

  it("单行唯一键竞争（分类之后、写入之前另一连接插入同码门店）→ conflict/store_unique_conflict，其他行写入，批次 completed", async () => {
    const base = await bootstrapped(t);
    await seedStores(base, [{ storeCode: "S1" }]);
    const env = mdEnv(t, {
      hooks: {
        beforeApply: async (rowNo) => {
          if (rowNo !== 2) return;
          const s1 = (await storeBy("S1"))!;
          await t.db.insert(stores).values({ storeCode: "RACE", storeName: "竞争者", dealerId: s1.dealerId, brandId: s1.brandId, sectorId: s1.sectorId, status: "active", createdAt: T0, updatedAt: T0 });
        },
      },
    });
    const p = await precheck(env, [{ storeCode: "A" }, { storeCode: "RACE" }, { storeCode: "C" }]);
    const r = await env.md.imports.confirm(p.batchId, {}, env.importer);
    expect(await outcomes(p.batchId)).toEqual(["1:imported", "2:conflict/store_unique_conflict", "3:imported"]);
    expect(r.status).toBe("completed");
    expect((await storeBy("RACE"))!.storeName).toBe("竞争者");
    expect(await storeBy("A")).toBeDefined();
    expect(await storeBy("C")).toBeDefined();
  });
});

describe("确认写入：租约、续跑、超时", () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ storeCode: `N${String(i).padStart(2, "0")}` }));
  const crashAfter = (n: number) => ({
    chunkSize: 2,
    hooks: {
      afterChunk: (k: number) => {
        if (k === n) throw new Error("simulated kill");
      },
    },
  });

  it("第 2 块后进程被杀：心跳新鲜时另一个 confirm 得到稳定冲突；租约陈旧后续跑完成，已 imported 的行不被改写，门店与审计不重复", async () => {
    const base = await bootstrapped(t);
    await seedStores(base, [{ storeCode: "R1" }]);
    const env = mdEnv(t, crashAfter(2));
    await t.db.update(stores).set({ status: "closed" }).where(eq(stores.storeCode, "R1"));
    const p = await precheck(env, [{ storeCode: "R1" }, ...rows(6)]); // 第 1 行是恢复已撤店，在第 1 块里
    await expect(env.md.imports.confirm(p.batchId, {}, env.importer)).rejects.toThrow("simulated kill");

    const mid = await outcomes(p.batchId);
    expect(mid.filter((x) => x.includes("imported"))).toHaveLength(4); // 前两块共 4 行
    expect(mid.filter((x) => x.endsWith(":null"))).toHaveLength(3);
    const [b] = await t.db.select().from(importBatches).where(eq(importBatches.importBatchId, BigInt(p.batchId)));
    expect(b!.status).toBe("writing");

    // 心跳新鲜：不允许并发接手
    const env2 = mdEnv(t, { chunkSize: 2 });
    await expect(env2.md.imports.confirm(p.batchId, {}, env2.importer)).rejects.toMatchObject({ code: "batch_in_progress", category: "conflict" });

    // 租约陈旧（>2 分钟）后续跑
    env.clock.advance(3 * 60_000);
    const resume = mdEnv(t, { chunkSize: 2 });
    resume.clock.set(env.clock.now());
    const r = await resume.md.imports.confirm(p.batchId, {}, resume.importer);
    expect(r.status).toBe("completed");
    const after = await outcomes(p.batchId);
    expect(after.every((x) => x.includes("imported"))).toBe(true);
    expect(r.summary).toMatchObject({ imported: 7, unchanged_written: 0, conflict: 0 }); // 前几块的 imported 没有被改写成 unchanged
    expect((await one<{ c: string }>("SELECT COUNT(*) c FROM stores")).c).toBe("7"); // R1 + N00..N05，没有重复
    expect(env.audit.of("store_reactivated")).toHaveLength(1); // 崩溃前已发；续跑不重复
    expect(resume.audit.of("store_reactivated")).toHaveLength(0);
  });

  it("两个确认交叠：A 在块边界时 B 进来 → B 得到 batch_in_progress，A 照常完成", async () => {
    let inner: unknown;
    const base = await bootstrapped(t);
    await seedStores(base, [{ storeCode: "SEEDX" }]);
    const env = mdEnv(t, {
      chunkSize: 2,
      hooks: {
        afterChunk: async (k) => {
          if (k !== 1) return;
          const other = mdEnv(t);
          inner = await other.md.imports.confirm(batchRef.id, {}, other.importer).catch((e) => e);
        },
      },
    });
    const batchRef = { id: "" };
    const p = await precheck(env, rows(5));
    batchRef.id = p.batchId;
    const r = await env.md.imports.confirm(p.batchId, {}, env.importer);
    expect(r.status).toBe("completed");
    expect(inner).toMatchObject({ code: "batch_in_progress" });
    expect((await one<{ c: string }>("SELECT COUNT(*) c FROM stores")).c).toBe("6"); // 含种子门店
  });

  it("旧进程被接手后，下一个块 lease_lost，零写入；新进程完成批次", async () => {
    const base = await bootstrapped(t);
    await seedStores(base, [{ storeCode: "SEEDX" }]);
    const env = mdEnv(t, {
      chunkSize: 2,
      hooks: {
        afterChunk: async (k) => {
          if (k === 1) await t.db.update(importBatches).set({ writingToken: "taken-over-by-someone-else" }).where(eq(importBatches.importBatchId, BigInt(ref.id)));
        },
      },
    });
    const ref = { id: "" };
    const p = await precheck(env, rows(6));
    ref.id = p.batchId;
    await expect(env.md.imports.confirm(p.batchId, {}, env.importer)).rejects.toMatchObject({ code: "lease_lost" });
    expect((await outcomes(p.batchId)).filter((x) => x.includes("imported"))).toHaveLength(2); // 只有被接手前的第 1 块
    expect((await one<{ c: string }>("SELECT COUNT(*) c FROM stores")).c).toBe("3"); // 含种子门店
  });

  it("总耗时超过上限：在块边界以 time_limit_exceeded 停下、清空心跳，立即再 confirm 可续跑完成", async () => {
    const holder: { env?: MdEnv } = {};
    const base = await bootstrapped(t);
    await seedStores(base, [{ storeCode: "SEEDX" }]);
    const env = mdEnv(t, { chunkSize: 2, maxMs: 10 * 60_000, hooks: { afterChunk: () => holder.env!.clock.advance(11 * 60_000) } });
    holder.env = env;
    const p = await precheck(env, rows(6));
    await expect(env.md.imports.confirm(p.batchId, {}, env.importer)).rejects.toMatchObject({ code: "time_limit_exceeded", category: "limit" });
    const [b] = await t.db.select().from(importBatches).where(eq(importBatches.importBatchId, BigInt(p.batchId)));
    expect(b).toMatchObject({ status: "writing", heartbeatAt: null });
    expect((await outcomes(p.batchId)).filter((x) => x.includes("imported"))).toHaveLength(2);

    const again = mdEnv(t, { chunkSize: 2 });
    again.clock.set(env.clock.now());
    const r = await again.md.imports.confirm(p.batchId, {}, again.importer);
    expect(r.summary).toMatchObject({ imported: 6 });
  });

  it("品牌范围：确认时操作者范围缩小到 {hisense}，原本合法的日立行变 conflict/precheck_stale，不写", async () => {
    const env = await bootstrapped(t);
    await seedStores(env, [{ storeCode: "S1" }]);
    const p = await precheck(env, [{ storeCode: "S1", name: "新名" }]);
    await env.md.imports.confirm(p.batchId, {}, importActor(["hisense"]));
    expect(await outcomes(p.batchId)).toEqual(["1:conflict/precheck_stale"]);
    expect((await storeBy("S1"))!.storeName).toBe("门店-S1");
  });
});
