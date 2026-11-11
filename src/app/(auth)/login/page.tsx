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
  if ((await currentSession()).ok) redirect("/");
  return (
    <AuthShell kind="login">
      <LoginForm notice={q.notice ? NOTICE[q.notice] : undefined} scopeError={q.e === "scope"} />
    </AuthShell>
  );
}
