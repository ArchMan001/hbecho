// 规模：10,000 行（F-D12 上限）。预检 + structure 模式确认的耗时与内存打印出来，作为 design §12 / acceptance M3 的记录来源。
// 行数据由代码生成，不提交大文件。
import { describe, expect, it } from "vitest";
import { useTestDb } from "../../../tests/harness/db";
import { bootstrapped, csv, type RowSpec } from "../../../tests/harness/master-data";

const t = useTestDb();
const ROWS = 10_000;
const DEALERS = 5_000; // 真实导出约 5,300 个不同的商家渠道编码

describe("10,000 行规模", () => {
  it(
    "structure 模式预检 + 确认在 10 分钟内完成；汇总与行结果一致；重复确认不再写；再传同一文件全 unchanged",
    async () => {
      const env = await bootstrapped(t);
      const rows: RowSpec[] = Array.from({ length: ROWS }, (_, i) => ({
        storeCode: `P${String(i).padStart(5, "0")}`,
        dealerCode: String(8_000_000 + (i % DEALERS)),
        dealerName: `压测商家${i % DEALERS}`,
        mainCode: ["13", "15", "23", "25", "33"][i % 5]!,
        mainName: "压测",
      }));
      const bytes = csv(rows);

      const t0 = performance.now();
      const p = await env.md.imports.precheck({ fileName: "perf.csv", bytes, mode: "structure" }, env.admin);
      const t1 = performance.now();
      const r = await env.md.imports.confirm(p.batchId, {}, env.admin);
      const t2 = performance.now();

      expect(p.summary).toMatchObject({ new: ROWS, error: 0, needs_superadmin: 0 });
      expect(r.summary).toMatchObject({ imported: ROWS, conflict: 0 });
      const [c] = (await t.pool.query("SELECT (SELECT COUNT(*) FROM stores) s, (SELECT COUNT(*) FROM dealers) d, (SELECT COUNT(*) FROM import_row_results WHERE outcome IS NULL) nul"))[0] as Array<{ s: string; d: string; nul: string }>;
      expect([c!.s, c!.d, c!.nul]).toEqual([String(ROWS), String(DEALERS), "0"]);
      expect(t2 - t0).toBeLessThan(10 * 60_000);
      process.stderr.write(`[perf] ${ROWS} 行 / ${DEALERS} 经销商：预检 ${Math.round(t1 - t0)} ms，确认 ${Math.round(t2 - t1)} ms，RSS ${Math.round(process.memoryUsage().rss / 1048576)} MB\n`);

      expect((await env.md.imports.confirm(p.batchId, {}, env.admin)).alreadyCompleted).toBe(true);
      const again = await env.md.imports.precheck({ fileName: "perf.csv", bytes, mode: "import" }, env.importer);
      expect(again.summary).toMatchObject({ unchanged: ROWS });
    },
    600_000,
  );
});
