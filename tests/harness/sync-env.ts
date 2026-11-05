// a-full-sync 账号采集 Runner 的数据库测试挂具：fake clock / fake OSS / fixture transport / 网关 / 种子 / 调度器 / 真实 worker。
// 默认离线：transport 只返回已登记的 fixture 字节。
import { eq } from "drizzle-orm";
import type { TestDb } from "./db";
import { FakeClock } from "./fake-clock";
import { FakeObjectStore } from "./fake-oss";
import { FixtureTransport, type FixtureResponse } from "./fixture-transport";
import type { ProviderResponse } from "../../src/modules/raw-capture";
import { loadFixtureBytes } from "./fixtures";
import { sha } from "./factories";
import { seedOrg, seedSyncSettings, type OrgSeed } from "./seed";
import { addStaffAccount } from "./sync-fixtures";
import { externalAccountIdentifiers, syncTasks } from "../../src/db/schema";
import { createBreakerSet } from "../../src/worker/provider-breaker";
import { createSyncWorker } from "../../src/worker/sync-worker";
import { createMonitoringResolver } from "../../src/modules/monitoring";
import { decodeProfile, type Platform } from "../../src/modules/provider-adapter";
import { RawCaptureGateway, type GatewayHooks, type SendPolicy } from "../../src/modules/raw-capture";
import { createSyncScheduler, type SyncRuntime } from "../../src/modules/sync-schedule";
import { DEFAULT_ASYNC, DEFAULT_RETRY } from "../../src/modules/tracer-command";
import type { AccountRunnerDeps, AccountRunnerHooks, RunnerRegistry } from "../../src/modules/sync-runner";

/** seedSyncSettings 的时点是每周一 02:00（北京）= 周日 18:00Z。 */
export const SLOT = new Date("2026-11-08T18:00:00Z");
export const PROFILE_PATH = "/openapi/v1/media_user_info";
export const LIST_PATH = "/openapi/v1/user_video_list";
export const RUNTIME: SyncRuntime = { environment: "test", modes: { media_user_info: "synchronous", user_video_list: "synchronous" } };

export interface SyncEnvOptions {
  hooks?: GatewayHooks;
  policy?: SendPolicy;
  runnerHooks?: AccountRunnerHooks;
  initialContentLimit?: number;
  concurrency?: number;
  leaseMs?: number;
}

