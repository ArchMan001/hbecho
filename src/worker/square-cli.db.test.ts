// f-video-square 任务 3：CLI 只做解析与转发；授权、审计、落库都在 Module（policy.db.test.ts 已覆盖）。
import { describe, expect, it } from "vitest";
import { listBrandPolicies } from "../modules/video-square";
import { useTestDb } from "../../tests/harness/db";
import { squareEnv } from "../../tests/harness/square";
import { runSquareCli } from "./square-cli";

const t = useTestDb();
type World = Awaited<ReturnType<typeof squareEnv>>;
async function run(w: World, argv: string[], role: "platform_admin" | "hq_manager" = "platform_admin", actorId: string | null = "user:1") {
  const ctx = await w.actor(role, role === "hq_manager" ? { brandIds: [w.org.hisense] } : {});
  const out: string[] = [];
  const code = await runSquareCli(argv, {
    square: w.deps,
    actorId: actorId ?? undefined,
    context: async () => ctx,
    brandIdOf: async (c) => ({ HISENSE: w.org.hisense, HITACHI: w.org.hitachi }[c]),
    stdout: (s) => void out.push(s),
    stderr: (s) => void out.push(s),
  });
  return { code, json: JSON.parse(out.join("")) as Record<string, unknown> };
}

describe("square CLI", () => {
  it("policy set 写入并回显前后值；policy list 显示全部品牌（没有行 = all）", async () => {
    const w = await squareEnv(t);
    const set = await run(w, ["policy", "set", "--brand", "HISENSE", "--mode", "own"]);
    expect(set.code).toBe(0);
    expect(set.json).toMatchObject({ ok: true, before: "all", after: "own" });
    expect((await listBrandPolicies(t.db)).find((p) => p.brandCode === "HISENSE")?.viewMode).toBe("own");
    const list = await run(w, ["policy", "list"]);
    expect(list.code).toBe(0);
    expect((list.json.policies as Array<{ brandCode: string }>).length).toBeGreaterThanOrEqual(3);
  });
  it("非超管被拒绝（退出码 2）；缺参数、未知命令、未知品牌各有明确退出码", async () => {
    const w = await squareEnv(t);
    expect((await run(w, ["policy", "set", "--brand", "HISENSE", "--mode", "own"], "hq_manager")).code).toBe(2);
    expect((await run(w, ["policy", "set", "--brand", "HISENSE"])).code).toBe(2);
    expect((await run(w, ["policy", "set", "--brand", "HISENSE", "--mode", "own", "--force"])).code).toBe(2);
    expect((await run(w, ["policy", "wipe"])).code).toBe(2);
    expect((await run(w, ["policy", "set", "--brand", "NOPE", "--mode", "own"])).code).toBe(4);
    expect((await run(w, ["policy", "list"], "platform_admin", null)).code).toBe(1);
    expect((await run(w, ["policy", "set", "--brand", "HISENSE", "--mode", "some"])).code).toBe(2);
  });
});
