// 登录 / 激活 / 找回密码 / 修改密码共用的整屏品牌渐变 + 白色大卡（ui-foundation §4「登录」骨架）。
import type { ReactNode } from "react";
import { IcpFooter } from "./icp";

export type AuthKind = "login" | "activate" | "forgot" | "change-password";

const META: Record<AuthKind, { eyebrow: string; title: string; sub: string; h1: [string, string, string]; lead: string; facts: Array<[string, string, string]> }> = {
  login: {
    eyebrow: "登录",
    title: "欢迎回来",
    sub: "使用公司登记的手机号",
    h1: ["一个入口，", "管好账号、内容", "与活动计划。"],
    lead: "账号采集、活动计划、名单与监控在同一条链路上。账号由管理员开通；绑定哪些品牌，就只能看到哪些品牌的数据。",
    facts: [["4", "类", "角色"], ["15", "天", "滑动会话"], ["2", "种", "登录方式"]],
  },
  activate: {
    eyebrow: "激活",
    title: "激活账号",
    sub: "待激活用户设置密码后即可登录",
    h1: ["先激活，", "再进入", "你的工作台。"],
    lead: "激活使用短信验证码，与找回密码共用同一条安全路径。待激活不设有效期；账号由管理员开通。",
    facts: [["邀请", "", "开通方式"], ["5", "分钟", "验证码有效"], ["8", "位", "密码下限"]],
  },
  forgot: {
    eyebrow: "找回密码",
    title: "重置密码",
    sub: "验证手机号后设置新密码",
    h1: ["找回密码，", "继续", "未完成的工作。"],
    lead: "重置成功后解除登录失败锁定，并让该用户的其他会话全部失效。连续 5 次密码失败会锁定 15 分钟。",
    facts: [["5", "分钟", "验证码有效"], ["60", "秒", "重发间隔"], ["1", "次", "重置即解锁"]],
  },
  "change-password": {
    eyebrow: "账户",
    title: "修改密码",
    sub: "改密后其他会话立即失效",
    h1: ["换一个密码，", "其他会话", "立即失效。"],
    lead: "密码由用户自己设置，管理员不能查看或代设。最短 8 位；不强制字符组合、不强制定期改密。",
    facts: [["8", "位", "密码下限"], ["其他", "", "会话失效"], ["不强制", "", "定期改密"]],
  },
};

export function AuthShell({ kind, children }: { kind: AuthKind; children: ReactNode }) {
  const m = META[kind];
  return (
    <main className="auth">
      <div className="auth-grid">
        <section className="auth-hero">
          <div className="auth-logo">
            <div className="auth-logo-mark">H</div>
            <div>
              <div className="auth-logo-name">hbecho 新媒体运营平台</div>
              <div className="auth-logo-sub">HISENSE · HITACHI · YORK</div>
            </div>
          </div>
          <h1 className="auth-h1">
            {m.h1[0]}
            <br />
            <span>{m.h1[1]}</span>
            <br />
            {m.h1[2]}
          </h1>
          <p className="auth-lead">{m.lead}</p>
          <ul className="auth-facts">
            {m.facts.map(([v, unit, k]) => (
              <li key={k} className="auth-fact">
                <strong>{v}</strong>
                <span>{unit}</span>
                <p>{k}</p>
              </li>
            ))}
          </ul>
        </section>
        <section>
          <div className="auth-card">
            <div className="auth-eyebrow">{m.eyebrow}</div>
            <h2 className="auth-title">{m.title}</h2>
            <p className="auth-sub">{m.sub}</p>
            {children}
          </div>
        </section>
      </div>
      <IcpFooter light />
    </main>
  );
}
