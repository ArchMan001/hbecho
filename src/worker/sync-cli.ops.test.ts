// CLI · 处置 / 状态 / 维护命令：参数解析、透传给 Module、退出码。Module 本身的行为在各自的 db 测试里。
import { describe, expect, it } from "vitest";
import { SyncError, type SyncCommands } from "../modules/sync-schedule";
import { CAP_SYNC_TRIGGER, type ActorContext } from "../modules/tracer-command";
import { runSyncCli } from "./sync-cli";

const actor: ActorContext = { actorId: "service:test", capabilities: new Set([CAP_SYNC_TRIGGER]), scope: { platformCodes: "all", mediaStaffIds: "all" } };
function harness(opts: { enabled?: boolean; fail?: SyncError; maintainOk?: boolean } = {}) {
  const calls: Array<[string, unknown]> = [];
  const actors: unknown[] = []; // 处置命令都带着调用方身份
  const rec = (name: string, result: unknown = { ok: true }) => async (...a: unknown[]) => {
    calls.push([name, a[0]]);
    if (a.length > 1) actors.push(a[1]);
    if (opts.fail) throw opts.fail;
    return result;
  };
  const out: string[] = [];
  const enabled = opts.enabled !== false;
  const run = async (argv: string[]) => {
    const code = await runSyncCli(argv, {
      scheduler: { tick: async () => ({}) as never },
      commands: { createSupplement: rec("supplement"), cancelBatch: rec("cancel"), listBatches: rec("batches") } as unknown as SyncCommands,
      ...(enabled
        ? {
            ops: { rebind: rec("rebind"), confirmDeleted: rec("confirm-deleted"), setIssueStatus: rec("issue-set"), listIssues: rec("issue-list", []), retryFailed: rec("retry-failed"), externalAdd: rec("ext-add"), externalEnable: rec("ext-enable"), externalDisable: rec("ext-disable"), externalList: rec("ext-list", []) } as never,
            monitoringSwitch: { set: rec("monitoring") } as never,
            status: { status: rec("status"), batch: rec("batch-report"), account: rec("account-report"), freshness: rec("freshness"), sample: rec("sample") } as never,
            maintain: async () => (calls.push(["maintain", null]), { ok: opts.maintainOk !== false, report: {} as never }),
          }
        : {}),
      actor,
      stdout: (s) => void out.push(s),
      stderr: () => {},
    });
    return { code, json: out.length ? JSON.parse(out.at(-1)!) : null };
  };
  return { run, calls, actors };
}
const last = (h: ReturnType<typeof harness>) => h.calls.at(-1)!;

describe("状态查询命令", () => {
  it("status / batch <id> / account <id> / freshness / sample 透传参数", async () => {
    const h = harness();
    expect((await h.run(["status", "--limit", "3"])).code).toBe(0);
    expect(last(h)).toEqual(["status", { limit: 3 }]);
    await h.run(["batch", "42"]);
    expect(last(h)).toEqual(["batch-report", "42"]);
    await h.run(["account", "7"]);
    expect(last(h)).toEqual(["account-report", "7"]);
    await h.run(["freshness"]);
    expect(last(h)).toEqual(["freshness", { olderThanHours: 168 }]);
    await h.run(["freshness", "--older-than-hours", "24.5"]);
    expect(last(h)).toEqual(["freshness", { olderThanHours: 24.5 }]);
    await h.run(["sample", "--n", "5", "--batch", "9"]);
    expect(last(h)).toEqual(["sample", { n: 5, batchId: "9" }]);
  });
  it("参数错误 → 2", async () => {
    const h = harness();
    for (const argv of [["status", "--limit", "x"], ["batch", "abc"], ["batch"], ["account"], ["account", "1", "extra"], ["freshness", "--older-than-hours", "-1"], ["sample"], ["sample", "--n", "x"]]) {
      expect((await h.run(argv)).code, argv.join(" ")).toBe(2);
    }
  });
});

