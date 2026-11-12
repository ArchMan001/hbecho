// 页面共用的纯展示组件（服务端与客户端都能用）。样式类名来自已确认的原型 CSS。
import Link from "next/link";
import type { ReactNode } from "react";
import { ROLE_LABEL, USER_STATUS } from "../_lib/labels";
import { Icon, type IconName } from "./icon";

export type Tone = "green" | "red" | "amber" | "gray" | "blue" | "plain";

export const Badge = ({ tone = "plain", children }: { tone?: Tone; children: ReactNode }) => <span className={`badge ${tone}`}>{children}</span>;

export const UserStatusBadge = ({ status }: { status: string }) => {
  const s = USER_STATUS[status] ?? { label: status, tone: "gray" as const };
  return <Badge tone={s.tone}>{s.label}</Badge>;
};

/** 角色用中性描边标签；绿 / 琥珀 / 灰只表示状态（ui-foundation §6.4）。 */
export const RoleTag = ({ role }: { role: string }) => <span className="tag role-tag">{ROLE_LABEL[role] ?? role}</span>;

export const BackLink = ({ href, children }: { href: string; children: ReactNode }) => (
  <Link className="back-link" href={href}>
    <Icon name="arrowLeft" /> {children}
  </Link>
);

export const PageHead = ({ title, sub, actions }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode }) => (
  <div className="page-head">
    <div>
      <h1 className="page-title">{title}</h1>
      {sub ? <p className="page-sub">{sub}</p> : null}
    </div>
    {actions ? <div className="page-actions">{actions}</div> : null}
  </div>
);

export const Callout = ({ icon, tone, children, style }: { icon: IconName; tone?: "warn" | "danger" | undefined; children: ReactNode; style?: React.CSSProperties }) => (
  <div className={`callout ${tone ?? ""}`.trim()} {...(style ? { style } : {})}>
    <Icon name={icon} />
    <span>{children}</span>
  </div>
);

interface StateProps {
  icon: IconName;
  title: string;
  text: string;
  action?: ReactNode;
}
const StateCard = ({ icon, title, text, action }: StateProps) => (
  <div className="card">
    <div className="state">
      <div className="state-icon">
        <Icon name={icon} />
      </div>
      <div className="state-title">{title}</div>
      <p className="state-text">{text}</p>
      {action}
    </div>
  </div>
);

export const EmptyState = ({ title = "暂无数据", text, action }: { title?: string; text: string; action?: ReactNode }) => (
  <StateCard icon="file" title={title} text={text} {...(action ? { action } : {})} />
);

/** 直接访问 URL 也显示这个，不显示空列表、不显示计数（ui-foundation §5）。 */
export const DeniedState = ({ text = "当前角色没有这个页面的访问权限，或对象不在你的数据范围内。请联系上级管理员开通。", home = "/" }: { text?: string; home?: string }) => (
  <StateCard
    icon="shield"
    title="无权访问"
    text={text}
    action={
      <Link className="btn" href={home}>
        回到首页
      </Link>
    }
  />
);

export const ErrorState = ({ code, onRetry }: { code?: string | undefined; onRetry?: (() => void) | undefined }) => (
  <StateCard
    icon="alert"
    title="加载失败"
    text={`请求没有完成，请重试；如果持续失败，请把错误码交给管理员。${code ? `（错误码 ${code}）` : ""}`}
    action={
      onRetry ? (
        <button type="button" className="btn" onClick={onRetry}>
          <Icon name="refresh" /> 重试
        </button>
      ) : undefined
    }
  />
);

/** 骨架屏：保留列表结构，不用全屏遮罩（ui-foundation §5）。固定宽度，避免服务端与客户端渲染不一致。 */
export function ListSkeleton({ rows = 6 }: { rows?: number }) {
  const widths = [88, 72, 80, 66, 84, 70, 76, 62];
  return (
    <div className="card card-pad" aria-busy="true" aria-label="加载中">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skeleton skeleton-line" style={{ width: `${widths[i % widths.length]}%` }} />
      ))}
      <div className="skeleton skeleton-block" style={{ marginTop: 14 }} />
    </div>
  );
}
