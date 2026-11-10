// 访问控制的测试挂具：真实 better-auth 对真实 MySQL 测试库，假短信发送器，FakeClock。
// 造数函数都带「为什么这样造」的说明，避免测试各写各的。
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  accessUserBranches,
  accessUserBrands,
  accessUsers,
  authAccounts,
  authUsers,
  branches,
  brands,
  dealers,
  mediaStaff,
  regions,
  sectors,
  stores,
} from "../../src/db/schema";
import { assembleAccess } from "../../src/modules/access-control/assemble";
import type { AccessAuth, AuthFlow } from "../../src/modules/access-control/auth-instance";
import type { LoginGuard } from "../../src/modules/access-control/login-guard";
import type { AccessAlert, SmsService } from "../../src/modules/access-control/sms";
import type { PersistentAuditWriter } from "../../src/modules/access-control/audit";
import type { AccessConfig } from "../../src/modules/access-control/config";
import { FakeSmsSender } from "../../src/modules/access-control/sms";
import { FakeClock } from "./fake-clock";
import type { TestDb } from "./db";

export const T0 = new Date("2026-11-10T02:00:00.000Z");
export const PASSWORD = "Passw0rd!x";

export function testConfig(over: Partial<AccessConfig> = {}): AccessConfig {
  return {
    authSecret: "test-secret-test-secret-test-secret-0123456789",
    publicOrigin: "http://localhost:3000",
    trustedOrigins: ["http://localhost:3000"],
    smsMode: "fake",
    smsDailyCap: 1000,
    trustedProxies: [],
    // 测试里所有请求来自同一个本地 IP，库的限流计数又是进程内共享的；阈值取大，免得不相关的用例互相挤占。
    // 限流本身的行为由 http.db.test.ts 里显式配置小阈值的用例覆盖
    authRateLimitPerMin: 100_000,
    production: false,
    ...over,
  };
}

export interface AccessEnv {
  t: TestDb;
  clock: FakeClock;
  sender: FakeSmsSender;
  config: AccessConfig;
  auth: AccessAuth;
  audit: PersistentAuditWriter;
  guard: LoginGuard;
  sms: SmsService;
  /** 全局短信上限等告警事件。 */
  alerts: AccessAlert[];
}

/**
 * 在 useTestDb() 的 beforeEach 之后调用（t.db 此时才可用）。
 * 默认接上真实的 AuthFlow（登录锁定 + 短信规则 + 激活）、真实 SmsService、假发送器、FakeClock；
 * `flow: false` 得到「只有库自己」的认证实例（任务 2 的 Route Handler 往返测试用）。
 */
export function accessEnv(t: TestDb, opts: { flow?: boolean | AuthFlow; config?: Partial<AccessConfig>; start?: Date } = {}): AccessEnv {
  const clock = new FakeClock(opts.start ?? T0);
  const sender = new FakeSmsSender();
  const config = testConfig(opts.config);
  const alerts: AccessAlert[] = [];
  // 与生产运行时同一个装配函数（assembleAccess）：测试证明的就是生产接线
  const { auth, audit, guard, sms } = assembleAccess({
    db: t.db,
    config,
    clock,
    sender,
    alert: (a) => void alerts.push(a),
    ...(opts.flow === false ? { flow: false as const } : typeof opts.flow === "object" ? { flow: opts.flow } : {}),
  });
  return { t, clock, sender, config, auth, audit, guard, sms, alerts };
}

// scrypt 哈希约 50–100 ms；所有造数用户共用同一个哈希，测试里统一用 PASSWORD 登录
let hashed: Promise<string> | undefined;
export async function passwordHash(auth: AccessAuth): Promise<string> {
  hashed ??= auth.$context.then((c) => c.password.hash(PASSWORD));
  return hashed;
}

export interface UserSpec {
  role?: "platform_admin" | "hq_manager" | "branch_manager" | "store_staff";
  phone: string;
  name?: string;
  status?: "pending_activation" | "active" | "disabled";
  /** 默认 true：有密码凭据（有效用户）。待激活用户没有凭据。 */
  password?: boolean;
  brandIds?: bigint[];
  branchIds?: bigint[];
  mediaStaffId?: bigint;
  createdByActor?: string;
  disabledReason?: "manual" | "media_staff_disabled";
  autoDisabledStaffId?: bigint;
  statusBeforeDisable?: "pending_activation" | "active";
}

/**
 * 同时造「认证用户（auth_users）」和「授权用户（access_users）」两行，这是系统里一个 User 的完整形态。
 * - 邮箱是随机合成值（库要求必填且唯一，S7）；
 * - 停用用户的登录手机号写墓碑值，原号只在 access_users.phone（design §7.9）。
 */
