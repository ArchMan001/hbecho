// 任务 2：提交、幂等、预检、取消（R1.1–R1.9、R18.6；acceptance A1–A6、A10）。
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { serviceActor } from "../../../tests/harness/actors";
import { MemoryAuditSink } from "../../../tests/harness/audit";
import { useTestDb } from "../../../tests/harness/db";
import { FakeClock } from "../../../tests/harness/fake-clock";
import { insertTask, sha } from "../../../tests/harness/factories";
import { BIG_STAFF_ID, platformIdOf, seedOrg, seedSyncSettings, type OrgSeed } from "../../../tests/harness/seed";
import { jcsSha256Hex } from "../canonical-json";
import { syncBatches, syncTasks, odsProviderCalls } from "../../db/schema";
import { TracerError, createTracerCommands, type TracerCommands } from "./index";

const START = new Date("2026-11-04T08:00:00.000Z");
const YEAR_MS = 365 * 24 * 3600 * 1000;
const LOCATOR = 'https://www.xiaohongshu.com/user/profile/测试?x="a"&line=一\n二';
const t = useTestDb();

async function setup(config?: Parameters<typeof createTracerCommands>[0]["config"]) {
  const clock = new FakeClock(START);
  const audit = new MemoryAuditSink();
  const org = await seedOrg(t.db, clock.now());
  await seedSyncSettings(t.db, clock.now());
  const commands = createTracerCommands({ db: t.db, clock, audit, ...(config ? { config } : {}) });
  return { clock, audit, org, commands };
}

const input = (org: OrgSeed, over: Record<string, unknown> = {}) => ({
  platform: "xiaohongshu",
  mediaStaffId: org.staffA.toString(),
  homeLocator: LOCATOR,
  idempotencyKey: "key-1",
  ...over,
});

const counts = async () => {
  return {
    batches: (await t.db.select().from(syncBatches)).length,
    tasks: (await t.db.select().from(syncTasks)).length,
    calls: (await t.db.select().from(odsProviderCalls)).length,
  };
};

const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof TracerError) return e.code;
    throw e;
  }
  return "no_error";
};

