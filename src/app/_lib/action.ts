// 服务端动作的公共外壳：先认证（动作也是公开入口，菜单隐藏不算权限），再调用 Module，把已知的业务拒绝翻成人话。
// 授权与范围判断全在 Module 里；这里不做第二套。
import { AccessError } from "../../modules/access-control";

/**
 * 按名字识别业务拒绝，不用 instanceof：Next 的服务端打包可能把同一个模块装成两份，instanceof 会误判成「内部错误」
 * （本机实测：邀请总部人员不选品牌，应得到「角色与范围组合不对」，用 instanceof 却变成 internal_error）。
 */
export const isAccessError = (e: unknown): e is AccessError => e instanceof Error && e.name === "AccessError";
import type { AuthContext } from "../../modules/access-control/authorize";
import { fail, ok, type ActionResult } from "./result";
import { currentSession } from "./session";

/** Module 对授权边界类拒绝给的是统一的一句话；界面按原因码说得更具体（面向业务，告诉对方怎么改）。 */
const BY_CODE: Record<string, string> = {
  shape_invalid: "角色与范围的组合不对：总部人员要选品牌；分公司人员要选品牌和分公司；超管不选；门店专员只填门店编码。",
  role_not_grantable: "你不能创建这个级别的用户：只能授予比自己低一级的角色。",
  scope_exceeds_boundary: "品牌或分公司超出了你自己的管理范围。",
  store_not_in_scope: "这个门店不在你的管理范围内。",
};

/** 文件级错误的失败项与样本（design §15.4）：只给上传者本人看，内容来自他自己上传的文件。 */
function hintOf(code: string, detail: unknown): string | undefined {
  const d = (detail ?? {}) as { expected?: unknown; got?: unknown; sample?: unknown; rows?: unknown; bytes?: unknown };
  const list = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x).slice(0, 40)).slice(0, 20).join("、") : "");
  if (code === "header_mismatch") return `应为：${list(d.expected)}。你的文件是：${list(d.got) || "（空）"}`;
  if (code === "encoding_unrecognized" && typeof d.sample === "string") return `文件开头的内容：${d.sample.slice(0, 80)}`;
  if (code === "too_many_rows" && typeof d.rows === "number") return `你的文件有 ${d.rows} 行数据`;
  if (code === "file_too_large" && typeof d.bytes === "number") return `你的文件有 ${(d.bytes / 1024 / 1024).toFixed(1)} MB`;
  return undefined;
}

/** 活动计划拒绝的补充说明：只取文件级错误的失败项与样本（上传者本人的内容）和名额已满的现任负责人。 */
function planHint(code: string, detail: Record<string, unknown> | undefined): string | undefined {
  if (!detail) return undefined;
  if (code === "owner_slots_full" && Array.isArray(detail.owners)) return `现任负责人：${detail.owners.map((x) => String(x).slice(0, 40)).join("、")}`;
  return hintOf(code, detail);
}

export async function run<T>(fn: (ctx: AuthContext) => Promise<T>): Promise<ActionResult<T>> {
  const s = await currentSession();
  if (!s.ok) {
    return s.kind === "unavailable"
      ? fail("auth_unavailable", "登录服务暂时不可用，请稍后重试")
      : fail("unauthenticated", "登录已过期，请重新登录后再操作");
  }
  try {
    return ok(await fn(s.ctx));
  } catch (e) {
    if (isAccessError(e)) return fail(e.code, BY_CODE[e.code] ?? e.message, hintOf(e.code, e.detail));
    // 同上按名字识别（不用 instanceof）。学习模块的 message 本来就是面向业务的人话；detail 里只有引用数这类计数
    if (e instanceof Error && e.name === "LearningError") {
      const le = e as Error & { code: string; detail?: { referenceCount?: number } };
      return fail(le.code, le.message, typeof le.detail?.referenceCount === "number" ? `共有 ${le.detail.referenceCount} 门课程在使用` : undefined);
    }
    // 活动计划、同步与采集命令（TracerError：capability 未放行、同步设置缺失等）的拒绝：message 本来就是面向业务的人话，code 是稳定码；detail 里的计数 / 名单只在需要时挑几个字段给 hint
    if (e instanceof Error && (e.name === "PlanError" || e.name === "SyncError" || e.name === "TracerError")) {
      const pe = e as Error & { code: string; detail?: Record<string, unknown> };
      return fail(pe.code, pe.message, planHint(pe.code, pe.detail));
    }
    // 只记错误类型与数据库错误码：驱动的错误信息里会带 SQL 参数（手机号等），不进日志
    const cause = (e as { cause?: { code?: string } } | null)?.cause;
    console.error("action_failed", e instanceof Error ? e.name : typeof e, cause?.code ?? "");
    return fail("internal_error", "内部错误，请稍后重试；如果持续出现，请联系管理员");
  }
}

/** 客户端传来的十进制 ID 字符串 → bigint；其他一律当作输入错误。 */
export function idOf(v: unknown, what = "对象"): bigint {
  if (typeof v !== "string" || !/^\d{1,19}$/.test(v)) throw new AccessError("input", "invalid_input", `${what}编号不合法`);
  return BigInt(v);
}
export function idsOf(v: unknown, what: string, max = 200): bigint[] {
  if (!Array.isArray(v) || v.length > max) throw new AccessError("input", "invalid_input", `${what}不合法`);
  return v.map((x) => idOf(x, what));
}