export async function insertAccessUser(env: AccessEnv, spec: UserSpec): Promise<bigint> {
  const { db } = env.t;
  const status = spec.status ?? "active";
  const now = env.clock.now();
  const [u] = await db.insert(authUsers).values({
    name: spec.name ?? "测试用户",
    email: `${randomUUID()}@hbecho.invalid`,
    emailVerified: false,
    phoneNumber: spec.phone, // 先写原号；停用的在拿到 ID 后改墓碑
    phoneNumberVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  const userId = BigInt(u.insertId);
  if (status === "disabled") await db.update(authUsers).set({ phoneNumber: `disabled:${userId}` }).where(eq(authUsers.id, userId));
  const hasPassword = spec.password ?? status === "active";
  if (hasPassword) {
    await db.insert(authAccounts).values({
      accountId: userId.toString(),
      providerId: "credential",
      userId,
      password: await passwordHash(env.auth),
      createdAt: now,
      updatedAt: now,
    });
  }
  const role = spec.role ?? "branch_manager";
  await db.insert(accessUsers).values({
    userId,
    roleCode: role,
    displayName: spec.name ?? "测试用户",
    phone: spec.phone,
    status,
    statusBeforeDisable: status === "disabled" ? (spec.statusBeforeDisable ?? "active") : null,
    disabledAt: status === "disabled" ? now : null,
    disabledByActor: status === "disabled" ? "user:0" : null,
    disabledReason: status === "disabled" ? (spec.disabledReason ?? "manual") : null,
    autoDisabledStaffId: spec.autoDisabledStaffId ?? null,
    mediaStaffId: spec.mediaStaffId ?? null,
    activatedAt: status === "pending_activation" ? null : now,
    createdByActor: spec.createdByActor ?? "service:test",
    createdAt: now,
    updatedAt: now,
  });
  if (spec.brandIds?.length) await db.insert(accessUserBrands).values(spec.brandIds.map((brandId) => ({ userId, brandId })));
  if (spec.branchIds?.length) await db.insert(accessUserBranches).values(spec.branchIds.map((branchId) => ({ userId, branchId })));
  return userId;
}

/** 密码登录，返回可直接用于 auth.api.* / handler 的请求头（含会话 cookie）。 */
export async function loginAs(env: AccessEnv, phone: string): Promise<Headers> {
  const res = await env.auth.api.signInPhoneNumber({ body: { phoneNumber: phone, password: PASSWORD }, asResponse: true });
  if (res.status !== 200) throw new Error(`loginAs 失败：${res.status}`);
  return new Headers({ cookie: cookieHeader(res) });
}

export function cookieHeader(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}

export interface AccessOrg {
  regionId: bigint;
  /** 北京、上海两个分公司。 */
  bj: bigint;
  sh: bigint;
  /** 三个品牌。 */
  hisense: bigint;
  hitachi: bigint;
  york: bigint;
  /** 北京分公司下：海信门店 A、日立门店 B；上海分公司下：海信门店 C。 */
  storeA: bigint;
  storeB: bigint;
  storeC: bigint;
  /** 各门店的有效专员：A 店 13800000001，B 店 13800000002，C 店 13800000003；A 店另有一名停用专员 13800000009。 */
  staffA: bigint;
  staffB: bigint;
  staffC: bigint;
  staffInactive: bigint;
}

/**
 * 小而够用的组织：「北京分公司同时有海信门店 A 和日立门店 B」是跨品牌分公司的最小样例（AX-7 验收）。
 */
export async function seedAccessOrg(env: AccessEnv): Promise<AccessOrg> {
  const { db } = env.t;
  const now = env.clock.now();
  const st = { createdAt: now, updatedAt: now };
  const [r] = await db.insert(regions).values({ regionCode: "R-N", regionName: "北区", status: "active", ...st });
  const regionId = BigInt(r.insertId);
  const br = async (code: string, name: string) => {
    const [x] = await db.insert(branches).values({ regionId, branchCode: code, branchName: name, status: "active", ...st });
    return BigInt(x.insertId);
  };
  const bj = await br("BR-BJ", "北京分公司");
  const sh = await br("BR-SH", "上海分公司");
  const sec = async (branchId: bigint, code: string) => {
    const [x] = await db.insert(sectors).values({ branchId, sectorCode: code, sectorName: "家装", status: "active", ...st });
    return BigInt(x.insertId);
  };
  const secBj = await sec(bj, "SEC-BJ");
  const secSh = await sec(sh, "SEC-SH");
  const brand = async (code: string, name: string) => {
    const [x] = await db.insert(brands).values({ brandCode: code, brandName: name, status: "active", ...st });
    return BigInt(x.insertId);
  };
  const hisense = await brand("HISENSE", "海信");
  const hitachi = await brand("HITACHI", "日立");
  const york = await brand("YORK", "约克");
  const [d] = await db.insert(dealers).values({ dealerCode: "D-1", dealerName: "测试经销商", status: "active", ...st });
  const dealerId = BigInt(d.insertId);
  const store = async (code: string, name: string, brandId: bigint, sectorId: bigint) => {
    const [x] = await db.insert(stores).values({ storeCode: code, storeName: name, dealerId, brandId, sectorId, status: "active", ...st });
    return BigInt(x.insertId);
  };
  const storeA = await store("S-A", "北京海信店", hisense, secBj);
  const storeB = await store("S-B", "北京日立店", hitachi, secBj);
  const storeC = await store("S-C", "上海海信店", hisense, secSh);
  const staff = async (storeId: bigint, name: string, phone: string, status = "active") => {
    const [x] = await db.insert(mediaStaff).values({ storeId, staffName: name, phone, status, ...st });
    return BigInt(x.insertId);
  };
  return {
    regionId,
    bj,
    sh,
    hisense,
    hitachi,
    york,
    storeA,
    storeB,
    storeC,
    staffA: await staff(storeA, "专员甲", "13800000001"),
    staffB: await staff(storeB, "专员乙", "13800000002"),
    staffC: await staff(storeC, "专员丙", "13800000003"),
    staffInactive: await staff(storeA, "专员停", "13800000009", "inactive"),
  };
}