describe("A1 提交：持久化一条 canonical command，返回十进制字符串 root_task_id（R1.1）", () => {
  it("创建一个 manual 批次和一个根 resolve_account 任务，字段符合 v2 §9.3", async () => {
    const { commands, org } = await setup();
    const r = await commands.submit(input(org), serviceActor());
    expect(r.rootTaskId).toMatch(/^[1-9]\d*$/);
    expect(r).toMatchObject({ deduplicated: false, reusedActiveTask: false });

    const [root] = await t.db.select().from(syncTasks).where(eq(syncTasks.taskId, BigInt(r.rootTaskId)));
    expect(root).toMatchObject({
      requestedAction: "resolve_account",
      subjectType: "media_staff",
      subjectId: org.staffA,
      subjectKey: LOCATOR, // 原始 locator 逐码点保留
      status: "pending",
      attemptCount: 0,
      submittedByActor: "service:test",
      parentTaskId: null,
      accountId: null,
    });
    expect(root!.platformId).toBe(await platformIdOf(t.db, "xiaohongshu"));
    expect(root!.subjectKeySha256!.equals(sha(LOCATOR))).toBe(true);
    expect(root!.expiresAt.getTime()).toBe(START.getTime() + YEAR_MS);

    // 两字段 persistence-projection，不是完整 command
    expect(root!.taskParameters).toEqual({
      schema_version: "data-foundation-tracer-task-parameters.v1",
      effective_initial_content_limit: 20,
    });

    const [batch] = await t.db.select().from(syncBatches).where(eq(syncBatches.batchId, root!.batchId));
    expect(batch).toMatchObject({ triggerType: "manual", purpose: "intake", status: "running", settingsVersion: 1n });
    expect(batch!.logicalAt.getTime()).toBe(START.getTime());
    expect(batch!.settingsSnapshot).toMatchObject({ initial_content_limit: 20 });
    expect(await counts()).toEqual({ batches: 1, tasks: 1, calls: 0 });
  });

  it("canonical command 摘要严格等于 JCS(五字段) 的 SHA-256；staff ID 超过 2^53 也不丢精度", async () => {
    const { commands, org } = await setup();
    const r = await commands.submit(input(org, { mediaStaffId: BIG_STAFF_ID.toString(), platform: "xiaohongshu" }), serviceActor());
    const [root] = await t.db.select().from(syncTasks).where(eq(syncTasks.taskId, BigInt(r.rootTaskId)));
    expect(root!.subjectId).toBe(9007199254740993n);
    const expected = jcsSha256Hex({
      schema_version: "data-foundation-tracer-command.v1",
      platform_id_decimal: (await platformIdOf(t.db, "xiaohongshu")).toString(),
      media_staff_id_decimal: "9007199254740993",
      home_locator_exact_utf8: LOCATOR,
      effective_initial_content_limit: 20,
    });
    expect(root!.canonicalCommandSha256!.toString("hex")).toBe(expected);
  });

  it("initial_content_limit：缺省取批次冻结的 sync_settings，显式值 1–20 覆盖，越界拒绝", async () => {
    const clock = new FakeClock(START);
    const org = await seedOrg(t.db, clock.now());
    await seedSyncSettings(t.db, clock.now(), { initialContentLimit: 15 });
    const commands = createTracerCommands({ db: t.db, clock, audit: new MemoryAuditSink() });

    const a = await commands.submit(input(org, { idempotencyKey: "a" }), serviceActor());
    const b = await commands.submit(input(org, { idempotencyKey: "b", initialContentLimit: 7 }), serviceActor());
    const limit = async (id: string) =>
      ((await t.db.select().from(syncTasks).where(eq(syncTasks.taskId, BigInt(id))))[0]!.taskParameters as { effective_initial_content_limit: number })
        .effective_initial_content_limit;
    expect(await limit(a.rootTaskId)).toBe(15);
    expect(await limit(b.rootTaskId)).toBe(7);
    for (const bad of [0, 21, 1.5, "7", -1]) {
      expect(await codeOf(commands.submit(input(org, { idempotencyKey: `x-${String(bad)}`, initialContentLimit: bad }), serviceActor()))).toBe("invalid_input");
    }
  });

  it("输入校验：缺字段、空串、超长 locator、非十进制 staff id 都以 invalid_input 拒绝，且不写库", async () => {
    const { commands, org } = await setup();
    const bad: Array<Record<string, unknown>> = [
      { platform: "" },
      { mediaStaffId: "abc" },
      { mediaStaffId: "0" },
      { mediaStaffId: "007" },
      { mediaStaffId: 5 },
      { homeLocator: "" },
      { homeLocator: "x".repeat(2049) },
      { idempotencyKey: "" },
      { idempotencyKey: "k".repeat(201) },
      { unexpected: 1 },
    ];
    for (const over of bad) {
      expect(await codeOf(commands.submit(input(org, over), serviceActor())), JSON.stringify(over)).toBe("invalid_input");
    }
    expect(await codeOf(commands.submit(null, serviceActor()))).toBe("invalid_input");
    expect(await counts()).toEqual({ batches: 0, tasks: 0, calls: 0 });
  });

  it("MediaStaff 不存在 / 已停用 → 稳定错误码，不写库", async () => {
    const { commands, org } = await setup();
    expect(await codeOf(commands.submit(input(org, { mediaStaffId: "424242" }), serviceActor()))).toBe("media_staff_not_found");
    expect(await codeOf(commands.submit(input(org, { mediaStaffId: org.staffInactive.toString() }), serviceActor()))).toBe("media_staff_inactive");
    expect(await counts()).toEqual({ batches: 0, tasks: 0, calls: 0 });
  });

  it("没有 sync_settings 时给出配置缺失，而不是用默认值硬编码", async () => {
    const clock = new FakeClock(START);
    const org = await seedOrg(t.db, clock.now());
    const commands = createTracerCommands({ db: t.db, clock, audit: new MemoryAuditSink() });
    expect(await codeOf(commands.submit(input(org), serviceActor()))).toBe("sync_settings_missing");
    expect(await counts()).toEqual({ batches: 0, tasks: 0, calls: 0 });
  });
});

