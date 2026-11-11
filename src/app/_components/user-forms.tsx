"use client";
// 新建用户 / 编辑用户的表单。字段按角色显示（超管不填范围；总部只填品牌；分公司人员填品牌 + 分公司；门店专员只填门店编码），
// 授权边界（只能授予严格低于自己的角色、范围不超出自己）以服务端 Module 的判断为准，这里只做展示与预填。
import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent, type ReactNode } from "react";
import { inviteUser, previewInvite, saveUser, type InviteForm } from "../_actions/users";
import { ROLE_LABEL } from "../_lib/labels";
import type { ActionResult } from "../_lib/result";
import { Icon } from "./icon";
import { useToast } from "./toast";

export interface RoleOption { value: string; label: string }
export interface OrgOption { id: string; name: string }

function Chips({ name, options, value, onChange, disabled }: { name: string; options: OrgOption[]; value: string[]; onChange: (v: string[]) => void; disabled?: boolean }) {
  if (options.length === 0) return <span className="hint">没有可选项</span>;
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {options.map((o) => (
        <label key={o.id} className={`chip ${value.includes(o.id) ? "active" : ""}`}>
          <input
            type="checkbox"
            name={name}
            checked={value.includes(o.id)}
            disabled={disabled}
            onChange={(e) => onChange(e.target.checked ? [...value, o.id] : value.filter((x) => x !== o.id))}
            style={{ accentColor: "#0FA3A8" }}
          />{" "}
          {o.name}
        </label>
      ))}
    </div>
  );
}

