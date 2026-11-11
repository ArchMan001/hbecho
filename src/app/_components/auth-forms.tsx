"use client";
// 登录、激活、找回密码、修改密码的表单。直接调用 better-auth 的 Route Handler（已有白名单与限流），
// 不另造一层接口；手机号规范化、锁定、短信资格都在服务端的钩子里（AuthFlow）。
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Icon } from "./icon";
import { LogoutButton } from "./shell";
import { useToast } from "./toast";

type PostResult = { ok: true } | { ok: false; code: string; message: string };

// 用户可见的文案；稳定错误码跟在后面（ui-foundation §5）。库的英文 message 不直接给用户看。
const TEXT: Record<string, string> = {
  INVALID_PHONE_NUMBER_OR_PASSWORD: "手机号或密码错误。连续 5 次失败将锁定 15 分钟。",
  INVALID_PHONE_NUMBER: "请输入 11 位大陆手机号。",
  INVALID_OTP: "验证码错误，请核对后重试。",
  OTP_EXPIRED: "验证码已过期，请重新获取。",
  OTP_NOT_FOUND: "验证码已过期或还没获取，请先获取验证码。",
  TOO_MANY_ATTEMPTS: "验证码输错次数过多，已作废，请重新获取。",
  SMS_RATE_LIMITED: "获取验证码太频繁，请稍后再试。",
  SMS_UNAVAILABLE: "暂时无法发送验证码，请稍后再试；已有密码的用户可以用密码登录。",
  SMS_SEND_FAILED: "暂时无法发送验证码，请稍后重试。",
  PASSWORD_TOO_SHORT: "密码至少 8 位。",
  PASSWORD_TOO_LONG: "密码太长。",
  INVALID_PASSWORD: "旧密码不正确。",
};

