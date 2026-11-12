// 任务 7：查询与回流（MD-8/10，acceptance F、G）。查询不写业务表；BIGINT 一律十进制字符串；范围外批次不可见。
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { useTestDb } from "../../../tests/harness/db";
import { adminActor, bootstrapped, csv, importActor, seedStores, type MdEnv } from "../../../tests/harness/master-data";
import { stores } from "../../db/schema";

const t = useTestDb();

async function mixedBatch(env: MdEnv, actor = env.importer) {
  await seedStores(env, [{ storeCode: "S1" }, { storeCode: "S2" }]);
  const p = await env.md.imports.precheck(
    {
      fileName: "mixed.csv",
      mode: "import",
      bytes: csv([
        { storeCode: "S1" }, // unchanged
        { storeCode: "S9" }, // new
        { storeCode: "E1", dealerCode: "--" }, // error
        { storeCode: "Q1", dealerCode: "9000009", dealerName: "新商家" }, // needs_superadmin
        { storeCode: "F1", name: "=1+1", dealerCode: "#N/A" }, // error，且单元格以 = 开头
      ]),
    },
    actor,
  );
  return p;
}

describe("批次与行查询", () => {
  it("列表 / 详情 / 行详情：字段齐全，BIGINT 是字符串，汇总与行结果聚合一致", async () => {
    const env = await bootstrapped(t);
    const p = await mixedBatch(env);
    const list = await env.md.query.list({}, env.importer);
    const item = list.find((b) => b.batchId === p.batchId)!;
    expect(item).toMatchObject({ fileName: "mixed.csv", status: "awaiting_confirm", uploadedByActor: "service:test-import", totalRows: 5, confirmedAt: null });
    expect(typeof item.batchId).toBe("string");

    const detail = await env.md.query.get(p.batchId, env.importer);
    expect(detail.summary).toMatchObject({ unchanged: 1, new: 1, error: 2, needs_superadmin: 1, pending_closure_stores: 1 });
    expect(detail.pendingClosures).toHaveLength(1);
    expect(typeof detail.pendingClosures[0]!.storeId).toBe("string");
    expect(detail.returnFile).toEqual({ available: true, rows: 3 });

    const rows = await env.md.query.rows(p.batchId, {}, env.importer);
    expect(rows).toHaveLength(5);
    expect(rows[2]).toMatchObject({ rowNo: 3, precheckClass: "error", outcome: null, reasonCode: "dealer_code_missing" });
    expect(Object.keys(rows[0]!.rawRow as object)).toHaveLength(11);
    expect(typeof rows[0]!.storeId).toBe("string"); // 命中既有门店
    expect(rows[1]!.storeId).toBeNull();
    expect((await env.md.query.rows(p.batchId, { offset: 3, limit: 1 }, env.importer)).map((r) => r.rowNo)).toEqual([4]);
    // 聚合一致
    const agg = rows.reduce<Record<string, number>>((m, r) => ({ ...m, [r.precheckClass!]: (m[r.precheckClass!] ?? 0) + 1 }), {});
    expect(agg).toMatchObject({ unchanged: detail.summary && (detail.summary as { unchanged: number }).unchanged, error: 2, needs_superadmin: 1, new: 1 });
  });

  it("不存在的批次 → 稳定「未找到」，不返回空列表冒充成功；非法 ID → 输入错误", async () => {
    const env = await bootstrapped(t);
    await expect(env.md.query.get("999999", env.importer)).rejects.toMatchObject({ category: "not_found" });
    await expect(env.md.query.rows("999999", {}, env.importer)).rejects.toMatchObject({ category: "not_found" });
    await expect(env.md.query.returnFile("999999", env.importer)).rejects.toMatchObject({ category: "not_found" });
    await expect(env.md.query.get("abc", env.importer)).rejects.toMatchObject({ category: "input" });
  });

  it("范围外操作者看不到批次，也拿不到行结果（与不存在表现一致）", async () => {
    const env = await bootstrapped(t);
    const p = await mixedBatch(env); // brand_scope = 三个品牌
    const narrow = importActor(["hitachi"]);
    expect((await env.md.query.list({}, narrow)).map((b) => b.batchId)).not.toContain(p.batchId);
    await expect(env.md.query.get(p.batchId, narrow)).rejects.toMatchObject({ category: "not_found" });
    await expect(env.md.query.rows(p.batchId, {}, narrow)).rejects.toMatchObject({ category: "not_found" });
    expect((await env.md.query.list({}, adminActor())).map((b) => b.batchId)).toContain(p.batchId);
    await expect(env.md.query.list({}, { ...narrow, capabilities: new Set() })).rejects.toMatchObject({ category: "authorization" });
  });

  it("查询不写业务表", async () => {
    const env = await bootstrapped(t);
    const p = await mixedBatch(env);
    const snap = async () => JSON.stringify((await t.pool.query("SELECT (SELECT COUNT(*) FROM stores) a, (SELECT COUNT(*) FROM import_row_results) b, (SELECT COUNT(*) FROM data_quality_issues) c, (SELECT MAX(updated_at) FROM import_batches) d"))[0]);
    const before = await snap();
    await env.md.query.list({}, env.importer);
    await env.md.query.get(p.batchId, env.importer);
    await env.md.query.rows(p.batchId, {}, env.importer);
    await env.md.query.returnFile(p.batchId, env.importer);
    expect(await snap()).toBe(before);
  });
});

