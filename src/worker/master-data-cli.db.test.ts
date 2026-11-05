// CLI 一条龙（design §10）：bootstrap → precheck → confirm → batches/batch/rows → report；退出码与旁路检查。
import { describe, expect, it } from "vitest";
import { useTestDb } from "../../tests/harness/db";
import { adminActor, csv, importActor, mdEnv } from "../../tests/harness/master-data";
import type { ActorContext } from "../modules/master-data-import";
import { runCli } from "./master-data-cli";

const t = useTestDb();

function cli(actor: ActorContext, files: Record<string, Uint8Array | string> = {}) {
  const env = mdEnv(t);
  const out: string[] = [];
  const err: string[] = [];
  const written: Record<string, string> = {};
  const run = async (...argv: string[]) => {
    out.length = 0;
    const code = await runCli(argv, {
      md: env.md,
      actor,
      readFile: (p) => {
        const f = files[p];
        if (f === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return typeof f === "string" ? new TextEncoder().encode(f) : f;
      },
      writeFile: (p, c) => void (written[p] = c),
      stdout: (s) => void out.push(s),
      stderr: (s) => void err.push(s),
    });
    return { code, json: out.length ? JSON.parse(out.join("")) : undefined };
  };
  return { run, err, written, env };
}

describe("CLI 一条龙", () => {
  it("bootstrap → precheck(structure) → confirm → batch/rows/batches → report；输出里的 BIGINT 是字符串", async () => {
    const files = { "a.csv": csv([{ storeCode: "A1" }, { storeCode: "A2", dealerCode: "--" }]) };
    const { run, written } = cli(adminActor(), files);

    const b = await run("bootstrap");
    expect(b.code).toBe(0);
    expect(b.json).toMatchObject({ ok: true, brands: { created: 3 }, branches: { created: 42 }, sectors: { created: 84 } });
    expect((await run("bootstrap")).json.sectors).toMatchObject({ created: 0, unchanged: 84 });

    const p = await run("precheck", "--file", "a.csv", "--mode", "structure");
    expect(p).toMatchObject({ code: 0, json: { ok: true, status: "awaiting_confirm", totalRows: 2, summary: { new: 1, error: 1 } } });
    expect(typeof p.json.batchId).toBe("string");

    const c = await run("confirm", "--batch", p.json.batchId);
    expect(c).toMatchObject({ code: 0, json: { ok: true, status: "completed", alreadyCompleted: false, summary: { imported: 1 } } });
    expect((await run("confirm", "--batch", p.json.batchId)).json.alreadyCompleted).toBe(true);

    const list = await run("batches");
    expect(list.json.batches[0]).toMatchObject({ batchId: p.json.batchId, status: "completed" });
    expect((await run("batch", p.json.batchId)).json).toMatchObject({ ok: true, returnFile: { available: true, rows: 1 } });
    const rows = await run("rows", p.json.batchId, "--limit", "1");
    expect(rows.json.rows).toHaveLength(1);
    const rep = await run("report", p.json.batchId, "--out", "back.csv");
    expect(rep).toMatchObject({ code: 0, json: { ok: true, rows: 1, out: "back.csv" } });
    expect(written["back.csv"]!.startsWith("\uFEFF")).toBe(true);
    expect(written["back.csv"]).toContain("dealer_code_missing");
  });

  it("store change-code", async () => {
    const files = { "a.csv": csv([{ storeCode: "A1" }]) };
    const { run } = cli(adminActor(), files);
    await run("bootstrap");
    const p = await run("precheck", "--file", "a.csv", "--mode", "structure");
    await run("confirm", "--batch", p.json.batchId);
    const rows = await run("rows", p.json.batchId);
    const storeId = rows.json.rows[0].storeId as string; // 新建门店的 store_id 在确认后写入行结果
    expect(typeof storeId).toBe("string");
    expect(await run("store", "change-code", "--store-id", storeId, "--new-code", "A1-NEW")).toMatchObject({ code: 0, json: { ok: true, result: "changed", storeCode: "A1-NEW" } });
    expect((await run("store", "change-code", "--store-id", "999999", "--new-code", "X")).code).toBe(4);
    expect((await run("store", "change-code", "--store-id", storeId)).code).toBe(2);
  });

  it("退出码：输入 2 / 授权 2 / 不存在 4；没有 --skip-auth、--force 之类的旁路", async () => {
    const { run, err } = cli(importActor(), { "a.csv": csv([{ storeCode: "A1" }]) });
    expect((await run()).code).toBe(2);
    expect((await run("nope")).code).toBe(2);
    expect((await run("precheck", "--file", "a.csv")).code).toBe(2); // 缺 --mode
    expect((await run("precheck", "--file", "missing.csv", "--mode", "import")).json.error.code).toBe("file_not_found");
    expect((await run("precheck", "--file", "a.csv", "--mode", "structure")).code).toBe(2); // import 身份用 structure 模式
    expect((await run("bootstrap")).code).toBe(2);
    for (const flag of ["--skip-auth", "--force"]) {
      const r = await run("precheck", "--file", "a.csv", "--mode", "import", flag);
      expect(r.code).toBe(2);
      expect(r.json.ok).toBe(false);
    }
    expect((await run("batch", "999999")).code).toBe(4);
    expect((await run("confirm", "--batch", "999999")).code).toBe(4);
    expect((await run("batches", "--limit", "x")).code).toBe(2);
    expect(err.join("")).not.toContain("internal_error");
  });

  it("疑似导出不完整时 stderr 有警告", async () => {
    const admin = adminActor();
    const files = { "seed.csv": csv([{ storeCode: "A" }, { storeCode: "B" }, { storeCode: "C" }]), "part.csv": csv([{ storeCode: "A" }]) };
    const { run, err } = cli(admin, files);
    await run("bootstrap");
    const p = await run("precheck", "--file", "seed.csv", "--mode", "structure");
    await run("confirm", "--batch", p.json.batchId);
    await run("precheck", "--file", "part.csv", "--mode", "structure");
    expect(err.join("")).toContain("疑似导出不完整");
  });
});