describe("A2 / A3 幂等（R1.2、R1.3）", () => {
  it("相同 actor + key + payload 返回原 root，不新增任何业务事实或供应商调用", async () => {
    const { commands, org } = await setup();
    const first = await commands.submit(input(org), serviceActor());
    const second = await commands.submit(input(org), serviceActor());
    expect(second).toEqual({ rootTaskId: first.rootTaskId, deduplicated: true, reusedActiveTask: false });
    expect(await counts()).toEqual({ batches: 1, tasks: 1, calls: 0 });
  });

  it("相同 key、不同 payload（locator / limit / staff / platform）→ idempotency_conflict，不新建 root", async () => {
    const { commands, org } = await setup();
    await commands.submit(input(org), serviceActor());
    for (const over of [
      { homeLocator: LOCATOR + "#x" },
      { initialContentLimit: 10 },
      { mediaStaffId: org.staffB.toString() },
      { platform: "douyin" },
    ]) {
      expect(await codeOf(commands.submit(input(org, over), serviceActor())), JSON.stringify(over)).toBe("idempotency_conflict");
    }
    expect(await counts()).toEqual({ batches: 1, tasks: 1, calls: 0 });
  });

  it("幂等 key 按 actor 隔离：另一个 actor 用相同 key 是新的命令，互不影响", async () => {
    const { commands, org } = await setup();
    const a = await commands.submit(input(org), serviceActor({ actorId: "service:a" }));
    await t.db.update(syncTasks).set({ status: "succeeded" }).where(eq(syncTasks.taskId, BigInt(a.rootTaskId))); // 终态，避免触发 R1.8 的活动任务复用
    const b = await commands.submit(input(org), serviceActor({ actorId: "service:b" }));
    expect(b).toMatchObject({ deduplicated: false, reusedActiveTask: false });
    expect(b.rootTaskId).not.toBe(a.rootTaskId);
    expect((await commands.submit(input(org), serviceActor({ actorId: "service:a" }))).rootTaskId).toBe(a.rootTaskId);
  });

  it("两个相同提交并发到达：只会有一个 root（唯一键兜底，另一个转为去重）", async () => {
    const { commands, org } = await setup();
    const [a, b] = await Promise.all([commands.submit(input(org), serviceActor()), commands.submit(input(org), serviceActor())]);
    expect(a.rootTaskId).toBe(b.rootTaskId);
    expect(await counts()).toEqual({ batches: 1, tasks: 1, calls: 0 });
  });
});

describe("A4 预检：授权、范围、capability（R1.4、R1.5）——任何写入与供应商调用之前拒绝", () => {
  it("缺 Capability → forbidden；平台或专员超出范围 → out_of_scope；都不写库", async () => {
    const { commands, org, audit } = await setup();
    expect(await codeOf(commands.submit(input(org), serviceActor({ capabilities: new Set() })))).toBe("forbidden");
    expect(await codeOf(commands.submit(input(org), serviceActor({ capabilities: new Set(["data.media.read"]) })))).toBe("forbidden");
    expect(
      await codeOf(commands.submit(input(org), serviceActor({ scope: { platformCodes: new Set(["douyin"]), mediaStaffIds: "all" } }))),
    ).toBe("out_of_scope");
    expect(
      await codeOf(commands.submit(input(org), serviceActor({ scope: { platformCodes: "all", mediaStaffIds: new Set([org.staffB]) } }))),
    ).toBe("out_of_scope");
    expect(await counts()).toEqual({ batches: 0, tasks: 0, calls: 0 });
    expect(audit.events.map((e) => e.code)).toEqual(["forbidden", "forbidden", "out_of_scope", "out_of_scope"]);
  });

  it("未登记的平台（快手）、production 环境（没有任何已批准的 tuple）→ unsupported_capability", async () => {
    const { commands, org } = await setup();
    expect(await codeOf(commands.submit(input(org, { platform: "kuaishou" }), serviceActor()))).toBe("unsupported_capability");
    expect(await codeOf(commands.submit(input(org, { platform: "wechat_channels" }), serviceActor()))).toBe("unsupported_capability");
    expect(await counts()).toEqual({ batches: 0, tasks: 0, calls: 0 });

    const prod = createTracerCommands({
      db: t.db,
      clock: new FakeClock(START),
      audit: new MemoryAuditSink(),
      config: { environment: "production", modes: { media_user_info: "synchronous", user_video_list: "synchronous" } },
    });
    expect(await codeOf(prod.submit(input(org), serviceActor()))).toBe("unsupported_capability");
    expect(await counts()).toEqual({ batches: 0, tasks: 0, calls: 0 });
  });

  it("配置成异步列表也被拒绝（供应商失败，保持 disabled）", async () => {
    const { org } = await setup();
    const cmds = createTracerCommands({
      db: t.db,
      clock: new FakeClock(START),
      audit: new MemoryAuditSink(),
      config: { environment: "test", modes: { media_user_info: "synchronous", user_video_list: "asynchronous" } },
    });
    expect(await codeOf(cmds.submit(input(org), serviceActor()))).toBe("unsupported_capability");
  });
});

