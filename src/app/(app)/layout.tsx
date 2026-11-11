import type { ReactNode } from "react";
import { AccountMenu, Crumbs, MobileTabs, SidebarNav, type NavGroup } from "../_components/shell";
import { IcpFooter } from "../_components/icp";
import { ROLE_LABEL } from "../_lib/labels";
import { requireUser, web } from "../_lib/session";

// 管理端外壳：左侧浅色侧栏 + 顶栏（ui-foundation §2）。没有对应 Capability 的入口不显示；
// 还没有建好的页面（活动计划、判定计划、报表……）也不显示，页面上线时随各自的 spec 加入。
export default async function AppLayout({ children }: { children: ReactNode }) {
  const ctx = await requireUser();
  const profile = await web().profile(ctx);
  const groups: NavGroup[] = [];
  // 「学习」排在管理之前（ui-foundation §2）；按 Capability 裁剪，页面与动作各自再判断一次
  if (ctx.capabilities.has("learning.read")) groups.push({ label: "学习", items: [{ href: "/learning", label: "学习", icon: "book" }] });
  if (ctx.capabilities.has("user.manage")) groups.push({ label: "管理", items: [{ href: "/users", label: "用户与权限", icon: "users" }] });
  if (ctx.capabilities.has("audit.read")) groups.push({ label: "系统", items: [{ href: "/audit", label: "审计日志", icon: "settings" }] });
  const scopeLabel = profile.brandNames === "all" ? "全部品牌" : profile.brandNames.join("、") || "本人";
  const initial = profile.name.slice(0, 1) || "?";
  return (
    <>
      <div className="shell">
        <aside className="sidebar" aria-label="主导航">
          <div className="brand-block">
            <div className="brand-mark">H</div>
            <div>
              <div className="brand-name">hbecho</div>
              <div className="brand-sub">新媒体运营平台</div>
            </div>
          </div>
          <SidebarNav groups={groups} />
          <div className="sidebar-foot">
            <div className="scope-box">
              <div className="scope-label">可检索品牌</div>
              <div className="scope-value">
                <span className="dot" />
                {scopeLabel}
              </div>
            </div>
            <div className="user-card">
              <div className="avatar">{initial}</div>
              <div>
                <div className="user-name">{profile.name}</div>
                <div className="user-role">{ctx.role ? ROLE_LABEL[ctx.role] : ""}</div>
              </div>
            </div>
          </div>
        </aside>
        <div className="main">
          <header className="topbar">
            <Crumbs />
            <div className="top-actions" style={{ marginLeft: "auto" }}>
              <span className="brand-pill">
                <span className="dot" />
                {scopeLabel}
              </span>
              <AccountMenu initial={initial} />
            </div>
          </header>
          <main className="page">{children}</main>
          <IcpFooter />
        </div>
      </div>
      <MobileTabs items={groups.flatMap((g) => g.items)} />
    </>
  );
}
