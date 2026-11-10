// 首个超管引导（AX-2；acceptance B2、B3）。
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { accessEnv, insertAccessUser, type AccessEnv } from "../../../../tests/harness/access";
import { useTestDb } from "../../../../tests/harness/db";
import { accessBootstrapTokens, accessUsers, auditEvents, authAccounts, authUsers } from "../../../db/schema";
import { AccessError } from "../errors";
import { BOOTSTRAP_TOKEN_TTL_MS, createBootstrap } from "./bootstrap";

const t = useTestDb();
let env: AccessEnv;
let boot: ReturnType<typeof createBootstrap>;
beforeEach(() => {
  env = accessEnv(t);
  boot = createBootstrap({ db: t.db, clock: env.clock, audit: env.audit });
});

const errCode = async (p: Promise<unknown>): Promise<string> => {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(AccessError);
  return (e as AccessError).code;
};
const counts = async () => ({
  auth: (await t.db.select().from(authUsers)).length,
  access: (await t.db.select().from(accessUsers)).length,
  tokens: await t.db.select().from(accessBootstrapTokens),
  audit: (await t.db.select().from(auditEvents)).length,
});
const input = (token: string) => ({ token, phone: "13900000001", name: "首个超管" });

describe("token create", () => {
  it("令牌只返回一次，库里只有 sha256；24 小时过期", async () => {
    const { token, expiresAt } = await boot.createToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/); // 十六进制，不会以「-」开头被命令行当成选项
    const [row] = await t.db.select().from(accessBootstrapTokens);
    expect(row!.tokenSha256.equals(createHash("sha256").update(token).digest())).toBe(true);
    expect(JSON.stringify(await t.db.select().from(auditEvents), (_k, v) => (typeof v === "bigint" ? v.toString() : v))).not.toContain(token); // 令牌明文不进审计
    expect(expiresAt.getTime() - env.clock.now().getTime()).toBe(BOOTSTRAP_TOKEN_TTL_MS);
    expect(row!.consumedAt).toBeNull();
  });
});

describe("bootstrap-superadmin（B2、B3）", () => {
  it("令牌有效且无超管 → 待激活超管（无密码、不发短信）；令牌 consumed；再用被拒；审计 bootstrap_superadmin", async () => {
    const { token } = await boot.createToken();
    const { userId } = await boot.bootstrapSuperadmin(input(token));
    const [u] = await t.db.select().from(accessUsers).where(eq(accessUsers.userId, BigInt(userId)));
    expect(u).toMatchObject({ roleCode: "platform_admin", status: "pending_activation", phone: "13900000001", displayName: "首个超管" });
    expect(await t.db.select().from(authAccounts)).toHaveLength(0);
    expect(env.sender.sent).toHaveLength(0);
    const [tk] = await t.db.select().from(accessBootstrapTokens);
    expect(tk).toMatchObject({ consumedUserId: BigInt(userId) });
    expect(tk!.consumedAt).not.toBeNull();
    expect(await t.db.select().from(auditEvents).where(eq(auditEvents.eventType, "bootstrap_superadmin"))).toHaveLength(1);
    // 同一令牌再用：先失败于「已使用」
    expect(await errCode(boot.bootstrapSuperadmin({ ...input(token), phone: "13900000002" }))).toBe("token_used");
  });

  it("四种拒绝（无令牌 / 令牌错误 / 已过期 / 已有未停用超管），各自零写入", async () => {
    const { token } = await boot.createToken();
    const base = await counts();
    expect(await errCode(boot.bootstrapSuperadmin(input("")))).toBe("token_invalid");
    expect(await errCode(boot.bootstrapSuperadmin(input("not-the-token")))).toBe("token_invalid");
    expect(await counts()).toEqual(base);

    env.clock.advance(BOOTSTRAP_TOKEN_TTL_MS); // 恰好到期即失效
    expect(await errCode(boot.bootstrapSuperadmin(input(token)))).toBe("token_expired");
    expect(await counts()).toEqual(base);

    const fresh = await boot.createToken();
    await insertAccessUser(env, { role: "platform_admin", phone: "13000000001" });
    const before = await counts();
    expect(await errCode(boot.bootstrapSuperadmin(input(fresh.token)))).toBe("superadmin_exists");
    expect(await counts()).toEqual(before);
  });

  it("已有的超管全是停用的 → 允许引导（找回入口）；待激活的超管算『未停用』→ 拒绝", async () => {
    await insertAccessUser(env, { role: "platform_admin", phone: "13000000001", status: "disabled" });
    const a = await boot.createToken();
    await boot.bootstrapSuperadmin(input(a.token));
    const b = await boot.createToken();
    expect(await errCode(boot.bootstrapSuperadmin({ ...input(b.token), phone: "13900000002" }))).toBe("superadmin_exists");
  });

  it("手机号 / 姓名不合法，或手机号被占用 → 拒绝且令牌不被消耗", async () => {
    const { token } = await boot.createToken();
    expect(await errCode(boot.bootstrapSuperadmin({ token, phone: "123", name: "x" }))).toBe("phone_invalid");
    expect(await errCode(boot.bootstrapSuperadmin({ token, phone: "13900000001", name: " " }))).toBe("name_invalid");
    await insertAccessUser(env, { role: "branch_manager", phone: "13900000001", brandIds: [], branchIds: [] });
    expect(await errCode(boot.bootstrapSuperadmin(input(token)))).toBe("phone_exists");
    const [tk] = await t.db.select().from(accessBootstrapTokens);
    expect(tk!.consumedAt).toBeNull();
  });

  it("两个不同令牌并发引导：只成功一个", async () => {
    const a = await boot.createToken();
    const b = await boot.createToken();
    const r = await Promise.allSettled([boot.bootstrapSuperadmin(input(a.token)), boot.bootstrapSuperadmin({ ...input(b.token), phone: "13900000002" })]);
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect((await t.db.select().from(accessUsers).where(eq(accessUsers.roleCode, "platform_admin"))).length).toBe(1);
  });
});