describe("处置命令", () => {
  it("account rebind / confirm-deleted；batch retry-failed 默认预览、--apply 才写", async () => {
    const h = harness();
    await h.run(["account", "rebind", "--account", "1", "--staff", "2"]);
    expect(last(h)).toEqual(["rebind", { accountId: "1", staffId: "2" }]);
    await h.run(["account", "confirm-deleted", "--account", "1"]);
    expect(last(h)).toEqual(["confirm-deleted", { accountId: "1" }]);
    await h.run(["batch", "retry-failed", "5"]);
    expect(last(h)[1]).toEqual({ batchId: "5", apply: false });
    await h.run(["batch", "retry-failed", "5", "--apply"]);
    expect(last(h)[1]).toEqual({ batchId: "5", apply: true });
    expect(h.actors.every((a) => a === actor)).toBe(true);
  });
  it("issue list / set-status；monitoring set（--enabled 必须是 true|false，--apply 才写）", async () => {
    const h = harness();
    await h.run(["issue", "list", "--status", "open", "--limit", "10"]);
    expect(last(h)).toEqual(["issue-list", { status: "open", limit: 10 }]);
    await h.run(["issue", "set-status", "--issue", "3", "--status", "ignored", "--note", "ok"]);
    expect(last(h)[1]).toEqual({ issueId: "3", status: "ignored", note: "ok" });
    await h.run(["monitoring", "set", "--level", "store", "--id", "9", "--enabled", "false"]);
    expect(last(h)[1]).toEqual({ level: "store", id: "9", enabled: false, apply: false });
    await h.run(["monitoring", "set", "--level", "store", "--id", "9", "--enabled", "true", "--apply"]);
    expect(last(h)[1]).toEqual({ level: "store", id: "9", enabled: true, apply: true });
    for (const argv of [["monitoring", "set", "--level", "store", "--id", "9", "--enabled", "maybe"], ["monitoring", "set", "--level", "store", "--enabled", "true"], ["monitoring", "get"], ["issue", "set-status", "--issue", "1"]]) {
      expect((await h.run(argv)).code, argv.join(" ")).toBe(2);
    }
  });
  it("external add / list / enable / disable", async () => {
    const h = harness();
    await h.run(["external", "add", "--platform", "douyin", "--locator", "https://x.test/u", "--key", "k"]);
    expect(last(h)[1]).toEqual({ platform: "douyin", locator: "https://x.test/u", key: "k" });
    await h.run(["external", "disable", "--account", "4"]);
    expect(last(h)[0]).toBe("ext-disable");
    await h.run(["external", "enable", "--account", "4"]);
    expect(last(h)[0]).toBe("ext-enable");
    expect((await h.run(["external", "list"])).code).toBe(0);
    expect((await h.run(["external", "add", "--platform", "douyin"])).code).toBe(2);
  });
  it("Module 的 SyncError 按类别映射退出码（授权 2 / 冲突 3 / 不存在 4）", async () => {
    for (const [code, exit] of [["forbidden", 2], ["out_of_scope", 2], ["slot_taken", 3], ["not_retryable", 3], ["not_found", 4], ["unsupported_capability", 2]] as const) {
      const h = harness({ fail: new SyncError(code, "x") });
      expect((await h.run(["account", "rebind", "--account", "1", "--staff", "2"])).code, code).toBe(exit);
    }
  });
});

describe("maintain / 未装配", () => {
  it("maintain：成功 0，有步骤失败 1", async () => {
    expect((await harness().run(["maintain"])).code).toBe(0);
    expect((await harness({ maintainOk: false }).run(["maintain"])).code).toBe(1);
  });
  it("模块未装配：明确报「未启用」，退出码 2", async () => {
    const h = harness({ enabled: false });
    for (const argv of [["status"], ["batch", "1"], ["account", "1"], ["account", "rebind", "--account", "1", "--staff", "2"], ["issue", "list"], ["monitoring", "set", "--level", "store", "--id", "1", "--enabled", "true"], ["external", "list"], ["maintain"], ["batch", "retry-failed", "1"]]) {
      const r = await h.run(argv);
      expect(r.code, argv.join(" ")).toBe(2);
      expect(r.json.error.message).toContain("未启用");
    }
  });
});
