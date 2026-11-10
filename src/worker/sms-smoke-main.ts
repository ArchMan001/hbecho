// `pnpm sms-smoke ...` 的进程入口。真实依赖（阿里云 SDK）只在 planSmoke 全部门槛通过后才构造。
// 环境变量从仓库根目录的 `.env` 载入（Node 自带 loadEnvFile，与 smoke-main 一致）；值不打印，错误只报键名。
import { loadEnvFile } from "node:process";
import { createSender } from "../modules/access-control/runtime";
import { runSmsSmoke } from "./sms-smoke-cli";

try {
  loadEnvFile(".env");
} catch (e) {
  const code = (e as { code?: unknown }).code;
  if (code !== "ENOENT") {
    process.stderr.write(`无法读取 .env（${typeof code === "string" ? code : "unknown"}）\n`);
    process.exit(1);
  }
}

const code = await runSmsSmoke(process.argv.slice(2), process.env, {
  makeSender: createSender,
  now: () => new Date(),
  stdout: (s) => void process.stdout.write(s),
  stderr: (s) => void process.stderr.write(s),
});
process.exit(code);
