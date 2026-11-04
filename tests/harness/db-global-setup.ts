// db 项目的全局准备：在空库上执行全部迁移（R16：迁移本身也是被测对象）。
// 安全闸：库名必须以 _test 结尾，且主机必须是回环地址——这个流程会 DROP DATABASE。
import mysql from "mysql2/promise";
import { createDb, createPool, runMigrations } from "../../src/db/client";

export default async function setup(): Promise<void> {
  const raw = process.env.HBECHO_TEST_DATABASE_URL;
  if (!raw) {
    throw new Error(
      "缺少 HBECHO_TEST_DATABASE_URL。数据库测试请通过 ./scripts/with-test-mysql.sh 或 CI 的 MySQL 服务容器运行；不要指向任何共享库或测试 ECS。",
    );
  }
  const url = new URL(raw);
  const dbName = url.pathname.replace(/^\//, "");
  if (!/_test$/.test(dbName)) throw new Error(`拒绝清库：数据库名必须以 _test 结尾（当前 ${dbName}）`);
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)) {
    throw new Error(`拒绝清库：数据库主机必须是回环地址（当前 ${url.hostname}）`);
  }

  const admin = await mysql.createConnection({ uri: raw.replace(/\/[^/]*$/, "/") });
  await admin.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
  await admin.query(`CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
  await admin.end();

  const pool = createPool(raw);
  try {
    await runMigrations(createDb(pool));
  } finally {
    await pool.end();
  }
}