describe("R1.6 审计：每次接受或拒绝都留下安全的结果", () => {
  it("接受、去重、复用、拒绝各一条事件；事件里没有原始 locator 与原始幂等 key", async () => {
    const { commands, org, audit } = await setup();
    await commands.submit(input(org), serviceActor());
    await commands.submit(input(org), serviceActor());
    await commands.submit(input(org, { idempotencyKey: "other-key" }), serviceActor());
    await codeOf(commands.submit(input(org, { mediaStaffId: "424242" }), serviceActor()));

    expect(audit.events.map((e) => `${e.outcome}:${e.code ?? ""}`)).toEqual([
      "accepted:",
      "deduplicated:",
      "reused_active_task:",
      "rejected:media_staff_not_found",
    ]);
    const text = JSON.stringify(audit.events);
    expect(text).not.toContain("xiaohongshu.com");
    expect(text).not.toContain("key-1");
    expect(text).not.toContain("other-key");
    expect(audit.events[0]).toMatchObject({ actorId: "service:test", platform: "xiaohongshu", locatorLength: LOCATOR.length });
    expect(audit.events[0]!.locatorSha256).toMatch(/^[0-9a-f]{16}$/); // 只记摘要前缀
  });
});

describe("A5 / R1.8 / R18.6 同一命令已有活动任务时复用", () => {
  it("不同 key、相同 canonical command：活动期间复用；终态之后才新建", async () => {
    const { commands, org } = await setup();
    const first = await commands.submit(input(org, { idempotencyKey: "k1" }), serviceActor());
    const dup = await commands.submit(input(org, { idempotencyKey: "k2" }), serviceActor());
    expect(dup).toEqual({ rootTaskId: first.rootTaskId, deduplicated: false, reusedActiveTask: true });
    expect(await counts()).toEqual({ batches: 1, tasks: 1, calls: 0 });

    for (const status of ["leased", "running", "retry_wait"] as const) {
      await t.db
        .update(syncTasks)
        .set({ status, leaseOwner: "w", leaseExpiresAt: new Date(START.getTime() + 1000) })
        .where(eq(syncTasks.taskId, BigInt(first.rootTaskId)));
      expect((await commands.submit(input(org, { idempotencyKey: `again-${status}` }), serviceActor())).reusedActiveTask).toBe(true);
    }

    await t.db.update(syncTasks).set({ status: "succeeded", leaseOwner: null, leaseExpiresAt: null }).where(eq(syncTasks.taskId, BigInt(first.rootTaskId)));
    const fresh = await commands.submit(input(org, { idempotencyKey: "k3" }), serviceActor());
    expect(fresh.rootTaskId).not.toBe(first.rootTaskId);
    expect(fresh.reusedActiveTask).toBe(false);
  });

  it("不同专员或不同 locator 不算同一命令，不会被误复用", async () => {
    const { commands, org } = await setup();
    const a = await commands.submit(input(org, { idempotencyKey: "a" }), serviceActor());
    const b = await commands.submit(input(org, { idempotencyKey: "b", mediaStaffId: org.staffB.toString() }), serviceActor());
    const c = await commands.submit(input(org, { idempotencyKey: "c", homeLocator: LOCATOR + "2" }), serviceActor());
    expect(new Set([a.rootTaskId, b.rootTaskId, c.rootTaskId]).size).toBe(3);
  });
});

describe("A10 / R1.7 一年窗口", () => {
  it("窗口内返回原 root；窗口外同 key 视为新命令，旧 root 的 key 被释放，旧 status 不再承诺", async () => {
    const { commands, org, clock } = await setup();
    const first = await commands.submit(input(org), serviceActor());
    await t.db.update(syncTasks).set({ status: "succeeded" }).where(eq(syncTasks.taskId, BigInt(first.rootTaskId)));

    clock.advance(YEAR_MS - 1);
    expect((await commands.submit(input(org), serviceActor())).rootTaskId).toBe(first.rootTaskId);

    clock.advance(1); // 恰好到期：expires_at <= now 即过期
    const reused = await commands.submit(input(org, { homeLocator: LOCATOR + "-new" }), serviceActor()); // 不同 payload 也不再冲突
    expect(reused.rootTaskId).not.toBe(first.rootTaskId);
    expect(reused.deduplicated).toBe(false);

    const [old] = await t.db.select().from(syncTasks).where(eq(syncTasks.taskId, BigInt(first.rootTaskId)));
    expect(old).toMatchObject({ submittedByActor: null, callerIdempotencyKeySha256: null, canonicalCommandSha256: null });
    expect(await counts()).toMatchObject({ tasks: 2, batches: 2 });
  });

  it("窗口外用相同 payload 重提也是新 root，而不是返回已过期的旧 root", async () => {
    const { commands, org, clock } = await setup();
    const first = await commands.submit(input(org), serviceActor());
    await t.db.update(syncTasks).set({ status: "failed" }).where(eq(syncTasks.taskId, BigInt(first.rootTaskId)));
    clock.advance(YEAR_MS + 1000);
    const again = await commands.submit(input(org), serviceActor());
    expect(again.rootTaskId).not.toBe(first.rootTaskId);
  });
});

