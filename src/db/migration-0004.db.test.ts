// a-full-sync 任务 1：purpose 迁移必须能在「已有 tracer / smoke 批次」的库上成功（R4 三步迁移）。
// 用同一个 MySQL 实例上的独立库 hbecho_migrate_test：先只应用 0000–0003，写入旧形态的批次行，再应用全部迁移。
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import mysql from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, createPool, runMigrations } from "./client";

const SCRATCH = "hbecho_migrate_test";
const adminUrl = () => (process.env.HBECHO_TEST_DATABASE_URL ?? "").replace(/\/[^/]*$/, "/");
const scratchUrl = () => `${adminUrl()}${SCRATCH}`;

describe("0004 迁移在有数据的库上", () => {
  beforeAll(async () => {
    const host = new URL(process.env.HBECHO_TEST_DATABASE_URL!).hostname;
    if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) throw new Error(`拒绝建库：主机必须是回环地址（${host}）`);
    const admin = await mysql.createConnection({ uri: adminUrl() });
    await admin.query(`DROP DATABASE IF EXISTS \`${SCRATCH}\``);
    await admin.query(`CREATE DATABASE \`${SCRATCH}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
    await admin.end();
  });
  afterAll(async () => {
    const admin = await mysql.createConnection({ uri: adminUrl() });
    await admin.query(`DROP DATABASE IF EXISTS \`${SCRATCH}\``);
    await admin.end();
  });

  it("旧批次行被回填为 intake，列为 NOT NULL 且无 DEFAULT；再跑一次是空操作", async () => {
    // 只含 0000–0003 的迁移目录
    const dir = mkdtempSync(join(tmpdir(), "hbecho-mig-"));
    cpSync("drizzle", dir, { recursive: true });
    const journalPath = join(dir, "meta", "_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: Array<{ tag: string }> };
    const full = journal.entries.length;
    journal.entries = journal.entries.filter((e) => !e.tag.startsWith("0004_"));
    expect(journal.entries.length).toBe(full - 1);
    writeFileSync(journalPath, JSON.stringify(journal));

    const pool = createPool(scratchUrl());
    try {
      const db = createDb(pool);
      await runMigrations(db, dir);
      const insert = (k: string, trigger: string) =>
        pool.query(
          "INSERT INTO sync_batches (batch_key, trigger_type, logical_at, status, settings_version, settings_snapshot, created_at, updated_at) VALUES (UNHEX(SHA2(?,256)), ?, '2026-11-01 00:00:00.000000', 'succeeded', 1, '{}', '2026-11-01 00:00:00.000000', '2026-11-01 00:00:00.000000')",
          [k, trigger],
        );
      await insert("tracer-root", "manual");
      await insert("smoke", "manual");
      const [pre] = await pool.query("SHOW COLUMNS FROM sync_batches LIKE 'purpose'");
      expect(pre).toEqual([]); // 迁移前确实没有这一列

      await runMigrations(db); // 全部迁移
      const [rows] = await pool.query("SELECT purpose, COUNT(*) c FROM sync_batches GROUP BY purpose");
      expect(rows).toEqual([{ purpose: "intake", c: "2" }]);
      const [col] = await pool.query("SELECT column_default d, is_nullable n FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'sync_batches' AND column_name = 'purpose'");
      expect(col).toEqual([{ d: null, n: "NO" }]);

      await runMigrations(db); // 第二次：空操作
      const [again] = await pool.query("SELECT COUNT(*) c FROM sync_batches WHERE purpose = 'intake'");
      expect(again).toEqual([{ c: "2" }]);
    } finally {
      await pool.end();
    }
  });
});
