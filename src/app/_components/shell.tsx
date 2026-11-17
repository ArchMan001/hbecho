"use client";
// 管理端外壳里需要浏览器状态的几块：当前导航高亮、面包屑、账号菜单（修改密码 / 退出登录）。
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { Dialog } from "./dialog";
import { Icon, type IconName } from "./icon";

export interface NavItem {
  href: string;
  label: string;
  icon: IconName;
  /** 同一入口下的其他路径前缀（例如「活动计划」下的 /batches），在这些页面上也高亮。 */
  also?: string[];
}
export interface NavGroup {
  label: string;
  items: NavItem[];
}

const on = (pathname: string, href: string) => pathname === href || pathname.startsWith(`${href}/`);
const active = (pathname: string, href: string, also: readonly string[] = []) => on(pathname, href) || also.some((a) => on(pathname, a));

export function SidebarNav({ groups }: { groups: NavGroup[] }) {
  const pathname = usePathname();
  return (
    <>
      {groups.map((g) => (
        <nav key={g.label} className="nav-group" aria-label={g.label}>
          <div className="nav-label">{g.label}</div>
          {g.items.map((i) => (
            <Link key={i.href} className={`nav-item ${active(pathname, i.href, i.also) ? "active" : ""}`} href={i.href} aria-current={active(pathname, i.href, i.also) ? "page" : undefined}>
              <Icon name={i.icon} />
              <span>{i.label}</span>
            </Link>
          ))}
        </nav>
      ))}
    </>
  );
}

export function MobileTabs({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  if (items.length === 0) return null;
  return (
    <nav className="mobile-tabs" aria-label="手机导航">
      {items.map((i) => (
        <Link key={i.href} className={`mobile-tab ${active(pathname, i.href, i.also) ? "active" : ""}`} href={i.href}>
          <Icon name={i.icon} />
          <span>{i.label}</span>
        </Link>
      ))}
    </nav>
  );
}

const CRUMBS: Array<[RegExp, string[]]> = [
  [/^\/master-data\/batches\/[^/]+$/, ["主数据", "导入记录", "批次详情"]],
  [/^\/master-data\/batches$/, ["主数据", "导入记录"]],
  [/^\/master-data\/import$/, ["主数据", "导入"]],
  [/^\/master-data$/, ["主数据", "浏览"]],
  [/^\/plans\/new$/, ["活动计划", "新建计划"]],
  [/^\/plans\/trash$/, ["活动计划", "回收站"]],
  [/^\/plans\/[^/]+\/import$/, ["活动计划", "名单导入"]],
  [/^\/plans\/[^/]+$/, ["活动计划", "计划详情"]],
  [/^\/plans$/, ["活动计划"]],
  [/^\/batches\/[^/]+$/, ["活动计划", "导入批次", "批次详情"]],
  [/^\/batches$/, ["活动计划", "导入批次"]],
  [/^\/judgement\/executions\/[^/]+$/, ["判定计划", "执行记录", "执行详情"]],
  [/^\/judgement\/executions$/, ["判定计划", "执行记录"]],
  [/^\/judgement\/results\/[^/]+$/, ["判定计划", "点检表（E）"]],
  [/^\/judgement\/[^/]+\/wizard\/\d$/, ["判定计划", "向导"]],
  [/^\/judgement\/[^/]+$/, ["判定计划", "计划详情"]],
  [/^\/judgement$/, ["判定计划"]],
  [/^\/accounts$/, ["账号与监控"]],
  [/^\/learning\/manage\/new$/, ["学习", "课程管理", "新建课程"]],
  [/^\/learning\/manage\/[^/]+$/, ["学习", "课程管理", "编辑课程"]],
  [/^\/learning\/manage$/, ["学习", "课程管理"]],
  [/^\/learning\/summary$/, ["学习", "学习汇总"]],
  [/^\/learning\/tags$/, ["学习", "标签管理"]],
  [/^\/learning\/[^/]+$/, ["学习", "课程详情"]],
  [/^\/learning$/, ["学习"]],
  [/^\/users\/new$/, ["用户与权限", "新建用户"]],
  [/^\/users\/import$/, ["用户与权限", "批量导入"]],
  [/^\/users\/[^/]+$/, ["用户与权限", "用户详情"]],
  [/^\/users$/, ["用户与权限"]],
  [/^\/audit$/, ["系统", "审计日志"]],
];
export function Crumbs() {
  const pathname = usePathname();
  const trail = CRUMBS.find(([re]) => re.test(pathname))?.[1] ?? ["首页"];
  return (
    <div className="crumbs">
      <span>工作区</span>
      {trail.map((t, i) => (
        <span key={t} style={{ display: "contents" }}>
          <span>/</span>
          <span className={i === trail.length - 1 ? "crumb-current" : ""}>{t}</span>
        </span>
      ))}
    </div>
  );
}

export function AccountMenu({ initial }: { initial: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const logout = async () => {
    setBusy(true);
    try {
      await fetch("/api/auth/sign-out", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    } finally {
      // 即使请求失败也回登录页：页面上的会话由服务端判断，回去后仍未退出会再被带回首页
      router.replace("/login");
      router.refresh();
    }
  };
  return (
    <>
      <button type="button" className="avatar" onClick={() => setOpen(true)} aria-label="账号菜单">
        {initial}
      </button>
      <Dialog open={open} title="账号菜单" onClose={() => setOpen(false)} foot={<button type="button" className="btn" onClick={() => setOpen(false)}>关闭</button>}>
        <div className="list-row">
          <div style={{ flex: 1 }}>
            <div className="cell-main">修改密码</div>
            <div className="cell-sub">其他会话将失效，当前会话保留。</div>
          </div>
          <Link className="btn btn-sm" href="/change-password" onClick={() => setOpen(false)}>
            打开
          </Link>
        </div>
        <div className="list-row">
          <div style={{ flex: 1 }}>
            <div className="cell-main">退出登录</div>
            <div className="cell-sub">只结束当前会话。</div>
          </div>
          <button type="button" className="btn btn-sm" onClick={logout} disabled={busy}>
            <Icon name="logout" /> {busy ? "退出中…" : "退出"}
          </button>
        </div>
      </Dialog>
    </>
  );
}

export function LogoutButton({ className = "btn" }: { className?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className={className}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await fetch("/api/auth/sign-out", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
        } finally {
          router.replace("/login");
          router.refresh();
        }
      }}
    >
      <Icon name="logout" /> 退出登录
    </button>
  );
}
