// db 项目的测试挂具：连接、每个用例前清业务数据、期望数据库拒绝的断言。
// platforms / data_providers 是迁移种入的参考数据，不清。
import { afterAll, beforeAll, beforeEach } from "vitest";
import type { Pool } from "mysql2/promise";
import { createDb, createPool, type Db } from "../../src/db/client";

const KEEP = new Set(["platforms", "data_providers", "__drizzle_migrations"]);

export interface TestDb {
  db: Db;
  pool: Pool;
}

/** 在 describe 里调用一次；返回的对象在 beforeAll 之后才可用。 */
export function useTestDb(): TestDb {
  const holder = {} as TestDb;
  beforeAll(() => {
    const url = process.env.HBECHO_TEST_DATABASE_URL;
    if (!url) throw new Error("缺少 HBECHO_TEST_DATABASE_URL（见 scripts/with-test-mysql.sh）");
    holder.pool = createPool(url);
    holder.db = createDb(holder.pool);
  });
  beforeEach(async () => {
    await resetData(holder.pool);
  });
  afterAll(async () => {
    await holder.pool.end();
  });
  return holder;
}

export async function resetData(pool: Pool): Promise<void> {
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.query("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'");
    await conn.query("SET FOREIGN_KEY_CHECKS = 0");
    for (const r of rows as Array<{ t: string }>) {
      if (!KEEP.has(r.t)) await conn.query(`DELETE FROM \`${r.t}\``);
    }
    await conn.query("SET FOREIGN_KEY_CHECKS = 1");
  } finally {
    conn.release();
  }
}

interface MysqlLikeError {
  code?: string;
  errno?: number;
  sqlMessage?: string;
  message?: string;
  cause?: unknown;
}

function rootError(e: unknown): MysqlLikeError {
  let cur = e as MysqlLikeError;
  while (cur?.cause && (cur.cause as MysqlLikeError).code !== undefined) cur = cur.cause as MysqlLikeError;
  return cur?.cause && !cur.code ? (cur.cause as MysqlLikeError) : cur;
}

/** 期望数据库拒绝这次写入，并且原因里点名了指定的约束/触发器。返回底层 MySQL 错误码。 */
export async function expectRejected(op: PromiseLike<unknown>, constraint: string): Promise<string> {
  try {
    await op;
  } catch (e) {
    const err = rootError(e);
    const text = `${err.sqlMessage ?? ""} ${err.message ?? ""}`;
    if (!text.includes(constraint)) {
      throw new Error(`数据库拒绝了写入，但不是因为 ${constraint}：${err.code} ${text}`);
    }
    return err.code ?? "unknown";
  }
  throw new Error(`期望数据库拒绝（${constraint}），但写入成功了`);
}
