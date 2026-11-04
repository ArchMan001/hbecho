import { defineConfig } from "drizzle-kit";

// 迁移单一来源：drizzle-kit generate → drizzle/ 下的 SQL；只走 migrate，禁用 push（ADR-0005）。
export default defineConfig({
  dialect: "mysql",
  schema: "./src/db/schema/index.ts",
  out: "./drizzle",
});
