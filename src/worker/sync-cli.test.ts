import { describe, expect, it } from "vitest";
import { SyncError, type SyncCommands } from "../modules/sync-schedule";
import { CAP_SYNC_TRIGGER, type ActorContext } from "../modules/tracer-command";
import { runSyncCli } from "./sync-cli";

const actor: ActorContext = { actorId: "service:test", capabilities: new Set([CAP_SYNC_TRIGGER]), scope: { platformCodes: "all", mediaStaffIds: "all" } };

function harness(over: Partial<SyncCommands> = {}) {
  const calls: Array<[string, unknown[]]> = [];
  const out: string[] = [];
  const err: string[] = [];
  const commands = {
    createSupplement: async (...a: unknown[]) => (calls.push(["supplement", a]), { kind: "created", batchId: "1", status: "running", deduplicated: false, dispositions: [], plan: null }),
    cancelBatch: async (...a: unknown[]) => (calls.push(["cancel", a]), { kind: "preview", batch: {}, hint: "" }),
    listBatches: async (...a: unknown[]) => (calls.push(["list", a]), []),
    ...over,
  } as unknown as SyncCommands;
  const run = async (argv: string[]) => {
    const code = await runSyncCli(argv, {
      scheduler: { tick: async () => (calls.push(["tick", []]), { now: "x" } as never) },
      commands,
      actor,
      stdout: (s) => void out.push(s),
      stderr: (s) => void err.push(s),
    });
    return { code, json: out.length ? JSON.parse(out.at(-1)!) : null, err };
  };
  return { run, calls };
}

describe("sync CLI", () => {
  it("tick 调用调度器并输出 JSON", async () => {
    const h = harness();
    const r = await h.run(["tick"]);
    expect(r).toMatchObject({ code: 0, json: { now: "x" } });
    expect(h.calls[0]![0]).toBe("tick");
  });
  it("supplement 把参数原样交给 Module：账号拆分、只传给出的选项，--apply 才为 true", async () => {
    const h = harness();
    await h.run(["supplement", "--accounts", "1, 2,3", "--key", "k", "--only", "profile", "--if-older-than", "24", "--on-busy", "queue"]);
    expect(h.calls[0]![1][0]).toEqual({ accountIds: ["1", "2", "3"], idempotencyKey: "k", only: "profile", ifOlderThanHours: 24, onBusy: "queue" });
    await h.run(["supplement", "--accounts", "1", "--key", "k", "--on-busy", "cancel_current", "--apply"]);
    expect(h.calls[1]![1][0]).toMatchObject({ onBusy: "cancel_current", apply: true });
  });
  it("batch cancel 默认不 apply；带 --apply 才传 apply:true", async () => {
    const h = harness();
    await h.run(["batch", "cancel", "7"]);
    await h.run(["batch", "cancel", "7", "--apply"]);
    expect(h.calls.map((c) => c[1][2])).toEqual([{ apply: false }, { apply: true }]);
  });
  it("batches 透传过滤条件；limit 非数字 → 2", async () => {
    const h = harness();
    await h.run(["batches", "--limit", "5", "--purpose", "full", "--status", "running"]);
    expect(h.calls[0]![1][0]).toEqual({ limit: 5, purpose: "full", status: "running" });
    expect((await h.run(["batches", "--limit", "x"])).code).toBe(2);
  });
  it("退出码：缺参数 / 未知子命令 / 未知选项 → 2；SyncError 按类别映射；内部错误 → 1 且不泄露细节", async () => {
    const h = harness();
    expect((await h.run(["supplement", "--key", "k"])).code).toBe(2);
    expect((await h.run(["nope"])).code).toBe(2);
    expect((await h.run(["tick", "--x"])).code).toBe(2);
    expect((await h.run(["batch", "cancel"])).code).toBe(2);
    const conflict = harness({ createSupplement: async () => Promise.reject(new SyncError("idempotency_conflict", "x")) });
    expect((await conflict.run(["supplement", "--accounts", "1", "--key", "k"])).code).toBe(3);
    const missing = harness({ cancelBatch: async () => Promise.reject(new SyncError("not_found", "x")) });
    expect((await missing.run(["batch", "cancel", "1"])).code).toBe(4);
    const boom = harness({ listBatches: async () => Promise.reject(new Error("db password=secret")) });
    const r = await boom.run(["batches"]);
    expect(r.code).toBe(1);
    expect(JSON.stringify(r.json)).not.toContain("secret");
  });
  it("没有可补抓的账号 → 退出码 2，输出逐账号处置", async () => {
    const h = harness({ createSupplement: async () => ({ kind: "no_accounts", dispositions: [{ accountId: "1", disposition: "not_found" }] }) });
    const r = await h.run(["supplement", "--accounts", "1", "--key", "k"]);
    expect(r.code).toBe(2);
    expect(r.json.dispositions[0].disposition).toBe("not_found");
  });
});
