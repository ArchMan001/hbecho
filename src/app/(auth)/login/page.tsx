import { redirect } from "next/navigation";
import { AuthShell } from "../../_components/auth-shell";
import { LoginForm } from "../../_components/auth-forms";
import { currentSession } from "../../_lib/session";

const NOTICE: Record<string, string> = {
  activated: "账号已激活，请使用手机号和刚设置的密码登录。",
  reset: "密码已重置；其他会话已失效，登录失败锁定已解除。",
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ notice?: string; e?: string }> }) {
  const q = await searchParams;
  // requireUser 以 e=scope 送回登录页时，即使会话仍可认证，也不能再回跳 /：
  // 否则会在 / 与 /login 之间形成刷新循环（门店专员绑定失效等范围无法解释的场景）。
  const session = await currentSession();
  if (session.ok && q.e !== "scope") redirect("/");
  return (
    <AuthShell kind="login">
      <LoginForm notice={q.notice ? NOTICE[q.notice] : undefined} scopeError={q.e === "scope"} />
    </AuthShell>
  );
}
