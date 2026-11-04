// `pnpm smoke ...` 的进程入口。
// 真实依赖（HTTP transport、私有 ODS、secret provider）由 smoke-wiring 装配，**只在 preflight 全部门槛通过后**
// 才会被执行；门槛不满足时连 SDK 构造函数都不会调用，退出码 2。
//
// 环境变量从仓库根目录的 `.env` 载入（Node 自带 loadEnvFile，不引 dotenv）；文件不存在时只依赖进程环境。
// secret 的值不打印、不落日志；错误只报变量名。
import { readFile } from "node:fs/promises";
import { loadEnvFile } from "node:process";
import { runSmokeCli } from "./smoke-cli";
import { makeSmokeExecutor } from "./smoke-wiring";

try {
  loadEnvFile(".env");
} catch (e) {
  const code = (e as { code?: unknown }).code;
  if (code !== "ENOENT") {
    process.stderr.write(`无法读取 .env（${typeof code === "string" ? code : "unknown"}）\n`);
    process.exit(1);
  }
}

const code = await runSmokeCli(process.argv.slice(2), {
  readJson: async (p) => JSON.parse(await readFile(p, "utf8")) as unknown,
  env: process.env,
  now: () => new Date(),
  stdout: (s) => void process.stdout.write(s),
  stderr: (s) => void process.stderr.write(s),
  execute: makeSmokeExecutor(process.env),
  onInternalError: (e) => process.stderr.write(`smoke internal error: ${e instanceof Error ? e.name : "unknown"}\n`),
});
process.exit(code);