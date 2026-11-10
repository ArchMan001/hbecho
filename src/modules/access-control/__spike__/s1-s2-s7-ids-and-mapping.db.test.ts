// S1 自增 BIGINT 用户 / 会话 ID；S2 表名 / 列名映射；S7 必填 email 的处理。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "mysql2/promise";
import { createPool } from "../../../db/client";
import { createSpikeAuth, resetAuthTables } from "./spike-auth";

let pool: Pool;
beforeAll(async () => {
  pool = createPool(process.env.HBECHO_TEST_DATABASE_URL!);
  await resetAuthTables(pool);
});
afterAll(async () => {
  await resetAuthTables(pool);
  await pool.end();
});

describe("S1/S2：BIGINT 自增 ID 与 auth_* 映射", () => {
  it("建用户 → 密码登录 → 读会话：ID 为自增 BIGINT，库对外给出十进制字符串", async () => {
    const { auth } = createSpikeAuth(pool);
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser({
      name: "张三",
      email: "u1@hbecho.invalid",
      emailVerified: false,
      phoneNumber: "13800000001",
      phoneNumberVerified: true,
    } as never, { method: "phone-number" });
    expect(typeof user.id).toBe("string");
    expect(user.id).toMatch(/^[1-9]\d*$/);

    const hash = await ctx.password.hash("Passw0rd!x");
    await ctx.internalAdapter.linkAccount({ userId: user.id, providerId: "credential", accountId: user.id, password: hash });

    const res = await auth.api.signInPhoneNumber({
      body: { phoneNumber: "13800000001", password: "Passw0rd!x" },
      asResponse: true,
    });
    expect(res.status).toBe(200);
    const cookie = res.headers.getSetCookie().join("; ");
    expect(cookie).toContain("session_token");

    const sess = await auth.api.getSession({ headers: new Headers({ cookie: cookieHeader(res) }) });
    expect(sess).not.toBeNull();
    expect(typeof sess!.user.id).toBe("string");
    expect(sess!.user.id).toBe(user.id);
    expect(typeof sess!.session.id).toBe("string");

    // 数据库里的列是 BIGINT AUTO_INCREMENT，表名 / 列名是 auth_* / snake_case（S2）
    const [cols] = await pool.query(
      "SELECT table_name AS t, column_name AS c, column_type AS ty, extra AS ex FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name LIKE 'auth\\_%' AND column_name IN ('id','user_id','email_verified','phone_number')",
    );
    const rows = cols as Array<{ t: string; c: string; ty: string; ex: string }>;
    for (const t of ["auth_users", "auth_sessions", "auth_accounts", "auth_verifications"]) {
      const idc = rows.find((r) => r.t === t && r.c === "id");
      expect(idc?.ty).toBe("bigint");
      expect(idc?.ex).toContain("auto_increment");
    }
    expect(rows.find((r) => r.t === "auth_sessions" && r.c === "user_id")?.ty).toBe("bigint");
    expect(rows.find((r) => r.t === "auth_users" && r.c === "phone_number")).toBeDefined();
  });

  // 天花板（2026-11-10 在 better-auth 1.7.18 实测）：库在 `generateId: "serial"` 下把 ID 当 JS Number 处理。
  // 自增起点抬到 2^53 + 1 之后，createUser 不报错而是陷入内存耗尽的异步死循环（4 GB 堆被占满，进程 SIGABRT），
  // 所以这里不能放「超过 2^53」的用例。自增 ID 走不到那里（约 9×10^15 行）；ADR-0015 记录这条，
  // 并要求：认证表的 ID 永远由数据库自增，不得人为设置起点或写入大号 ID。
  it("S1 上限：贴着 2^53 − 1 的 ID 仍然精确往返", async () => {
    await pool.query("ALTER TABLE auth_users AUTO_INCREMENT = 9007199254740990");
    const { auth } = createSpikeAuth(pool);
    const ctx = await auth.$context;
    const a = await ctx.internalAdapter.createUser({ name: "大号", email: "big1@hbecho.invalid", emailVerified: false } as never, { method: "phone-number" });
    expect(a.id).toBe("9007199254740990");
    const found = await ctx.internalAdapter.findUserById(a.id);
    expect(found?.id).toBe("9007199254740990");
    await pool.query("ALTER TABLE auth_users AUTO_INCREMENT = 1000");
  });
});

describe("S7：必填 email", () => {
  it("email 不可为空；合成值唯一，重复被数据库拒绝", async () => {
    const { auth } = createSpikeAuth(pool);
    const ctx = await auth.$context;
    await expect(ctx.internalAdapter.createUser({ name: "x", emailVerified: false } as never, { method: "phone-number" })).rejects.toThrow();
    await ctx.internalAdapter.createUser({ name: "a", email: "same@hbecho.invalid", emailVerified: false } as never, { method: "phone-number" });
    await expect(
      ctx.internalAdapter.createUser({ name: "b", email: "same@hbecho.invalid", emailVerified: false } as never, { method: "phone-number" }),
    ).rejects.toThrow();
  });
});

function cookieHeader(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}
