// 外部监控账号的创建（FS-13.5、13.6；acceptance M）：复用 tracer 解析流程，无专员、无名额、owner 快照为空，只有主页快照，不请求列表。
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { adminActor, opsActor } from "../../../tests/harness/actors";
import { useTestDb } from "../../../tests/harness/db";
import { SLOT, setupSync } from "../../../tests/harness/sync-env";
import { accountProfileSnapshots, contents, externalAccounts, staffAccountAssignments as aa, syncTasks } from "../../db/schema";
import { runTracerRoot } from "../orchestrator";
import { memorySyncAuditSink } from "../sync-schedule";
import { createTracerCommands, type AuditEvent } from "../tracer-command";
import { createSyncOps } from "./ops";

const t = useTestDb();
async function world() {
  const env = await setupSync(t);
  const audit = memorySyncAuditSink();
  const tracerAudit: AuditEvent[] = [];
  const tracer = createTracerCommands({ db: t.db, clock: env.clock, audit: { record: (e) => void tracerAudit.push(e) }, config: { environment: "test", modes: { media_user_info: "synchronous", user_video_list: "synchronous" } } });
  const ops = createSyncOps({ db: t.db, clock: env.clock, audit, tracer });
  const run = (rootTaskId: string) => runTracerRoot({ db: t.db, clock: env.clock, gateway: env.gateway, workerId: "w1" }, rootTaskId);
  return { env, audit, ops, run };
}
const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as { code?: string }).code ?? `other:${String(e)}`;
  }
  return null;
};
const LOCATOR = "https://www.douyin.com/user/MS4wLjABAAAAexample";

describe("external add", () => {
  it("超管创建 → 根任务执行后：watch_type=external、staff 为空、不占名额、只有主页快照、没有列表调用 / 内容 / 列表任务；owner 快照为空", async () => {
    const { env, ops, run } = await world();
    env.serve.profile("raw3.douyin.media_user_info");
    const r = await ops.externalAdd({ platform: "douyin", locator: LOCATOR, key: "K1" }, adminActor());
    expect(r).toMatchObject({ deduplicated: false, reusedActiveTask: false });
    const [root] = await t.db.select().from(syncTasks).where(eq(syncTasks.taskId, BigInt(r.rootTaskId)));
    expect(root).toMatchObject({ requestedAction: "resolve_account", subjectType: "external", subjectId: null });
    expect((await run(r.rootTaskId)).kind).toBe("succeeded");
    const [asg] = await t.db.select().from(aa);
    expect(asg).toMatchObject({ watchType: "external", staffId: null, monitoringEnabled: true, slotReleasedAt: null });
    expect(asg!.currentHomeLocator).toBe(LOCATOR);
    expect(await t.db.select().from(accountProfileSnapshots)).toHaveLength(1);
    expect(await t.db.select().from(contents)).toHaveLength(0);
    expect(env.transport.calls.map((c) => c.request.path)).toEqual(["/openapi/v1/media_user_info"]); // 没有列表请求
    expect((await env.tasks()).map((x) => x.requestedAction)).toEqual(["resolve_account"]); // 没有 fetch_content_list 子任务
    expect((await t.db.select().from(externalAccounts))).toHaveLength(1);
    // 之后周期批次只给它生成 fetch_profile，且出现在目标集
    await env.scheduler.tick(SLOT);
    expect((await env.tasks()).filter((x) => x.accountId === asg!.accountId && x.requestedAction !== "resolve_account").map((x) => x.requestedAction)).toEqual(["fetch_profile"]);
    // 同一专员同平台名额不受影响：外部账号不占名额
    const own = await env.addAccount("douyin", env.org.staffA, { identifier: "OWN-UID" });
    expect(own.accountId).not.toBe(asg!.accountId);
  });
  it("同键同载荷去重；同键异载荷冲突；非主页入口 / 平台不符以 invalid_link 终止且不建账号", async () => {
    const { env, ops, run } = await world();
    env.serve.profile("raw3.douyin.media_user_info");
    const a = await ops.externalAdd({ platform: "douyin", locator: LOCATOR, key: "K1" }, adminActor());
    const b = await ops.externalAdd({ platform: "douyin", locator: LOCATOR, key: "K1" }, adminActor());
    expect(b).toMatchObject({ rootTaskId: a.rootTaskId, deduplicated: true });
    expect(await code(ops.externalAdd({ platform: "douyin", locator: `${LOCATOR}2`, key: "K1" }, adminActor()))).toBe("idempotency_conflict");
    const bad = await ops.externalAdd({ platform: "douyin", locator: "https://www.douyin.com/video/7676403385372904742", key: "K2" }, adminActor());
    expect((await run(bad.rootTaskId)).kind).toBe("failed");
    const wrong = await ops.externalAdd({ platform: "douyin", locator: "https://www.xiaohongshu.com/user/profile/abc", key: "K3" }, adminActor());
    expect((await run(wrong.rootTaskId)).kind).toBe("failed");
    expect(await t.db.select().from(externalAccounts)).toHaveLength(0);
    expect(env.transport.calls).toHaveLength(0);
  });
  it("授权：只有超管（monitor.external.manage + platformAdmin）；其余身份在任何写入之前被拒", async () => {
    const { env, ops } = await world();
    for (const who of [opsActor(), adminActor({ platformAdmin: false })]) {
      expect(await code(ops.externalAdd({ platform: "douyin", locator: LOCATOR, key: "K9" }, who))).toBe("forbidden");
    }
    expect(await code(ops.externalAdd({ platform: "douyin", locator: LOCATOR, key: "K9" }, adminActor({ scope: { platformCodes: new Set(["xiaohongshu"]), mediaStaffIds: "all" } })))).toBe("out_of_scope");
    expect(await code(ops.externalAdd({ platform: "douyin", locator: "", key: "K9" }, adminActor()))).toBe("invalid_input");
    expect(await env.tasks()).toHaveLength(0);
  });
  it("capability 门控：生产（全部 disabled）下被拒，不建根任务", async () => {
    const env = await setupSync(t);
    const tracer = createTracerCommands({ db: t.db, clock: env.clock, audit: { record: () => {} }, config: { environment: "production", modes: { media_user_info: "synchronous", user_video_list: "synchronous" } } });
    const ops = createSyncOps({ db: t.db, clock: env.clock, audit: memorySyncAuditSink(), tracer });
    expect(await code(ops.externalAdd({ platform: "douyin", locator: LOCATOR, key: "K1" }, adminActor()))).toBe("unsupported_capability");
    expect(await env.tasks()).toHaveLength(0);
  });
});
