import { defineConfig } from "vitest/config";

// 两个项目：
//   unit —— 纯离线，不需要数据库；setup.ts 拒绝任何非回环网络连接
//   db   —— 需要 MySQL 8.4（HBECHO_TEST_DATABASE_URL，由 scripts/with-test-mysql.sh 或 CI 服务容器提供）；
//           文件串行执行，避免多个进程同时清表（dev-ci-cadence 第 2 条）
export default defineConfig({
  test: {
    setupFiles: ["tests/harness/setup.ts"],
    environment: "node",
    testTimeout: 15_000,
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
          exclude: ["**/*.db.test.ts", "**/node_modules/**"],
        },
      },
      {
        extends: true,
        test: {
          name: "db",
          include: ["src/**/*.db.test.ts", "tests/**/*.db.test.ts"],
          fileParallelism: false,
          globalSetup: ["tests/harness/db-global-setup.ts"],
          testTimeout: 30_000,
        },
      },
    ],
  },
});