async function post(path: string, body: Record<string, unknown>): Promise<PostResult> {
  let res: Response;
  try {
    res = await fetch(`/api/auth${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), credentials: "same-origin" });
  } catch {
    return { ok: false, code: "NETWORK_ERROR", message: "网络不通，请检查网络后重试。" };
  }
  if (res.ok) return { ok: true };
  const data = (await res.json().catch(() => null)) as { code?: string } | null;
  const code = data?.code ?? `HTTP_${res.status}`;
  const message = TEXT[code] ?? (res.status === 429 ? "操作太频繁，请稍后再试。" : res.status >= 500 ? "服务暂时不可用，请稍后重试。" : "操作没有成功，请核对输入后重试。");
  return { ok: false, code, message };
}

function Alert({ error, notice }: { error: PostResult | null; notice?: string | undefined }) {
  return (
    <>
      {error && !error.ok ? (
        <div className="auth-error" role="alert">
          <Icon name="alert" />
          <span>
            {error.message}
            <small style={{ display: "block", opacity: 0.75 }}>错误码 {error.code}</small>
          </span>
        </div>
      ) : null}
      {notice ? (
        <div className="auth-notice" role="status">
          <Icon name="check" />
          <span>{notice}</span>
        </div>
      ) : null}
    </>
  );
}

/** 验证码按钮的 60 秒冷却（B-D15：重发间隔 60 秒）。 */
function useCooldown() {
  const [until, setUntil] = useState(0);
  const [, tick] = useState(0);
  useEffect(() => {
    if (until <= Date.now()) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [until]);
  return { remain: Math.max(0, Math.ceil((until - Date.now()) / 1000)), start: () => setUntil(Date.now() + 60_000) };
}

const PhoneField = ({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) => (
  <div className="field">
    <label htmlFor={id}>手机号</label>
    <div className="phone-field">
      <span className="phone-prefix">+86</span>
      <input id={id} name="phone" inputMode="numeric" autoComplete="tel" placeholder="138 0000 0000" value={value} onChange={(e) => onChange(e.target.value)} required />
    </div>
  </div>
);

function CodeField({ id, value, onChange, remain, onSend, sending, hint }: { id: string; value: string; onChange: (v: string) => void; remain: number; onSend: () => void; sending: boolean; hint: string }) {
  return (
    <div className="field">
      <label htmlFor={id}>短信验证码</label>
      <div className="code-row">
        <input className="input" id={id} inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="6 位数字" value={value} onChange={(e) => onChange(e.target.value.replace(/\D/g, ""))} />
        <button type="button" className="btn" onClick={onSend} disabled={remain > 0 || sending}>
          {remain > 0 ? `${remain}s 后重发` : sending ? "发送中…" : "获取验证码"}
        </button>
      </div>
      <span className="hint">{hint}</span>
    </div>
  );
}

export function LoginForm({ notice, scopeError }: { notice?: string | undefined; scopeError: boolean }) {
  const router = useRouter();
  const [mode, setMode] = useState<"code" | "password">("password");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<PostResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const cd = useCooldown();

  const send = async () => {
    setSending(true);
    setError(null);
    const r = await post("/phone-number/send-otp", { phoneNumber: phone });
    setSending(false);
    if (r.ok) {
      cd.start();
      setSent(true);
    } else setError(r);
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = mode === "password" ? await post("/sign-in/phone-number", { phoneNumber: phone, password }) : await post("/phone-number/verify", { phoneNumber: phone, code });
    if (r.ok) {
      router.replace("/");
      router.refresh();
      return; // 保持「登录中」直到页面切换，避免重复提交
    }
    setBusy(false);
    setError(r);
  };
  return (
    <>
      <div className="auth-tabs" role="tablist" aria-label="登录方式">
        {(["password", "code"] as const).map((m) => (
          <button key={m} type="button" className={`auth-tab ${mode === m ? "active" : ""}`} role="tab" aria-selected={mode === m} onClick={() => { setMode(m); setError(null); }}>
            {m === "password" ? "密码" : "验证码"}
          </button>
        ))}
      </div>
      <form className="auth-form" onSubmit={submit}>
        <Alert error={error} notice={scopeError ? "账号暂时无法使用（绑定的专员信息有问题），请联系管理员。" : notice} />
        <PhoneField id="login-phone" value={phone} onChange={setPhone} />
        {mode === "code" ? (
          <CodeField id="login-code" value={code} onChange={setCode} remain={cd.remain} onSend={send} sending={sending} hint={sent ? "验证码已发送，5 分钟内有效。" : "验证码 5 分钟内有效。"} />
        ) : (
          <div className="field">
            <label htmlFor="login-password">密码</label>
            <input className="input" id="login-password" type="password" autoComplete="current-password" placeholder="请输入密码" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </div>
        )}
        <button className="btn btn-primary" type="submit" style={{ marginTop: 2 }} disabled={busy}>
          {busy ? "登录中…" : <>登录 <Icon name="arrowRight" /></>}
        </button>
      </form>
      <div className="auth-link-row">
        <Link href="/activate">首次登录 / 激活账号</Link>
        <Link href="/forgot">忘记密码</Link>
      </div>
      <p className="auth-foot">
        <Icon name="shield" />
        <span>账号由管理员开通；没有注册入口，也没有微信登录。登录后按角色与品牌范围展示数据。</span>
      </p>
    </>
  );
}

/** 激活与找回密码是同一条库内路径（验证码重置密码）：待激活用户重置成功即转为有效。 */
export function ResetForm({ kind }: { kind: "activate" | "forgot" }) {
  const router = useRouter();
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<PostResult | null>(null);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const cd = useCooldown();
  const activate = kind === "activate";

  const send = async () => {
    setSending(true);
    setError(null);
    const r = await post("/phone-number/request-password-reset", { phoneNumber: phone });
    setSending(false);
    if (r.ok) {
      cd.start();
      setSent(true);
    } else setError(r);
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password.length < 8) {
      setError({ ok: false, code: "PASSWORD_TOO_SHORT", message: TEXT.PASSWORD_TOO_SHORT! });
      return;
    }
    setBusy(true);
    setError(null);
    const r = await post("/phone-number/reset-password", { phoneNumber: phone, otp: code, newPassword: password });
    if (r.ok) {
      router.replace(`/login?notice=${activate ? "activated" : "reset"}`);
      return;
    }
    setBusy(false);
    setError(r);
  };
  return (
    <>
      <form className="auth-form" onSubmit={submit}>
        <Alert error={error} notice={sent ? "验证码已发送，5 分钟内有效。如果收不到，请确认手机号是管理员登记的号码。" : undefined} />
        <PhoneField id={`${kind}-phone`} value={phone} onChange={setPhone} />
        <CodeField id={`${kind}-code`} value={code} onChange={setCode} remain={cd.remain} onSend={send} sending={sending} hint="验证码 5 分钟内有效；连续输错 5 次作废。" />
        <div className="field">
          <label htmlFor={`${kind}-password`}>{activate ? "设置密码" : "新密码"}</label>
          <input className="input" id={`${kind}-password`} type="password" autoComplete="new-password" placeholder="至少 8 位" value={password} onChange={(e) => setPassword(e.target.value)} required />
          {activate ? <span className="hint">用户自己设置；管理员不能查看或代设。</span> : null}
        </div>
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? "提交中…" : activate ? "设置密码并激活" : "重置密码"}
        </button>
      </form>
      <div className="auth-link-row">
        <Link href="/login">返回登录</Link>
        <span />
      </div>
      <p className="auth-foot">
        {activate
          ? "待激活用户不设有效期；激活后状态转为「有效」。未开通的手机号收不到验证码，页面不会告诉你号码是否存在。"
          : "重置成功后解除登录失败锁定，并让该用户的其他会话全部失效。管理员不能替用户设置密码。"}
      </p>
    </>
  );
}

export function ChangePasswordForm() {
  const router = useRouter();
  const toast = useToast();
  const [oldPw, setOldPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [error, setError] = useState<PostResult | null>(null);
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.focus(), []);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (newPw.length < 8) {
      setError({ ok: false, code: "PASSWORD_TOO_SHORT", message: TEXT.PASSWORD_TOO_SHORT! });
      return;
    }
    setBusy(true);
    setError(null);
    const r = await post("/change-password", { currentPassword: oldPw, newPassword: newPw });
    setBusy(false);
    if (r.ok) {
      toast("密码已修改，其他会话已失效");
      router.replace("/");
      router.refresh();
    } else setError(r);
  };
  return (
    <>
      <form className="auth-form" onSubmit={submit}>
        <Alert error={error} />
        <div className="field">
          <label htmlFor="change-old">旧密码</label>
          <input ref={first} className="input" id="change-old" type="password" autoComplete="current-password" placeholder="当前密码" value={oldPw} onChange={(e) => setOldPw(e.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor="change-new">新密码</label>
          <input className="input" id="change-new" type="password" autoComplete="new-password" placeholder="至少 8 位" value={newPw} onChange={(e) => setNewPw(e.target.value)} required />
          <span className="hint">修改成功后，该用户的其他会话全部失效；当前会话保留。</span>
        </div>
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? "保存中…" : "保存新密码"}
        </button>
      </form>
      <div className="auth-link-row">
        <Link href="/">返回工作台</Link>
        <LogoutButton className="btn btn-sm btn-ghost" />
      </div>
    </>
  );
}
