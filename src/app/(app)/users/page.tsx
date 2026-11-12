import Link from "next/link";
import { disablePending } from "../../_actions/users";
import { ClickRow } from "../../_components/click-row";
import { ConfirmAction } from "../../_components/dialog";
import { FilterCard } from "../../_components/filter-card";
import { Icon } from "../../_components/icon";
import { DeniedState, EmptyState, PageHead, RoleTag, UserStatusBadge } from "../../_components/ui";
import { DisableButton, RestoreButton } from "../../_components/user-actions";
import { fmtTime, ROLE_LABEL, ROLE_SCOPE } from "../../_lib/labels";
import { pageNumber } from "../../_lib/plan-url";
import { requireUser, web } from "../../_lib/session";

const PAGE_SIZE = 20;
const ROLE_CHIPS: Array<[string, string]> = [["all", "全部角色"], ["hq_manager", "总部人员"], ["branch_manager", "分公司人员"], ["store_staff", "门店专员"]];
const STATUS_CHIPS: Array<[string, string]> = [["all", "全部状态"], ["pending_activation", "待激活"], ["active", "有效"], ["disabled", "停用"]];

type Q = { role?: string | undefined; status?: string | undefined; brand?: string | undefined; branch?: string | undefined; page?: string | undefined };

export default async function UsersPage({ searchParams }: { searchParams: Promise<Q> }) {
  const ctx = await requireUser();
  if (!ctx.capabilities.has("user.manage")) return <DeniedState text="当前角色没有「用户与权限」入口。" />;
  const q = await searchParams;
  const role = q.role && q.role !== "all" ? q.role : undefined;
  const status = q.status && q.status !== "all" ? q.status : undefined;
  const brand = q.brand && /^\d+$/.test(q.brand) ? q.brand : undefined;
  const branch = q.branch && /^\d+$/.test(q.branch) ? q.branch : undefined;

  const w = web();
  const [org, all] = await Promise.all([w.directory(), w.admin.list(ctx)]);
  const placed = brand || branch ? await w.staffPlacements(all) : new Map<string, { brandId: string; branchId: string }>();
  // 筛选条件与计数、分页总数用同一条谓词（ui-foundation §4.1）。门店专员的品牌 / 分公司由所在门店决定
  const inBrand = (u: (typeof all)[number]) => !brand || u.brandIds.includes(brand) || placed.get(u.userId)?.brandId === brand;
  const inBranch = (u: (typeof all)[number]) => !branch || u.branchIds.includes(branch) || placed.get(u.userId)?.branchId === branch;
  const filtered = all.filter((u) => (!role || u.role === role) && (!status || u.status === status) && inBrand(u) && inBranch(u));
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const page = Math.min(pages, pageNumber(q.page));
  const rows = await w.decorateUsers(filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), org);

  const count = (s: string) => all.filter((u) => u.status === s).length;
  const href = (patch: Partial<Q>) => {
    const next: Q = { ...q, page: undefined, ...patch };
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(next)) if (v && v !== "all") sp.set(k, v);
    const s = sp.toString();
    return s ? `/users?${s}` : "/users";
  };
  const chip = (group: keyof Q, value: string, label: string, current: string | undefined) => (
    <Link key={value} className={`chip ${(current ?? "all") === value ? "active" : ""}`} href={href({ [group]: value })} scroll={false}>
      {label}
    </Link>
  );
  // 可选的品牌 / 分公司筛选只列出自己范围内的（范围外的不显示，也不显示计数）
  const visibleBrands = org.brands.filter((b) => ctx.scope.brands === "all" || ctx.scope.brands.has(BigInt(b.id)));
  const visibleBranches = org.branches.filter((b) => ctx.scope.branches === "all" || ctx.scope.branches.has(BigInt(b.id)));
  // 批量停用只在「状态 = 待激活」的筛选下出现，避免在混合列表里误点（design §15.1、B-D04）
  const pendingInFilter = status === "pending_activation" ? filtered.filter((u) => u.manageable) : [];

  return (
    <>
      <PageHead
        title="用户与权限"
        sub="只能授予严格低于自己的角色；用户列表只显示严格下级与自己，同级互不可见、不可操作。"
        actions={
          <>
            <Link className="btn" href="/users/import"><Icon name="upload" /> 批量导入</Link>
            <Link className="btn btn-primary" href="/users/new"><Icon name="plus" /> 新建用户</Link>
          </>
        }
      />
      <section className="summary-band" aria-label="用户概览">
        <div>
          <div className="summary-title">{all.length} 个可见用户 · {count("active")} 个有效</div>
          <div className="summary-sub">当前角色：{ctx.role ? ROLE_LABEL[ctx.role] : ""} · {ctx.role ? ROLE_SCOPE[ctx.role] : ""}</div>
        </div>
        <div className="summary-metrics">
          <div className="summary-metric"><span>{count("active")}</span><small>有效</small></div>
          <div className="summary-metric"><span>{count("pending_activation")}</span><small>待激活</small></div>
          <div className="summary-metric"><span>{count("disabled")}</span><small>停用</small></div>
        </div>
      </section>
      <FilterCard activeCount={[role, status, brand, branch].filter(Boolean).length}>
        <div className="filter-line"><span className="filter-label">角色</span>{ROLE_CHIPS.map(([v, l]) => chip("role", v, l, role))}</div>
        <div className="filter-line"><span className="filter-label">状态</span>{STATUS_CHIPS.map(([v, l]) => chip("status", v, l, status))}</div>
        {visibleBrands.length > 1 ? (
          <div className="filter-line"><span className="filter-label">品牌</span>{chip("brand", "all", "全部品牌", brand)}{visibleBrands.map((b) => chip("brand", b.id, b.name, brand))}</div>
        ) : null}
        {visibleBranches.length > 1 ? (
          <div className="filter-line"><span className="filter-label">分公司</span>{chip("branch", "all", "全部分公司", branch)}{visibleBranches.map((b) => chip("branch", b.id, b.name, branch))}</div>
        ) : null}
      </FilterCard>
      <div className="result-bar">
        <span>共 <strong>{filtered.length}</strong> 个用户</span>
        {pendingInFilter.length > 0 ? (
          <ConfirmAction
            label={`停用这 ${pendingInFilter.length} 个待激活用户`}
            buttonClass="btn btn-sm"
            title="批量停用待激活用户"
            confirmLabel={`停用 ${pendingInFilter.length} 个用户`}
            danger
            action={disablePending.bind(null, pendingInFilter.map((u) => u.userId))}
            doneMessage="已提交批量停用"
          >
            <p className="hint">将停用当前筛选结果里 <strong>{pendingInFilter.length}</strong> 个仍是「待激活」的用户。每个用户单独授权、单独记审计；已变化或不在你管理范围内的会被跳过，不影响其他用户。</p>
            <p className="hint" style={{ marginTop: 10 }}>待激活用户还没有登录过，停用不影响任何会话。</p>
          </ConfirmAction>
        ) : null}
      </div>
      {filtered.length === 0 ? (
        all.length === 0 ? (
          <EmptyState title="还没有下级用户" text="新建一个用户，对方用短信验证码激活后即可登录。" action={<Link className="btn btn-primary" href="/users/new">新建用户</Link>} />
        ) : (
          <EmptyState title="没有符合条件的用户" text="换一个角色、状态、品牌或分公司试试；同级用户不会出现在列表里。" action={<Link className="btn" href="/users">清空筛选</Link>} />
        )
      ) : (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>用户</th><th>品牌 / 分公司</th><th>状态</th><th className="right">待激活</th><th>最后登录</th><th className="right">操作</th></tr>
              </thead>
              <tbody>
                {rows.map((u) => (
                  <ClickRow key={u.userId} href={`/users/${u.userId}`}>
                    <td>
                      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                        <span className="avatar" style={{ width: 30, height: 30, flexBasis: 30, fontSize: 11 }}>{u.name.slice(0, 1)}</span>
                        <div>
                          <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                            <Link className="cell-main" href={`/users/${u.userId}`}>{u.name}</Link>
                            <RoleTag role={u.role} />
                          </div>
                          <div className="cell-sub">{u.phone}</div>
                        </div>
                      </div>
                    </td>
                    <td className="nowrap">
                      <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                        {u.brandNames.length ? u.brandNames.map((b) => <span key={b} className="tag">{b}</span>) : "—"}
                      </div>
                      <div className="cell-sub">{u.storeLabel ?? (u.branchNames.length ? u.branchNames.join("、") : u.role === "platform_admin" || u.role === "hq_manager" ? "全部分公司" : "—")}</div>
                    </td>
                    <td className="nowrap">
                      <UserStatusBadge status={u.status} />
                      {u.disabledReason === "manual" ? <div className="cell-sub">人工停用</div> : u.disabledReason === "media_staff_disabled" ? <div className="cell-sub">专员停用联动</div> : null}
                    </td>
                    <td className="right num">{u.pendingDays !== null ? `${u.pendingDays} 天` : "—"}</td>
                    <td className="num nowrap">{fmtTime(u.lastLoginAt)}</td>
                    <td className="right nowrap">
                      <Link className="btn btn-sm" href={`/users/${u.userId}`}>查看</Link>{" "}
                      {u.manageable ? (u.status === "disabled" ? <RestoreButton id={u.userId} name={u.name} /> : <DisableButton id={u.userId} name={u.name} />) : null}
                    </td>
                  </ClickRow>
                ))}
              </tbody>
            </table>
          </div>
          {pages > 1 ? (
            <div className="result-bar" style={{ marginTop: 12 }}>
              <span>第 <strong>{page}</strong> / {pages} 页</span>
              <span style={{ display: "flex", gap: 8 }}>
                {page > 1 ? <Link className="btn btn-sm" href={href({ page: String(page - 1) })}>上一页</Link> : <button type="button" className="btn btn-sm" disabled>上一页</button>}
                {page < pages ? <Link className="btn btn-sm" href={href({ page: String(page + 1) })}>下一页</Link> : <button type="button" className="btn btn-sm" disabled>下一页</button>}
              </span>
            </div>
          ) : null}
        </>
      )}
    </>
  );
}
