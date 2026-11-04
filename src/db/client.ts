// 数据库连接：UTC、BIGINT 以字符串往返（再由 drizzle 转 bigint），不丢 2^53 以上的精度。
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import mysql, { type Pool } from "mysql2/promise";
import * as schema from "./schema";

export type Db = ReturnType<typeof createDb>;
export type DbTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export function createPool(url: string): Pool {
  const pool = mysql.createPool({
    uri: url,
    connectionLimit: 8,
    timezone: "Z",
    supportBigNumbers: true,
    bigNumberStrings: true,
    charset: "utf8mb4",
  });
  // v2 §5.1：连接建立后统一 time_zone='+00:00'
  pool.on("connection", (conn) => {
    conn.query("SET time_zone = '+00:00'");
  });
  return pool;
}

export interface QueryLogger {
  logQuery(query: string, params: unknown[]): void;
}

export function createDb(pool: Pool, opts: { logger?: QueryLogger } = {}) {
  return drizzle(pool, { schema, mode: "default", ...(opts.logger ? { logger: opts.logger } : {}) });
}

export async function runMigrations(db: Db, migrationsFolder = "drizzle"): Promise<void> {
  await migrate(db, { migrationsFolder });
}
