import { redirect } from "next/navigation";
import { LogoutButton } from "../_components/shell";
import { EmptyState, PageHead } from "../_components/ui";
import { requireUser } from "../_lib/session";
import Link from "next/link";

// 登录后的落点：有用户管理入口的去用户列表，仅有审计入口的去审计，其余角色（目前是门店专员）看到说明。
export default async function Home() {
  const ctx = await requireUser();
  if (ctx.capabilities.has("user.manage")) redirect("/users");
  if (ctx.capabilities.has("audit.read")) redirect("/audit");
  return (
    <>
      <PageHead title="你好" sub="账号已激活。" />
      <EmptyState
        title="门店端页面还没有开放"
        text="「我的考核」和「学习」随后续版本上线，上线后会出现在这里。现在可以修改密码或退出登录。"
        action={
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center" }}>
            <Link className="btn" href="/change-password">修改密码</Link>
            <LogoutButton />
          </div>
        }
      />
    </>
  );
}
