// 登录页原型（2026-11-12）：Echo 品牌语言体系 B 版。
// 左栏：品牌区 → 三段排比 → 定位副题 → 三个业务数字；右栏白卡 + 一行品牌资产脚注。
// 只用于 ui-lab，不进生产构建。

import { echoMark } from "./ui.js";

export function renderLogin() {
  return `
    <main class="auth">
      <div class="auth-grid">
        <section class="auth-hero">
          <div class="auth-logo">
            <span class="auth-logo-mark">${echoMark(52)}</span>
            <div>
              <div class="auth-logo-line"><span class="auth-logo-name">Echo</span><span class="auth-logo-sub">新媒体营销平台</span></div>
              <div class="auth-logo-brands">HISENSE · HITACHI · YORK · KELON</div>
            </div>
          </div>
          <h1 class="auth-h1">内容有标准，<br />发布有回响，<br />增长有数据。</h1>
          <p class="auth-subline">从内容生产到效果度量的一站式智能体，<br />让每个账号，都成为品牌的发声场。</p>
          <ul class="auth-facts">
            <li class="auth-fact"><strong>1,286</strong><span>家</span><p>参与门店</p></li>
            <li class="auth-fact"><strong>24,830</strong><span>条</span><p>发布视频</p></li>
            <li class="auth-fact"><strong>320.4</strong><span>万</span><p>用户互动</p></li>
          </ul>
        </section>
        <section class="auth-panel">
          <div class="auth-card">
            <div class="auth-eyebrow">登录</div>
            <h2 class="auth-title">欢迎回来</h2>
            <p class="auth-sub">使用公司登记的手机号</p>
            <form class="auth-form" data-login-form>
              <div class="field">
                <label for="login-phone">手机号</label>
                <input class="input" id="login-phone" name="phone" type="tel" inputmode="numeric" autocomplete="tel" placeholder="请输入手机号" />
              </div>
              <div class="field">
                <label for="login-password">密码</label>
                <input class="input" id="login-password" name="password" type="password" autocomplete="current-password" placeholder="请输入密码" />
              </div>
              <button class="btn btn-primary auth-submit" type="submit">登录</button>
            </form>
            <p class="auth-help">账号由公司管理员开通。绑定哪些品牌，就只能看到哪些品牌的数据。</p>
          </div>
          <p class="auth-footnote">把分散在账号里的内容，变成可度量、可复用的品牌资产。</p>
        </section>
      </div>
    </main>
  `;
}