const F = ({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) => (
  <div className="field"><label>{label}</label>{children}{hint ? <span className="hint">{hint}</span> : null}</div>
);
const needsBrand = (role: string) => role === "hq_manager" || role === "branch_manager";
const needsBranch = (role: string) => role === "branch_manager";

function ErrorLine({ e }: { e: { code: string; message: string } | null }) {
  return e ? (
    <div className="callout danger" role="alert" style={{ marginTop: 14 }}>
      <Icon name="alert" />
      <span>{e.message}（错误码 {e.code}）</span>
    </div>
  ) : null;
}

export function NewUserForm({ roles, brands, branches, defaultBrandIds }: { roles: RoleOption[]; brands: OrgOption[]; branches: OrgOption[]; defaultBrandIds: string[] }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [f, setF] = useState<InviteForm>({ name: "", role: "", phone: "", brandIds: defaultBrandIds, branchIds: [], storeCode: "" });
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const set = <K extends keyof InviteForm>(k: K, v: InviteForm[K]) => { setF((p) => ({ ...p, [k]: v })); setNote(null); };
  const payload = (): InviteForm => ({
    ...f,
    brandIds: needsBrand(f.role) ? f.brandIds : [],
    branchIds: needsBranch(f.role) ? f.branchIds : [],
    storeCode: f.role === "store_staff" ? f.storeCode : "",
  });
  const call = (fn: () => Promise<ActionResult<unknown>>, done: (r: ActionResult<unknown>) => void) =>
    start(async () => {
      setError(null);
      let r: ActionResult<unknown>;
      try { r = await fn(); } catch { r = { ok: false, code: "network_error", message: "请求没有完成，请检查网络后重试" }; }
      if (!r.ok) setError({ code: r.code, message: r.message });
      else done(r);
    });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    call(() => inviteUser(payload()), () => { toast("用户已创建，对方可到登录页「首次登录 / 激活账号」设置密码"); router.push("/users"); });
  };
  const check = () =>
    call(() => previewInvite(payload()), (r) => {
      const d = (r as { ok: true; data: { phoneExists: boolean; staffFound: boolean } }).data;
      setNote(d.phoneExists ? "核对通过，但这个手机号已是待激活或有效用户，创建会失败。" : f.role === "store_staff" ? "核对通过：已找到该手机号在这个门店下的有效专员。" : "核对通过，可以创建。");
    });
  return (
    <form className="card card-pad wizard-main" onSubmit={submit}>
      <div className="form-grid">
        <div className="field">
          <label htmlFor="nu-name">姓名 *</label>
          <input className="input" id="nu-name" maxLength={100} placeholder="例如：张三" value={f.name} onChange={(e) => set("name", e.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor="nu-role">角色 *</label>
          <select className="select" id="nu-role" value={f.role} onChange={(e) => set("role", e.target.value)} required>
            <option value="">请选择角色</option>
            {roles.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
          <span className="hint">只能授予严格低于自己的角色；超管可授予超管。</span>
        </div>
        <div className="field">
          <label htmlFor="nu-phone">手机号 *</label>
          <input className="input" id="nu-phone" inputMode="numeric" placeholder="11 位大陆手机号" value={f.phone} onChange={(e) => set("phone", e.target.value)} required />
          <span className="hint">登录手机号；停用后保留原号记录但不占号。</span>
        </div>
        {needsBrand(f.role) ? (
          <div className="field">
            <label>品牌 *</label>
            <Chips name="brand" options={brands} value={f.brandIds} onChange={(v) => set("brandIds", v)} />
            <span className="hint">只能选你自己授权范围内的品牌。</span>
          </div>
        ) : null}
        {needsBranch(f.role) ? (
          <div className="field">
            <label>分公司 *</label>
            <Chips name="branch" options={branches} value={f.branchIds} onChange={(v) => set("branchIds", v)} />
            <span className="hint">只能选你自己授权范围内的分公司。</span>
          </div>
        ) : null}
        {f.role === "store_staff" ? (
          <div className="field">
            <label htmlFor="nu-store">门店编码 *</label>
            <input className="input" id="nu-store" placeholder="例如：BJ-HIT-001" value={f.storeCode} onChange={(e) => set("storeCode", e.target.value)} required />
            <span className="hint">用「手机号 + 门店编码」定位唯一有效专员；不存在或不在该门店则创建失败。品牌和分公司由门店决定，不用填。</span>
          </div>
        ) : null}
        {f.role === "platform_admin" || f.role === "hq_manager" ? (
          <div className="field span-2"><span className="hint">{f.role === "platform_admin" ? "平台超管不限品牌和分公司。" : "总部人员的分公司范围是「全部」。"}</span></div>
        ) : null}
        <div className="field span-2">
          <div className="callout">
            <Icon name="shield" />
            <span>创建前会做授权边界双校验：你能否管理目标；拟授予的角色、品牌与分公司是否完全在你自己的边界内。任一不过，整个创建被拒绝。</span>
          </div>
        </div>
      </div>
      {note ? <div className="callout" style={{ marginTop: 14 }}><Icon name="check" /><span>{note}</span></div> : null}
      <ErrorLine e={error} />
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
        <button type="button" className="btn" onClick={() => router.push("/users")} disabled={pending}>取消</button>
        <button type="button" className="btn" onClick={check} disabled={pending || !f.role || !f.phone}>核对</button>
        <button className="btn btn-primary" type="submit" disabled={pending}><Icon name="check" /> {pending ? "处理中…" : "创建并邀请"}</button>
      </div>
    </form>
  );
}

export interface EditUser {
  userId: string;
  name: string;
  role: string;
  phone: string;
  status: string;
  brandIds: string[];
  branchIds: string[];
  storeLabel: string | null;
  storeBrandNames: string[];
}

export function EditUserForm({ u, roles, brands, branches, editable }: { u: EditUser; roles: RoleOption[]; brands: OrgOption[]; branches: OrgOption[]; editable: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [name, setName] = useState(u.name);
  const [role, setRole] = useState(u.role);
  const [phone, setPhone] = useState(u.phone);
  const [brandIds, setBrandIds] = useState(u.brandIds);
  const [branchIds, setBranchIds] = useState(u.branchIds);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const isStaff = u.role === "store_staff";
  const pendingActivation = u.status === "pending_activation";
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
  const canEdit = editable && u.status !== "disabled";

  const submit = (e: FormEvent) => {
    e.preventDefault();
    // 只提交改动过的字段：只改姓名时不重跑授权边界校验，也不重写品牌 / 分公司集合
    const accessChanged = !isStaff && (role !== u.role || !same(brandIds, u.brandIds) || !same(branchIds, u.branchIds));
    const body = {
      ...(name.trim() !== u.name ? { displayName: name } : {}),
      ...(accessChanged ? { role, brandIds: needsBrand(role) ? brandIds : [], branchIds: needsBranch(role) ? branchIds : [] } : {}),
      ...(pendingActivation && phone.trim() !== u.phone ? { phone } : {}),
    };
    if (Object.keys(body).length === 0) { toast("没有需要保存的改动"); return; }
    start(async () => {
      setError(null);
      let r: Awaited<ReturnType<typeof saveUser>>;
      try { r = await saveUser(u.userId, body); } catch { r = { ok: false, code: "network_error", message: "请求没有完成，请检查网络后重试" }; }
      if (!r.ok) { setError({ code: r.code, message: r.message }); return; }
      toast("已保存；角色和范围的变更下一次请求起生效，不会让对方重新登录");
      router.refresh();
    });
  };

  const roleChoices: RoleOption[] = roles.some((r) => r.value === u.role) ? roles : [{ value: u.role, label: ROLE_LABEL[u.role] ?? u.role }, ...roles];
  return (
    <form className="card card-pad wizard-main" onSubmit={submit}>
      <div className="form-grid">
        <div className="field">
          <label htmlFor="ud-name">姓名</label>
          <input className="input" id="ud-name" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} disabled={!canEdit} />
        </div>
        <div className="field">
          <label htmlFor="ud-role">角色</label>
          <select className="select" id="ud-role" value={role} onChange={(e) => setRole(e.target.value)} disabled={!canEdit || isStaff}>
            {roleChoices.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
          <span className="hint">{isStaff ? "门店专员的角色不能原地修改。" : "角色变更不撤销现有会话；下一次请求按新权限判断。"}</span>
        </div>
        <div className="field">
          <label htmlFor="ud-phone">手机号</label>
          <input className="input" id="ud-phone" value={phone} onChange={(e) => setPhone(e.target.value)} disabled={!canEdit || !pendingActivation} />
          <span className="hint">{pendingActivation ? "待激活期内可直接修改。" : "已激活用户不能直接改号；换号请停用后用新手机号重新建号。"}</span>
        </div>
        {isStaff ? (
          <F label="门店" hint="门店与品牌不能原地修改；换店请停用后重新建号。">
            <input className="input" value={u.storeLabel ?? "—"} disabled readOnly />
          </F>
        ) : null}
        {!isStaff && needsBrand(role) ? (
          <F label="品牌"><Chips name="brand" options={brands} value={brandIds} onChange={setBrandIds} disabled={!canEdit} /></F>
        ) : null}
        {!isStaff && needsBranch(role) ? (
          <F label="分公司"><Chips name="branch" options={branches} value={branchIds} onChange={setBranchIds} disabled={!canEdit} /></F>
        ) : null}
        {isStaff ? (
          <F label="品牌"><div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>{u.storeBrandNames.map((b) => <span key={b} className="tag">{b}</span>)}</div></F>
        ) : null}
      </div>
      <div className="callout" style={{ marginTop: 16 }}>
        <Icon name="shield" />
        <span>列表、详情、修改、停用、恢复、强制下线使用同一条范围判断；看不到的用户也不能改。</span>
      </div>
      <ErrorLine e={error} />
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
        <button type="button" className="btn" onClick={() => router.push("/users")} disabled={pending}>返回</button>
        <button className="btn btn-primary" type="submit" disabled={!canEdit || pending}>{pending ? "保存中…" : "保存"}</button>
      </div>
    </form>
  );
}
