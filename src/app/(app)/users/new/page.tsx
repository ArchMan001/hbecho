import { BackLink, DeniedState, PageHead } from "../../../_components/ui";
import { NewUserForm } from "../../../_components/user-forms";
import { ROLE_LABEL } from "../../../_lib/labels";
import { requireUser, web } from "../../../_lib/session";
import { allowedRoles, optionsWithin } from "../_scope";

export default async function NewUserPage() {
  const ctx = await requireUser();
  if (!ctx.capabilities.has("user.manage")) return <DeniedState text="当前角色没有「用户管理」权限。" />;
  const org = await web().directory();
  const brands = optionsWithin(org.brands, ctx.scope.brands);
  const branches = optionsWithin(org.branches, ctx.scope.branches);
  return (
    <>
      <BackLink href="/users">返回用户列表</BackLink>
      <PageHead title="新建用户" sub="邀请制：创建后用户自己用短信验证码激活并设置密码；创建时不发短信。" />
      <div className="wizard-layout">
        <NewUserForm
          roles={allowedRoles(ctx.role).map((r) => ({ value: r, label: ROLE_LABEL[r] ?? r }))}
          brands={brands}
          branches={branches}
          // 只有一个可选品牌时直接勾上
          defaultBrandIds={brands.length === 1 ? brands.map((b) => b.id) : []}
        />
        <aside className="wizard-rail" aria-label="授权说明">
          <div className="rail-card">
            <div className="rail-kicker">授权边界</div>
            <div className="rail-title">不能授出超过自己</div>
            <div className="rail-text">只能授予严格低于自己的角色；只有超管可授予超管。品牌与分公司必须完全位于自己的边界内；任一不过整个创建拒绝。</div>
          </div>
          <div className="rail-card">
            <div className="rail-kicker">邀请</div>
            <div className="rail-title">创建时不发短信</div>
            <div className="rail-text">新用户为「待激活」；用户自己到激活入口请求验证码、设置密码。待激活不设有效期。</div>
          </div>
          <div className="rail-card">
            <div className="rail-kicker">身份绑定</div>
            <div className="rail-title">门店专员绑定专员主档</div>
            <div className="rail-text">用「手机号 + 门店编码」定位唯一有效专员；不存在、不在该门店或已停用则创建失败。</div>
          </div>
        </aside>
      </div>
    </>
  );
}
