import { EditUserForm } from "../../../_components/user-forms";
import { BackLink, Callout, DeniedState, PageHead, RoleTag, UserStatusBadge } from "../../../_components/ui";
import { DisableButton, ForceLogoutButton, RestoreButton } from "../../../_components/user-actions";
import { fmtTime, ROLE_LABEL } from "../../../_lib/labels";
import { isAccessError } from "../../../_lib/action";
import { requireUser, web } from "../../../_lib/session";
import { AccessError } from "../../../../modules/access-control";
import { allowedRoles, optionsWithin } from "../_scope";

export default async function UserDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireUser();
  if (!ctx.capabilities.has("user.manage")) return <DeniedState text="当前角色没有「用户管理」权限。" />;
  const { id } = await params;
  const w = web();
  let view;
  try {
    if (!/^\d{1,19}$/.test(id)) throw new AccessError("not_found", "user_not_found", "");
    view = await w.admin.get(ctx, BigInt(id));
  } catch (e) {
    // 同级与上级用户对外表现为「未找到」（design §15.4）
    if (isAccessError(e) && (e.category === "not_found" || e.category === "authorization")) return <DeniedState text="用户不存在，或不在你的管理范围内。" home="/users" />;
    throw e;
  }
  const org = await w.directory();
  const [u] = await w.decorateUsers([view], org);
  if (!u) return <DeniedState text="用户不存在，或不在你的管理范围内。" home="/users" />;

  // 超管不能停用自己；自己、同级与上级只读（manageable 由 Module 判定）
  const editable = u.manageable;
  const roles = allowedRoles(ctx.role).map((r) => ({ value: r, label: ROLE_LABEL[r] ?? r }));
  const sub = `${u.phone} · 创建者 ${u.createdBy} · 最后登录 ${fmtTime(u.lastLoginAt)}`;
  return (
    <>
      <BackLink href="/users">返回用户列表</BackLink>
      <div className="page-head">
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
            <h1 className="page-title">{u.name}</h1>
            <RoleTag role={u.role} />
            <UserStatusBadge status={u.status} />
          </div>
          <p className="page-sub">{sub}</p>
        </div>
        {editable ? (
          <div className="page-actions">
            {u.status !== "disabled" ? <ForceLogoutButton id={u.userId} name={u.name} /> : null}
            {u.status === "disabled" ? <RestoreButton id={u.userId} name={u.name} header /> : <DisableButton id={u.userId} name={u.name} header />}
          </div>
        ) : null}
      </div>
      {!editable ? <Callout icon="shield" style={{ marginBottom: 14 }}>这是你自己的账号，只读。需要改动请联系上级管理员。</Callout> : null}
      {u.status === "disabled" ? (
        <Callout icon="lock" tone="warn" style={{ marginBottom: 14 }}>
          已停用（{u.disabledReason === "media_staff_disabled" ? "专员停用联动" : "人工停用"}）。现有会话已失效；原手机号不再占用。
        </Callout>
      ) : null}
      {u.status === "pending_activation" ? (
        <Callout icon="clock" tone="warn" style={{ marginBottom: 14 }}>
          待激活 {u.pendingDays ?? 0} 天。待激活不设有效期；可以直接修改手机号，激活后改号只能停用后重新建号。
        </Callout>
      ) : null}
      <div className="wizard-layout">
        <EditUserForm
          u={{ userId: u.userId, name: u.name, role: u.role, phone: u.phone, status: u.status, brandIds: u.brandIds, branchIds: u.branchIds, storeLabel: u.storeLabel, storeBrandNames: u.brandNames }}
          roles={roles}
          brands={optionsWithin(org.brands, ctx.scope.brands)}
          branches={optionsWithin(org.branches, ctx.scope.branches)}
          editable={editable}
        />
        <aside className="wizard-rail" aria-label="权限与会话">
          <div className="rail-card">
            <div className="rail-kicker">权限边界</div>
            <div className="rail-title">严格下级 / 读写同源</div>
            <div className="rail-text">列表、详情、修改、停用、恢复、强制下线使用同一条范围判断；看不到的用户也不能改。同级与上级用户对外表现为「未找到」。</div>
          </div>
          <div className="rail-card">
            <div className="rail-kicker">会话</div>
            <div className="rail-title">角色变更不撤销会话</div>
            <div className="rail-text">下一次请求按新权限判断；强制下线撤销全部会话；对方重置密码会让其他会话全部失效。</div>
          </div>
          <div className="rail-card">
            <div className="rail-kicker">关联</div>
            <div className="rail-title">门店专员绑定专员主档</div>
            <div className="rail-text">专员停用后，关联用户自动停用；专员恢复时只恢复因该专员停用的用户，人工停用的不恢复。</div>
          </div>
        </aside>
      </div>
    </>
  );
}