describe("回流文件", () => {
  it("原 11 列 + 预检分类 / 结果 / 原因；只含 error / needs_superadmin / conflict；公式前缀；带 BOM", async () => {
    const env = await bootstrapped(t);
    const p = await mixedBatch(env);
    const f = await env.md.query.returnFile(p.batchId, env.importer);
    expect(f.rows).toBe(3);
    expect(f.content.startsWith("\uFEFF")).toBe(true);
    const lines = f.content.slice(1).trim().split("\r\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]!.endsWith("预检分类,结果,原因")).toBe(true);
    expect(f.content).not.toContain("门店-S9"); // new 行不回流
    expect(f.content).toContain("'=1+1"); // 公式注入前缀
    expect(lines[1]).toContain("dealer_code_missing");
  });

  it("确认后 conflict 行也回流；回流的行改好后作为新文件重传，产生新批次，旧批次结果不变", async () => {
    const env = await bootstrapped(t);
    const p = await mixedBatch(env);
    await env.md.imports.confirm(p.batchId, {}, env.importer);
    const oldRows = JSON.stringify(await env.md.query.rows(p.batchId, {}, env.importer));

    // 业务把回流文件里缺的商家渠道编码补上，去掉末尾三列，重新上传
    const f = await env.md.query.returnFile(p.batchId, env.importer);
    const fixed = f.content
      .slice(1)
      .trim()
      .split("\r\n")
      .slice(1)
      .filter((l) => l.includes("dealer_code_missing"))
      .map((l) => l.split(",").slice(0, 11))
      .map((cells) => cells.map((c, i) => (i === 5 ? "9000001" : i === 0 ? c.replace(/^'/, "") : c)));
    expect(fixed).toHaveLength(2);
    const retry = await env.md.imports.precheck({ fileName: "retry.csv", mode: "import", bytes: csv(fixed) }, env.importer);
    expect(retry.batchId).not.toBe(p.batchId);
    expect(retry.summary).toMatchObject({ new: 2, error: 0 }); // 分类可以改变
    expect(JSON.stringify(await env.md.query.rows(p.batchId, {}, env.importer))).toBe(oldRows); // 旧批次不变
  });

  it("停用 / 关闭门店后，历史批次与行结果仍可查", async () => {
    const env = await bootstrapped(t);
    const p = await mixedBatch(env);
    await env.md.imports.confirm(p.batchId, {}, env.importer);
    await t.db.update(stores).set({ status: "closed" }).where(eq(stores.storeCode, "S9"));
    expect((await env.md.query.rows(p.batchId, {}, env.importer)).length).toBe(5);
    expect((await env.md.query.get(p.batchId, env.importer)).status).toBe("completed");
  });
  it("rows 可按预检分类过滤（页面的分类筛选），过滤后分页仍按行号顺序", async () => {
    const env = await bootstrapped(t);
    const p = await mixedBatch(env);
    const errors = await env.md.query.rows(p.batchId, { precheckClass: "error" }, env.importer);
    expect(errors.map((r) => r.rowNo)).toEqual([3, 5]);
    expect((await env.md.query.rows(p.batchId, { precheckClass: "error", offset: 1, limit: 1 }, env.importer)).map((r) => r.rowNo)).toEqual([5]);
    expect(await env.md.query.rows(p.batchId, { precheckClass: "update" }, env.importer)).toEqual([]);
  });
});