export async function setupSync(t: TestDb, opts: SyncEnvOptions = {}) {
  const clock = new FakeClock(SLOT);
  const store = new FakeObjectStore(clock);
  const transport = new FixtureTransport();
  const org: OrgSeed = await seedOrg(t.db, clock.now());
  await seedSyncSettings(t.db, clock.now(), opts.initialContentLimit === undefined ? {} : { initialContentLimit: opts.initialContentLimit });
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
  const resolver = createMonitoringResolver(t.db);
  const scheduler = createSyncScheduler({ db: t.db, clock, resolver, runtime: RUNTIME });
  const runnerHooks: AccountRunnerHooks = opts.runnerHooks ?? {};
  const deps: AccountRunnerDeps = {
    db: t.db,
    clock,
    gateway,
    environment: "test",
    // 轮询间隔的等待推进 fake clock，不真的睡
    sleep: async (ms) => clock.advance(ms),
    async: DEFAULT_ASYNC,
    hooks: runnerHooks,
  };
  const worker = (runners: RunnerRegistry) =>
    createSyncWorker({
      db: t.db,
      clock,
      resolver,
      runners,
      breakers: createBreakerSet({ failures: 1000, cooldownMs: 1000, nowMs: () => clock.now().getTime() }),
      workerId: "w1",
      concurrency: opts.concurrency ?? 1,
      mediaConcurrency: 1,
      leaseMs: opts.leaseMs ?? 60_000,
      retry: DEFAULT_RETRY,
      idlePollMs: 10,
      sleep: async () => {},
    });

  /** 建一个 staff 账号并登记主页命名空间的标识（取自对应 fixture 里实际返回的值，或显式给定）。 */
  const addAccount = async (platform: Platform, staffId: bigint, o: { profileFixture?: string; identifier?: string; namespace?: string } = {}) => {
    const a = await addStaffAccount(t.db, { platform, staffId, now: clock.now() });
    const fixture = o.profileFixture ?? defaultProfileFixture(platform);
    const decoded = decodeProfile(platform, loadFixtureBytes(fixture));
    if (decoded.outcome !== "decoded" || decoded.data.account.id.state !== "value") throw new Error(`fixture ${fixture} 解不出账号标识`);
    const value = o.identifier ?? decoded.data.account.id.value;
    await registerIdentifier(t, a.accountId, o.namespace ?? decoded.data.account.namespace, value, clock.now());
    return { ...a, identifier: value, namespace: o.namespace ?? decoded.data.account.namespace };
  };

  const serve = {
    profile: (fixtureOrBytes: string | Uint8Array, httpStatus = 200, mode: "false" | "true" = "false") =>
      transport.register({ path: PROFILE_PATH, query: { async: mode } }, { httpStatus, body: typeof fixtureOrBytes === "string" ? loadFixtureBytes(fixtureOrBytes) : fixtureOrBytes }),
  };
  /** 按请求体里的入口（url 字段）分派：多个账号共用一条路由。值可以是 fixture id、字节或响应函数（可抛 TransportFailure）。 */
  const routeBy = (path: string, table: Record<string, string | Uint8Array | FixtureResponse>, httpStatus = 200) =>
    transport.register({ path, query: { async: "false" } }, (request, i) => {
      const url = (JSON.parse(new TextDecoder().decode(request.body!)) as { url: string }).url;
      const hit = table[url];
      if (hit === undefined) throw new Error(`测试没有为入口 ${url} 登记响应`);
      if (typeof hit === "function") return hit(request, i);
      if (typeof hit === "string") return { httpStatus, body: loadFixtureBytes(hit) };
      if (hit instanceof Uint8Array) return { httpStatus, body: hit };
      return hit;
    });
  /**
   * 列表路由：handler 拿到请求里的入口、max_cursor 的 JSON 字面量（整数 `0`、字符串 `"abc"`）和第几次请求，返回字节或响应（可抛 TransportFailure）。
   * 请求体原文在 transport.calls 里，测试可以直接断言回发的游标。
   */
  const routeList = (handler: (r: { url: string; cursor: string; n: number }) => Uint8Array | ProviderResponse) =>
    transport.register({ path: LIST_PATH, query: { async: "false" } }, (request, i) => {
      const text = new TextDecoder().decode(request.body!);
      const url = (JSON.parse(text) as { url: string }).url;
      const cursor = /"max_cursor":(.*?)\}$/.exec(text)?.[1] ?? "";
      const out = handler({ url, cursor, n: i });
      return out instanceof Uint8Array ? { httpStatus: 200, body: out } : out;
    });
  /** 本测试里发出的列表请求的 max_cursor 字面量（按发送顺序）。 */
  const listCursors = () =>
    transport.calls
      .filter((c) => c.request.path === LIST_PATH)
      .map((c) => /"max_cursor":(.*?)\}$/.exec(new TextDecoder().decode(c.request.body!))?.[1] ?? "");
  const locatorOf = (accountId: bigint) => `https://example.test/${accountId}`;
  const tasks = (action?: string) =>
    t.db
      .select()
      .from(syncTasks)
      .orderBy(syncTasks.taskId)
      .then((rows) => (action ? rows.filter((r) => r.requestedAction === action) : rows));
  const task = async (id: bigint) => (await t.db.select().from(syncTasks).where(eq(syncTasks.taskId, id)))[0]!;

  return { clock, store, transport, org, gateway, hooks, runnerHooks, resolver, scheduler, deps, worker, addAccount, serve, routeBy, routeList, listCursors, locatorOf, tasks, task };
}
export type SyncEnv = Awaited<ReturnType<typeof setupSync>>;

export function defaultProfileFixture(platform: Platform): string {
  return platform === "douyin" ? "raw3.douyin.media_user_info" : platform === "xiaohongshu" ? "raw3.xiaohongshu.media_user_info" : "raw12.K1";
}

export async function registerIdentifier(t: TestDb, accountId: bigint, namespace: string, value: string, now: Date): Promise<void> {
  await t.db.insert(externalAccountIdentifiers).values({
    accountId,
    namespaceCode: namespace,
    identifierValue: value,
    identifierSha256: sha(value),
    bindingMethod: "same_payload",
    confidence: "observed",
    firstSeenAt: now,
    lastSeenAt: now,
    createdAt: now,
  });
}
