// 页面与服务端动作共用的会话入口（Next 官方推荐的 DAL 形态）：每次请求现认证一次，同一次渲染内用 cache 复用。
// 菜单隐藏 ≠ 无权限（ui-foundation §2）：每个页面、每个动作自己取 AuthContext，再由 Module 做 Capability 与范围判断。
import { cache } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAccessRuntime } from "../../modules/access-control/runtime";
import type { AuthContext } from "../../modules/access-control/authorize";
import type { AuthenticateResult } from "../../modules/access-control/authenticate";

export const web = () => getAccessRuntime().web;

export const currentSession = cache(async (): Promise<AuthenticateResult> => web().authenticate(await headers()));

/**
 * 页面用：未登录跳登录页；认证库不可用抛错（由 error.tsx 显示，不当作「未登录」）。
 * 带会话但范围无法解释（例如门店专员的专员绑定失效）时回登录页并说明，不显示空页面。
 */
export async function requireUser(): Promise<AuthContext> {
  const r = await currentSession();
  if (r.ok) return r.ctx;
  if (r.kind === "unavailable") throw new Error("auth_unavailable");
  redirect(r.kind === "forbidden" ? "/login?e=scope" : "/login");
}