describe("取消（R1.9、R14.6；A6 的 prepared→not_sent 在任务 3）", () => {
  it("取消活动 root：root 与子任务进入 cancelled，fencing token 递增使迟到写入失效，不再产生新调用", async () => {
    const { commands, org } = await setup();
    const r = await commands.submit(input(org), serviceActor());
    const rootId = BigInt(r.rootTaskId);
    const [root] = await t.db.select().from(syncTasks).where(eq(syncTasks.taskId, rootId));
    await t.db.update(syncTasks).set({ status: "running", leaseOwner: "w1", leaseExpiresAt: new Date(START.getTime() + 60_000), fencingToken: 3n }).where(eq(syncTasks.taskId, rootId));
    const stage = await insertTask(t.db, { batchId: root!.batchId, platform: "xiaohongshu", now: START, action: "fetch_profile", status: "pending" });
    await t.db.update(syncTasks).set({ parentTaskId: rootId }).where(eq(syncTasks.taskId, stage));

    const out = await commands.cancel(r.rootTaskId, serviceActor());
    expect(out.state).toBe("cancelled");

    const [after] = await t.db.select().from(syncTasks).where(eq(syncTasks.taskId, rootId));
    expect(after).toMatchObject({ status: "cancelled", leaseOwner: null, leaseExpiresAt: null, stopReason: "cancelled_by_actor" });
    expect(after!.fencingToken).toBe(4n);
    expect(after!.finishedAt).not.toBeNull();
    const [afterStage] = await t.db.select().from(syncTasks).where(eq(syncTasks.taskId, stage));
    expect(afterStage).toMatchObject({ status: "cancelled" });
    expect(afterStage!.fencingToken).toBe(1n);
    expect(await counts()).toMatchObject({ calls: 0 });
  });

  it("重复取消、取消终态 root 都是幂等 no-op，不改动 fencing token", async () => {
    const { commands, org } = await setup();
    const r = await commands.submit(input(org), serviceActor());
    await commands.cancel(r.rootTaskId, serviceActor());
    const [a] = await t.db.select().from(syncTasks).where(eq(syncTasks.taskId, BigInt(r.rootTaskId)));
    await commands.cancel(r.rootTaskId, serviceActor());
    const [b] = await t.db.select().from(syncTasks).where(eq(syncTasks.taskId, BigInt(r.rootTaskId)));
    expect(b!.fencingToken).toBe(a!.fencingToken);

    const done = await commands.submit(input(org, { idempotencyKey: "done" , homeLocator: LOCATOR + "z"}), serviceActor());
    await t.db.update(syncTasks).set({ status: "succeeded" }).where(eq(syncTasks.taskId, BigInt(done.rootTaskId)));
    expect((await commands.cancel(done.rootTaskId, serviceActor())).state).not.toBe("cancelled");
  });

  it("未知、越权的 root 一律 not_found；缺 Capability 为 forbidden", async () => {
    const { commands, org } = await setup();
    const r = await commands.submit(input(org), serviceActor());
    expect(await codeOf(commands.cancel("999999", serviceActor()))).toBe("not_found");
    expect(await codeOf(commands.cancel("abc", serviceActor()))).toBe("invalid_input");
    expect(
      await codeOf(commands.cancel(r.rootTaskId, serviceActor({ scope: { platformCodes: "all", mediaStaffIds: new Set([org.staffB]) } }))),
    ).toBe("not_found");
    expect(await codeOf(commands.cancel(r.rootTaskId, serviceActor({ capabilities: new Set() })))).toBe("forbidden");
  });

  it("取消后用相同 key + payload 重提，仍返回原（已取消的）root——幂等不因终态而重建", async () => {
    const { commands, org } = await setup();
    const r = await commands.submit(input(org), serviceActor());
    await commands.cancel(r.rootTaskId, serviceActor());
    const again = await commands.submit(input(org), serviceActor());
    expect(again).toEqual({ rootTaskId: r.rootTaskId, deduplicated: true, reusedActiveTask: false });
  });
});

export type { TracerCommands };
