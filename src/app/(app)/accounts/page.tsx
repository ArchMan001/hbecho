import Link from "next/link";
import { ClickRow } from "../../_components/click-row";
import { FilterCard } from "../../_components/filter-card";
import { AccountPanel } from "../../_components/plans/account-panel";
import { Pager } from "../../_components/plans/pager";
import { Badge, DeniedState, EmptyState, PageHead } from "../../_components/ui";
import { PLAN_PLATFORMS } from "../../../modules/activity-plan/constants";
import { ACCOUNT_STATUS_TONE, bjt, n, PLATFORM_LABEL } from "../../_lib/plan-labels";
import { hrefWith, pageOf, PAGE_SIZE } from "../../_lib/plan-page";
import { ap, canSetOrgSwitches, planActorOf } from "../../_lib/plan";
import { requireUser } from "../../_lib/session";

type Q = { status?: string | undefined; platform?: string | undefined; account?: string | undefined; page?: string | undefined };
const STATUS_CHIPS: Array<[string, string]> = [["all", "全部"], ["normal", "正常采集"], ["suspected_empty", "疑似空账号"], ["monitoring_stopped", "被停止监控"], ["upstream_closed", "上级被关闭"], ["removed_from_plan", "已移出活动计划"]];

export default async function AccountsPage({ searchParams }: { searchParams: Promise<Q> }) {
  const ctx = await requireUser();
  if (!ctx.capabilities.has("data.account.manage")) return <DeniedState text="当前角色没有「账号与监控」入口。" />;
  const q = await searchParams;
  const actor = await planActorOf(ctx);
  const status = STATUS_CHIPS.some(([v]) => v === q.status) && q.status !== "all" ? q.status : undefined;
  const platform = (PLAN_PLATFORMS as readonly string[]).includes(q.platform ?? "") ? q.platform : undefined;

  const wanted = Math.max(1, Number(q.page) || 1);
  const fetchPage = (pg: number) => ap().accounts.list(actor, { ...(status ? { status } : {}), ...(platform ? { platform } : {}), offset: (pg - 1) * PAGE_SIZE, limit: PAGE_SIZE });
  let res = await fetchPage(wanted);
  const { page, pages } = pageOf(q.page, res.total);
  if (page !== wanted) res = await fetchPage(page);

  const href = (patch: Partial<Q>) => hrefWith("/accounts", q, { page: undefined, ...patch });
  const chip = (group: "status" | "platform", value: string, label: string, current: string | undefined) => (
    <Link key={value} className={`chip ${(current ?? "all") === value ? "active" : ""}`} href={href({ [group]: value, account: undefined })} scroll={false}>
      {label}
    </Link>
  );

  // 选中的账号：URL 里的 account（必须在当前范围内），否则当前页第一行；越范围的编号按「没有选中」处理
  const wantedId = q.account && /^[1-9]\d{0,18}$/.test(q.account) ? q.account : undefined;
  const pick = res.items.find((a) => a.accountId === wantedId) ?? res.items[0];
  const detail = pick ? await ap().accounts.detail(actor, BigInt(pick.accountId)) : null;

  const c = res.counts;
  return (
    <>
      <PageHead title="账号与监控" sub="账号的监控状态是全局的；名单是分计划的。综合状态按优先级取第一条命中。" />
      <section className="summary-band" aria-label="账号概览">
        <div>
          <div className="summary-title">{n(res.scopeTotal)} 个账号 · {n(c.normal ?? 0)} 个正常采集</div>
          <div className="summary-sub">综合状态取第一条命中；实际监控 = 账号开关 ∧ 上级链有效 ∧ 录入状态正常。</div>
        </div>
        <div className="summary-metrics">
          <div className="summary-metric"><span>{n(c.normal ?? 0)}</span><small>正常采集</small></div>
          <div className="summary-metric"><span>{n(c.suspected_empty ?? 0)}</span><small>疑似空账号</small></div>
          <div className="summary-metric"><span>{n((c.monitoring_stopped ?? 0) + (c.upstream_closed ?? 0))}</span><small>被停止监控</small></div>
        </div>
      </section>
      <FilterCard activeCount={[status, platform].filter(Boolean).length}>
        <div className="filter-line"><span className="filter-label">状态</span>{STATUS_CHIPS.map(([v, l]) => chip("status", v, l, status))}</div>
        <div className="filter-line"><span className="filter-label">平台</span>{chip("platform", "all", "全部平台", platform)}{PLAN_PLATFORMS.map((p) => chip("platform", p, PLATFORM_LABEL[p] ?? p, platform))}</div>
      </FilterCard>
      <div className="result-bar">
        <span>共 <strong>{n(res.total)}</strong> 个账号</span>
        <span className="hint">综合状态：链接无效 → 疑似空账号 → 上级被关闭 → 被停止监控 → 已移出活动计划 → 正常采集。</span>
      </div>
      {res.items.length === 0 || !detail ? (
        <EmptyState title="没有符合条件的账号" text="切换状态或平台筛选，或检查数据范围；账号在名单导入解析成功后出现在这里。" action={status || platform ? <Link className="btn" href="/accounts">清空筛选</Link> : undefined} />
      ) : (
        <div className="split-view">
          <div className="split-main">
            <div className="table-wrap">
              <table>
                <thead><tr><th>账号</th><th>专员 · 门店</th><th>综合状态</th><th>监控</th><th>最近同步</th></tr></thead>
                <tbody>
                  {res.items.map((a) => (
                    <ClickRow key={a.accountId} href={href({ account: a.accountId, page: String(page) })}>
                      <td>
                        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                          <span className="avatar" style={{ width: 30, height: 30, flexBasis: 30, fontSize: 11 }}>{(a.nickname ?? a.staff.name).slice(0, 1)}</span>
                          <div>
                            <Link className="cell-main" href={href({ account: a.accountId, page: String(page) })} scroll={false}>{a.nickname ?? `账号 ${a.accountId}`}</Link>
                            <div className="cell-sub">{PLATFORM_LABEL[a.platform] ?? a.platform} · {a.followers === null ? "—" : n(a.followers)} 粉丝 · {a.posts === null ? "—" : n(a.posts)} 作品</div>
                          </div>
                        </div>
                      </td>
                      <td><div className="cell-main">{a.staff.name}</div><div className="cell-sub">{a.store.name} · {a.branch.name}</div></td>
                      <td>
                        <Badge tone={ACCOUNT_STATUS_TONE[a.status.code] ?? "gray"}>{a.status.label}</Badge>
                        {a.status.detail && a.status.code === "monitoring_stopped" ? <div className="cell-sub">{a.status.detail}</div> : null}
                      </td>
                      <td>{a.enabled ? <Badge tone="green">开启</Badge> : <Badge tone="gray">关闭</Badge>}</td>
                      <td className="num nowrap">{bjt(a.lastSyncAt)}</td>
                    </ClickRow>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager page={page} pages={pages} href={(pg) => href({ page: String(pg), account: undefined })} />
          </div>
          <aside className="split-side" aria-label="账号详情">
            <div className="split-side-head"><div className="split-side-title">账号详情</div></div>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
              <span className="avatar">{(detail.nickname ?? detail.staff.name).slice(0, 1)}</span>
              <div style={{ flex: 1 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <strong style={{ fontSize: 15 }}>{detail.nickname ?? `账号 ${detail.accountId}`}</strong>
                  <Badge tone={ACCOUNT_STATUS_TONE[detail.status.code] ?? "gray"}>{detail.status.label}</Badge>
                </div>
                <div className="cell-sub" style={{ marginTop: 3 }}>{PLATFORM_LABEL[detail.platform] ?? detail.platform} · {detail.branch.name}</div>
              </div>
            </div>
            <AccountPanel
              accountId={detail.accountId}
              statusCode={detail.status.code}
              canConfirmEmpty={ctx.capabilities.has("data.account.manage")}
              canSync={ctx.capabilities.has("data.sync.trigger")}
              canRemove={ctx.capabilities.has("activity_plan.join")}
              canMonitor={ctx.capabilities.has("data.monitoring.manage")}
              canOrgSwitches={canSetOrgSwitches(ctx)}
              chain={detail.chain}
              closedReason={detail.closedReason}
              plans={detail.plans.map((p) => ({ planId: p.planId, name: p.name }))}
              staffLabel={`${detail.store.name} · ${detail.staff.name}`}
            >
            <div className="info-grid" style={{ gridTemplateColumns: "1fr 1fr", margin: "14px 0" }}>
              <div><div className="info-label">专员 / 门店</div><div className="info-value">{detail.staff.name} · {detail.store.name}</div></div>
              <div><div className="info-label">最近同步</div><div className="info-value num">{bjt(detail.lastSyncAt)}</div></div>
              <div><div className="info-label">录入状态</div><div className="info-value">{detail.intake === "normal" ? "正常录入" : "疑似空账号"}</div></div>
              <div><div className="info-label">账号粉丝 / 作品</div><div className="info-value num">{detail.followers === null ? "—" : n(detail.followers)} / {detail.posts === null ? "—" : n(detail.posts)}</div></div>
            </div>
            <div className="callout" style={{ fontSize: 11.5, marginBottom: 14 }}>
              <span>
                {detail.status.code === "suspected_empty"
                  ? "疑似空账号不关闭监控开关，但不进入常规采集；人工确认后改为正常录入。"
                  : "实际监控 = 账号开关打开 ∧ 上级链有效 ∧ 录入状态为正常录入。"}
              </span>
            </div>
            </AccountPanel>
          </aside>
        </div>
      )}
    </>
  );
}
