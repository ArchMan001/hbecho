// `pnpm db:migrate`：只走 migrate，不用 push（ADR-0005）。
import { createDb, createPool, runMigrations } from "./client";

const url = process.env.HBECHO_DATABASE_URL;
if (!url) {
  process.stderr.write("缺少 HBECHO_DATABASE_URL\n");
  process.exit(1);
}
const pool = createPool(url);
await runMigrations(createDb(pool));
await pool.end();
process.stdout.write("migrations applied\n");
