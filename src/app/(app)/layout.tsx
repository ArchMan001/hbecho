import type { ReactNode } from "react";
import { AccountMenu, Crumbs, MobileTabs, SidebarNav, type NavGroup } from "../_components/shell";
import { EchoMark } from "../_components/echo-mark";
import { BuildStamp, IcpFooter } from "../_components/icp";
import { ROLE_LABEL } from "../_lib/labels";
import { requireUser, web } from "../_lib/session";

// 管理端外壳：左侧浅色侧栏 + 顶栏（ui-foundation §2）。没有对应 Capability 的入口不显示；
// 还没有建好的页面（报表……）也不显示，页面上线时随各自的 spec 加入。
export default async function AppLayout({ children }: { children: ReactNode }) {
  const ctx = await requireUser();
  const profile = await web().profile(ctx);
  const groups: NavGroup[] = [];
  // 活动计划与账号监控（A）：入口按 Capability 显示；页面与动作各自再判断一次
  if (ctx.capabilities.has("activity_plan.create") || ctx.capabilities.has("activity_plan.join")) groups.push({ label: "工作台", items: [{ href: "/plans", label: "活动计划", icon: "calendar", also: ["/batches"] }] });
  // 判定计划（D）：读取 Capability 即有入口；门店专员没有该 Capability，不显示
  if (ctx.capabilities.has("rule.definition.read")) groups.push({ label: "规则", items: [{ href: "/judgement", label: "判定计划", icon: "clipboard" }] });
  const dataItems: NavGroup["items"] = [];
  if (ctx.capabilities.has("data.account.manage")) dataItems.push({ href: "/accounts", label: "账号与监控", icon: "activity" });
  // 活动计划判定结果（e-metrics-lite，刘学奎 2026-11-19）：report.read 四个角色都有，门店专员也有；进入后只看到数据范围内的行
  if (ctx.capabilities.has("report.read")) dataItems.push({ href: "/results", label: "活动计划判定结果", icon: "layers", also: ["/reports"] });
  if (ctx.capabilities.has("data.master_data.import") || ctx.capabilities.has("data.master_data.structure")) dataItems.push({ href: "/master-data", label: "主数据", icon: "database", also: ["/master-data/import", "/master-data/batches"] });
  // 视频广场（F4）：四个角色都有 square.read；与「数据」同组，门店专员也有入口
  if (ctx.capabilities.has("square.read")) dataItems.push({ href: "/square", label: "视频广场", icon: "play" });
  if (dataItems.length) groups.push({ label: "数据", items: dataItems });
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
            <div className="brand-mark"><EchoMark size={22} /></div>
            <div>
              <div className="brand-name">Echo</div>
              <div className="brand-sub">新媒体营销平台</div>
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
          <BuildStamp />
        </div>
      </div>
      <MobileTabs items={groups.flatMap((g) => g.items)} />
    </>
  );
}
