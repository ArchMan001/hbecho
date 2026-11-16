// d-rule-engine 任务 11：真实入口 judgement-main.ts 的启动校验与装配（子进程，不连 OSS 与能力服务）——JP-19 S1 / JP-20 T2。
// 缺数据库、缺身份、身份不是用户、缺任一数值配置都在做任何事之前失败并点名；完整配置下用真实 B 装配跑一条只读命令。
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { accessEnv, insertAccessUser, seedAccessOrg } from "../../tests/harness/access";
import { useTestDb } from "../../tests/harness/db";
import { JUDGEMENT_ENV_KEYS } from "../modules/judgement/env";
const t = useTestDb();
const URL = process.env.HBECHO_TEST_DATABASE_URL ?? "";
const JP: Record<string, string> = Object.fromEntries(JUDGEMENT_ENV_KEYS.map((k) => [k, "10"]));
const SIGNALS: Record<string, string> = {
  HBECHO_SIGNALS_SCAN_INTERVAL_MS: "1000", HBECHO_SIGNALS_SCAN_BATCH: "100", HBECHO_SIGNALS_LOOKBACK_MS: "60000", HBECHO_SIGNALS_RECONCILE_INTERVAL_MS: "1000",
  HBECHO_SIGNALS_SCORE_CONCURRENCY: "4", HBECHO_SIGNALS_TASK_MAX_ATTEMPTS: "3", HBECHO_SIGNALS_RETRY_BACKOFF_MS: "1000", HBECHO_SIGNALS_LEASE_MS: "60000",
  HBECHO_SIGNALS_SIGNED_URL_TTL_S: "600", HBECHO_SIGNALS_MATCH_TIMEOUT_MS: "5000", HBECHO_SIGNALS_DEFER_INTERVAL_MS: "30000", HBECHO_SIGNALS_DEFER_MAX: "20", HBECHO_MEDIA_MAX_BYTES: "20971520",
};
const full = (actor: string): Record<string, string> => ({ HBECHO_DATABASE_URL: URL, HBECHO_JP_ACTOR: actor, ...JP, HBECHO_JP_MAX_ITEMS: "50", HBECHO_JP_MAX_KEYWORD_LENGTH: "64", ...SIGNALS });
function main(args: string[], env: Record<string, string>) {
  // 不继承父进程环境：避免把本机的 OSS 凭证带进来，也保证“缺项”真的缺
  const r = spawnSync(process.execPath, ["--import", "tsx", "src/worker/judgement-main.ts", ...args], { env: { PATH: process.env.PATH ?? "", ...env } as unknown as NodeJS.ProcessEnv, encoding: "utf8", timeout: 60_000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const without = <T extends Record<string, string>>(o: T, k: string): Record<string, string> => Object.fromEntries(Object.entries(o).filter(([x]) => x !== k));
describe("judgement-main 启动", () => {
  it("缺数据库、缺身份、身份不是 user:<id>、缺任一 D 或 C 的数值配置：非零退出并点名，不输出结果", () => {
    const base = full("user:1");
    expect(main(["plan", "list"], {})).toMatchObject({ code: 1, err: expect.stringContaining("HBECHO_DATABASE_URL") });
    expect(main(["plan", "list"], without(base, "HBECHO_JP_ACTOR"))).toMatchObject({ code: 1, err: expect.stringContaining("HBECHO_JP_ACTOR") });
    for (const bad of ["service:judgement", "user:0", "user:abc", "admin", "user:1,2"]) expect(main(["plan", "list"], full(bad)), bad).toMatchObject({ code: 1, err: expect.stringContaining("HBECHO_JP_ACTOR") });
    for (const k of JUDGEMENT_ENV_KEYS) expect(main(["plan", "list"], without(base, k)), k).toMatchObject({ code: 1, err: expect.stringContaining(k) });
    expect(main(["plan", "list"], without(base, "HBECHO_SIGNALS_SCAN_BATCH"))).toMatchObject({ code: 1, err: expect.stringContaining("HBECHO_SIGNALS_SCAN_BATCH") });
    const r = main(["plan", "list"], without(base, "HBECHO_JP_BLOCK_SIZE"));
    expect(r.out).toBe("");
  });
  it("serve 另需 A 需求的运行模式，缺则启动失败并点名；其余命令不需要", async () => {
    const acc = accessEnv(t);
    const org = await seedAccessOrg(acc);
    const admin = await insertAccessUser(acc, { role: "platform_admin", phone: "13900000001" });
    void org;
    const env = full(`user:${admin}`);
    const serve = main(["serve"], env);
    expect(serve).toMatchObject({ code: 1, err: expect.stringContaining("HBECHO_SYNC_DETAIL_MODE") });
    expect(main(["plan", "list"], env).code).toBe(0);
  });
  it("完整配置：用真实 B 装配取到该用户的 AuthContext，只读命令成功；用户不存在 / 已停用 = 2；没有 OSS 配置时 image put 报未配置而不是崩溃", async () => {
    const acc = accessEnv(t);
    await seedAccessOrg(acc);
    const admin = await insertAccessUser(acc, { role: "platform_admin", phone: "13900000001" });
    const off = await insertAccessUser(acc, { role: "platform_admin", phone: "13900000002", status: "disabled" });
    const ok = main(["plan", "list"], full(`user:${admin}`));
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.out)).toEqual({ ok: true, plans: [] });
    expect(main(["plan", "list"], full("user:999999"))).toMatchObject({ code: 2, err: expect.stringContaining("不是有效用户") });
    expect(main(["plan", "list"], full(`user:${off}`))).toMatchObject({ code: 2, err: expect.stringContaining("不是有效用户") });
    const bad = main(["plan", "show", "0"], full(`user:${admin}`));
    expect(bad.code).toBe(2);
    expect(JSON.parse(bad.out).error.code).toBe("invalid_input");
    expect(main(["plan", "list", "--force"], full(`user:${admin}`)).code).toBe(2); // 没有旁路
  });
});
