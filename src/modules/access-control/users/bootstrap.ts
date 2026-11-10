// 首个超管引导（design §7.12、AX-2）：数据库里还没有任何超管时，用一次性令牌建出第一个待激活超管。
//   token create            生成 32 字节随机令牌（64 位十六进制），只返回一次，库里只存 sha256，24 小时过期
//   bootstrapSuperadmin     令牌存在、未过期、未用 → 当前没有未停用超管 → 建用户 → 令牌 consumed → 审计；任一步失败整体回滚
// 不发短信；超管随后自己走短信激活（和其他用户同一条路径，没有管理员设置密码的入口）。
import { createHash, randomBytes } from "node:crypto";
import { and, asc, eq, ne } from "drizzle-orm";
import { accessBootstrapTokens, accessUsers } from "../../../db/schema";
import { normalizePhone } from "../../phone";
import { AccessError } from "../errors";
import { createUserRecord, type UserDeps } from "./shared";

/** 审计与 created_by 里的主体：CLI 操作者（有数据库凭证的运维），不是用户也不是 Worker 服务身份。 */
export const BOOTSTRAP_ACTOR = "cli:bootstrap";
export const BOOTSTRAP_TOKEN_TTL_MS = 24 * 3_600_000;

const digest = (token: string): Buffer => createHash("sha256").update(token, "utf8").digest();

export function createBootstrap(deps: Pick<UserDeps, "db" | "clock" | "audit">) {
  const { db } = deps;
  return {
    /** 令牌明文只在返回值里出现这一次。 */
    async createToken(): Promise<{ token: string; expiresAt: Date }> {
      // 十六进制：base64url 的令牌可能以「-」开头，会被命令行参数解析当成选项
      const token = randomBytes(32).toString("hex");
      const now = deps.clock.now();
      const expiresAt = new Date(now.getTime() + BOOTSTRAP_TOKEN_TTL_MS);
      await db.transaction(async (tx) => {
        const [r] = await tx.insert(accessBootstrapTokens).values({ tokenSha256: digest(token), createdByActor: BOOTSTRAP_ACTOR, createdAt: now, expiresAt });
        await deps.audit.write(
          { actor: BOOTSTRAP_ACTOR, eventType: "bootstrap_token_created", outcome: "succeeded", reasonCode: "bootstrap_token_created", targetType: "bootstrap_token", targetId: String(r.insertId) },
          { tx, risk: "high" },
        );
      });
      return { token, expiresAt };
    },

    async bootstrapSuperadmin(input: { token: string; phone: string; name: string }): Promise<{ userId: string }> {
      const phone = normalizePhone(input.phone);
      if (phone === null) throw new AccessError("input", "phone_invalid", "手机号不合法");
      const name = input.name.trim();
      if (name === "" || name.length > 100) throw new AccessError("input", "name_invalid", "姓名为空或超过 100 个字符");
      if (input.token.trim() === "") throw new AccessError("authorization", "token_invalid", "引导令牌无效");
      const hash = digest(input.token.trim());
      const userId = await db.transaction(async (tx) => {
        // 锁住令牌表全部行（表很小，增长型清理保证有界）：两个不同令牌的并发引导也在这里串行，
        // 随后的「是否已有超管」判断才不会被并发穿透
        const tokens = await tx.select().from(accessBootstrapTokens).orderBy(asc(accessBootstrapTokens.tokenId)).for("update");
        const row = tokens.find((r) => Buffer.compare(r.tokenSha256, hash) === 0);
        if (!row) throw new AccessError("authorization", "token_invalid", "引导令牌无效");
        if (row.consumedAt !== null) throw new AccessError("authorization", "token_used", "引导令牌已使用");
        if (row.expiresAt.getTime() <= deps.clock.now().getTime()) throw new AccessError("authorization", "token_expired", "引导令牌已过期");
        const existing = await tx.select({ id: accessUsers.userId }).from(accessUsers).where(and(eq(accessUsers.roleCode, "platform_admin"), ne(accessUsers.status, "disabled"))).limit(1);
        if (existing.length > 0) throw new AccessError("conflict", "superadmin_exists", "已经存在未停用的超级管理员，引导入口关闭");
        const id = await createUserRecord(tx, deps, {
          name,
          role: "platform_admin",
          phone,
          brandIds: new Set(),
          branchIds: new Set(),
          mediaStaffId: null,
          createdByActor: BOOTSTRAP_ACTOR,
          createdByUserId: null,
        });
        await tx.update(accessBootstrapTokens).set({ consumedAt: deps.clock.now(), consumedUserId: id }).where(eq(accessBootstrapTokens.tokenId, row.tokenId));
        await deps.audit.write(
          { actor: BOOTSTRAP_ACTOR, eventType: "bootstrap_superadmin", outcome: "succeeded", reasonCode: "bootstrap_superadmin", targetType: "user", targetId: id.toString(), detail: { phone } },
          { tx, risk: "high" },
        );
        return id;
      });
      return { userId: userId.toString() };
    },
  };
}

export type Bootstrap = ReturnType<typeof createBootstrap>;
