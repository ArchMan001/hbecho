// `pnpm smoke ...` 的进程入口。真实执行器（HTTP transport、私有 ODS、secret provider）还没有接线，
// 所以获批后会以退出码 5 停止——这是刻意的：没有批准、没有预算、没有接线好的审计，就不存在「顺手发一次」的路径。
import { readFile } from "node:fs/promises";
import { runSmokeCli } from "./smoke-cli";

const code = await runSmokeCli(process.argv.slice(2), {
  readJson: async (p) => JSON.parse(await readFile(p, "utf8")) as unknown,
  env: process.env,
  now: () => new Date(),
  stdout: (s) => void process.stdout.write(s),
  stderr: (s) => void process.stderr.write(s),
  onInternalError: (e) => process.stderr.write(`smoke internal error: ${e instanceof Error ? e.name : "unknown"}\n`),
});
process.exit(code);
