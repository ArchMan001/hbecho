import { BackLink, Callout, DeniedState, PageHead } from "../../../_components/ui";
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
  // 空目录不能只显示「没有可选项」：总部人员 / 分公司人员的授权校验要求必须选品牌与分公司，没有选项时整类用户都建不出来
  const orgEmpty = org.brands.length === 0 || org.branches.length === 0;
  const scopeEmpty = !orgEmpty && (brands.length === 0 || branches.length === 0);
  return (
    <>
      <BackLink href="/users">返回用户列表</BackLink>
      <PageHead title="新建用户" sub="邀请制：创建后用户自己用短信验证码激活并设置密码；创建时不发短信。" />
      {orgEmpty ? (
        <Callout icon="alert" tone="warn">
          组织主档为空（品牌 {org.brands.length} 个、分公司 {org.branches.length} 个）：总部人员与分公司人员必须先有品牌与分公司才能创建。请超管先完成组织主档引导（运维手册 §10.3），完成后刷新本页；在此之前只能创建超管。
        </Callout>
      ) : scopeEmpty ? (
        <Callout icon="alert" tone="warn">
          你的授权范围里没有可选的组织（品牌 {brands.length} 个、分公司 {branches.length} 个）。请联系超管调整你的授权范围。
        </Callout>
      ) : null}
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
