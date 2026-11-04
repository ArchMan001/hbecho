// tracer 编排器的数据库测试挂具：一次装配 fake clock / fake OSS / fixture transport / 网关 / 种子 / 命令模块。
// 默认离线：transport 只返回已登记的 fixture 字节，OSS 在内存里。
import { eq } from "drizzle-orm";
import type { TestDb } from "./db";
import { resetData } from "./db";
import { serviceActor } from "./actors";
import { MemoryAuditSink } from "./audit";
import { FakeClock } from "./fake-clock";
import { FakeObjectStore } from "./fake-oss";
import { FixtureTransport } from "./fixture-transport";
import { loadFixtureBytes } from "./fixtures";
import { seedOrg, seedSyncSettings, type OrgSeed } from "./seed";
import { syncTasks } from "../../src/db/schema";
import { RawCaptureGateway, type GatewayHooks, type SendPolicy } from "../../src/modules/raw-capture";
import { createTracerCommands, createTracerStatusQuery, type TracerStatusFound } from "../../src/modules/tracer-command";

export const START = new Date("2026-11-04T08:00:00.000Z");
export const DOUYIN_LOCATOR = "https://v.douyin.com/MPOAlEqWpec/";
export const XHS_LOCATOR = "https://www.xiaohongshu.com/user/profile/49328995493";
export const PROFILE_PATH = "/openapi/v1/media_user_info";
export const LIST_PATH = "/openapi/v1/user_video_list";

export interface TracerEnvOptions {
  hooks?: GatewayHooks;
  policy?: SendPolicy;
}

export async function setupTracer(t: TestDb, opts: TracerEnvOptions = {}) {
  await resetData(t.pool);
  const clock = new FakeClock(START);
  const store = new FakeObjectStore(clock);
  const transport = new FixtureTransport();
  const org: OrgSeed = await seedOrg(t.db, clock.now());
  await seedSyncSettings(t.db, clock.now());
  const audit = new MemoryAuditSink();
  const commands = createTracerCommands({ db: t.db, clock, audit });
  const statusQuery = createTracerStatusQuery({ db: t.db, clock });
  const actor = serviceActor();
  // hooks 对象由测试在运行中改写属性（模拟崩溃点 / 抢占）
  const hooks: GatewayHooks = opts.hooks ?? {};
  const gateway = new RawCaptureGateway({
    db: t.db,
    store,
    transport,
    clock,
    location: { providerCode: "aliyun-oss", region: "cn-beijing", bucket: "hbecho-test" },
    hooks,
    ...(opts.policy ? { policy: opts.policy } : {}),
  });

  const submit = async (
    over: { platform?: string; staffId?: bigint; locator?: string; key?: string; limit?: number } = {},
  ): Promise<bigint> => {
    const out = await commands.submit(
      {
        platform: over.platform ?? "douyin",
        mediaStaffId: (over.staffId ?? org.staffA).toString(),
        homeLocator: over.locator ?? DOUYIN_LOCATOR,
        idempotencyKey: over.key ?? `k-${Math.random()}`,
        ...(over.limit === undefined ? {} : { initialContentLimit: over.limit }),
      },
      actor,
    );
    return BigInt(out.rootTaskId);
  };

  const status = async (rootTaskId: bigint): Promise<TracerStatusFound> => {
    const s = await statusQuery.get(rootTaskId.toString(), actor);
    if (s.kind !== "found") throw new Error(`状态查询期望 found，实际 ${s.kind}`);
    return s;
  };

  const root = async (rootTaskId: bigint) => {
    const [r] = await t.db.select().from(syncTasks).where(eq(syncTasks.taskId, rootTaskId));
    return r!;
  };

  const serve = {
    /** 固定响应；platform 决定用哪份 raw3 fixture。 */
    profile: (platform: "douyin" | "xiaohongshu" = "douyin", body?: Uint8Array, httpStatus = 200) =>
      transport.register({ path: PROFILE_PATH, query: { async: "false" } }, { httpStatus, body: body ?? loadFixtureBytes(`raw3.${platform}.media_user_info`) }),
    list: (platform: "douyin" | "xiaohongshu" = "douyin", body?: Uint8Array, httpStatus = 200) =>
      transport.register({ path: LIST_PATH, query: { async: "false" } }, { httpStatus, body: body ?? loadFixtureBytes(`raw3.${platform}.user_video_list`) }),
  };

  return { clock, store, transport, org, audit, commands, statusQuery, actor, gateway, hooks, submit, status, root, serve };
}

export type TracerEnv = Awaited<ReturnType<typeof setupTracer>>;
