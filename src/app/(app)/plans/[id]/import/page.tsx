import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { PrecheckBadge, ReasonCell } from "../../../../_components/plans/cells";
import { Pager } from "../../../../_components/plans/pager";
import { RosterReportActions, RosterUpload, Steps } from "../../../../_components/plans/roster-wizard";
import { BackLink, Callout, DeniedState, PageHead } from "../../../../_components/ui";
import { ROSTER_HEADER } from "../../../../../modules/activity-plan/constants";
import { n, PLAN_STATUS, PLATFORM_LABEL, sectorText } from "../../../../_lib/plan-labels";
import { brandNameByCode, directory, hrefWith, orNotFound, pageOf } from "../../../../_lib/plan-page";
import { ap, planActorOf } from "../../../../_lib/plan";
import { requireUser } from "../../../../_lib/session";

type Q = { batch?: string | undefined; cls?: string | undefined; page?: string | undefined };
const ROWS_PER_PAGE = 50;
const CLASS_CHIPS: Array<[string, string]> = [["all", "全部"], ["new", "可写入"], ["new_staff", "将新建专员"], ["update", "恢复"], ["unchanged", "未变"], ["error", "错误"]];
type RowsRes = Awaited<ReturnType<ReturnType<typeof ap>["query"]["rows"]>>;
interface Precheck {
  new: number;
  new_staff: number;
  update: number;
  unchanged: number;
  error: number;
  possible_new_accounts: number;
  plan_entries_now: number;
  plan_entries_after: number;
  soft_cap_exceeded: boolean;
  /** 总部提交时，文件中出现但尚未加入计划的分公司（确认写入自动加入，刘学奎 2026-11-12）。 */
  auto_join_branches: number;
  auto_join_branch_codes: string[];
}

export default async function ImportPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Q> }) {
  const ctx = await requireUser();
  if (!ctx.capabilities.has("activity_plan.join")) return <DeniedState text="上传名单需要「加入活动计划」权限。" home="/plans" />;
  const { id } = await params;
  if (!/^[1-9]\d{0,18}$/.test(id)) notFound();
  const q = await searchParams;
  const actor = await planActorOf(ctx);
  const d = await orNotFound(ap().query.planDetail(actor, BigInt(id)));
  const [brandName, dir] = await Promise.all([brandNameByCode(), directory()]);
  const st = PLAN_STATUS[d.status] ?? { label: d.status, tone: "gray" as const };
  const branchName = new Map(dir.branches.map((b) => [b.id, b.name]));
  const planLine = `${brandName.get(d.brand) ?? d.brand} · ${PLATFORM_LABEL[d.platform] ?? d.platform}`;

  const rail = (
    <aside className="wizard-rail" aria-label="导入上下文">
      <div className="rail-card">
        <div className="rail-kicker">目标计划</div>
        <div className="rail-title">{d.name}</div>
        <div className="rail-list">
          <div className="rail-row"><span>品牌</span><strong>{brandName.get(d.brand) ?? d.brand}</strong></div>
          <div className="rail-row"><span>平台</span><strong>{PLATFORM_LABEL[d.platform] ?? d.platform}</strong></div>
          <div className="rail-row"><span>板块</span><strong>{sectorText(d.sectors)}</strong></div>
          <div className="rail-row"><span>当前名单</span><strong className="num">{n(d.counts.accounts)}</strong></div>
        </div>
      </div>
      <div className="rail-card">
        <div className="rail-kicker">限额</div>
        <div className="rail-list">
          <div className="rail-row"><span>数据行</span><strong>≤ 2,000</strong></div>
          <div className="rail-row"><span>文件大小</span><strong>≤ 10 MB</strong></div>
          <div className="rail-row"><span>单批时长</span><strong>≤ 10 分钟</strong></div>
          <div className="rail-row"><span>将新建专员</span><strong>≤ 1,000</strong></div>
        </div>
      </div>
      <div className="rail-card">
        <div className="rail-kicker">负责人名额</div>
        <div className="rail-title">提交新增行时占用</div>
        <div className="rail-text">持有「加入活动计划」权限且分公司范围不是「全部」的提交人，在确认写入时若批次包含可能新增的行，占用一个负责人槽；已满则整批失败。</div>
      </div>
      <Callout icon="shield">预检只读；确认后才写专员、名单与解析任务。</Callout>
    </aside>
  );
  const head = (
    <>
      <BackLink href={`/plans/${id}`}>返回计划详情</BackLink>
      <PageHead
        title="名单导入"
        sub={`${d.name} · 预检只读，确认后才写入业务表。`}
        actions={<><span className="tag">{PLATFORM_LABEL[d.platform] ?? d.platform}</span><span className="tag">{sectorText(d.sectors)}</span></>}
      />
    </>
  );

  if (d.status !== "collecting") {
    return (
      <>
        {head}
        <Callout icon="lock" tone="warn">计划当前为「{st.label}」，名单与负责人已冻结；恢复为采集中后才能导入。</Callout>
      </>
    );
  }

  // ── 没有批次：选择计划 → 下载模板 → 上传 ──
  if (!q.batch) {
    const mine = actor.branchScope === "all" ? [] : d.branches.filter((b) => b.status === "joined");
    // 范围里有多个分公司时让提交人选；只有一个时服务端自动取；范围 all 不需要
    const options = actor.branchScope !== "all" && actor.branchScope.size > 1 ? mine.map((b) => ({ id: b.branchId, name: b.name })) : [];
    const needJoin = actor.branchScope !== "all" && mine.length === 0;
    return (
      <>
        {head}
        <div className="wizard-layout">
          <div className="card wizard-main">
            {needJoin ? (
              <div className="card-pad">
                <Callout icon="alert" tone="warn">你的分公司还没有加入这个计划。请先在「参与分公司」里加入，再上传名单。</Callout>
                <div style={{ marginTop: 12 }}><Link className="btn" href={`/plans/${id}?tab=participants`}>去参与分公司</Link></div>
              </div>
            ) : (
              <RosterUpload planId={id} planName={d.name} planLine={planLine} accounts={d.counts.accounts} branchOptions={options} />
            )}
          </div>
          {rail}
        </div>
      </>
    );
  }

  // ── 有批次：预检报告 ──
  if (!/^[1-9]\d{0,18}$/.test(q.batch)) notFound();
  const batch = await orNotFound(ap().query.batch(actor, q.batch));
  if (batch.planId !== id) notFound();
  if (batch.status !== "awaiting_confirm") redirect(`/batches/${batch.batchId}`); // 已经确认过 / 预检失败：去批次详情
  // query.batch 的 precheck 已经是汇总里的 precheck 对象（各分类计数）
  const p = (batch.precheck ?? {}) as Partial<Precheck>;
  const cls = CLASS_CHIPS.some(([v]) => v === q.cls) && q.cls !== "all" ? q.cls : undefined;
  const count = (k: keyof Precheck) => Number(p[k] ?? 0);
  const writable = count("new") + count("new_staff") + count("update");
  const href = (patch: Partial<Q>) => hrefWith(`/plans/${id}/import`, q, patch);

  let rowsView: RowsRes | null = null;
  let page = 1;
  let pages = 1;
  if (batch.rowsVisible) {
    const wanted = Math.max(1, Number(q.page) || 1);
    const fetchRows = (pg: number) => ap().query.rows(actor, batch.batchId, { offset: (pg - 1) * ROWS_PER_PAGE, limit: ROWS_PER_PAGE, ...(cls ? { precheckClass: cls } : {}) });
    let r = await fetchRows(wanted);
    const pg = pageOf(q.page, r.total, ROWS_PER_PAGE);
    if (pg.page !== wanted) r = await fetchRows(pg.page);
    rowsView = r;
    page = pg.page;
    pages = pg.pages;
  }

  // 负责人名额：按本地可知事实给一句话（与确认时的判定同一口径；真正的占用与拒绝在服务端确认时发生）
  const submitter = batch.submitterBranchId;
  const owners = submitter ? (d.branches.find((b) => b.branchId === submitter)?.owners ?? []) : [];
  let ownerNote = "豁免（总部 / 超管不占名额）";
  let ownerBlocked = false;
  if (actor.branchScope !== "all") {
    if (owners.some((o) => o.owner === actor.actor)) ownerNote = "你已是负责人，不占用";
    else if (count("possible_new_accounts") === 0) ownerNote = "不占用（没有可能新增的账号）";
    else if (owners.length >= 2) {
      ownerNote = "名额已满";
      ownerBlocked = true;
    } else ownerNote = "将占用 1 个槽位";
  }

  return (
    <>
      {head}
      <div className="wizard-layout">
        <div className="card wizard-main">
          <Steps current={3} />
          <div className="card-pad">
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
              <div>
                <div className="card-title">预检报告</div>
                <div className="card-sub">{batch.fileName} · 数据行 {n(batch.totalRows)}</div>
              </div>
              <RosterReportActions
                planId={id}
                canConfirm={writable + count("unchanged") > 0}
                hasReturnRows={count("error") > 0 && batch.rowsVisible}
                facts={{
                  batchId: batch.batchId,
                  planName: d.name,
                  branchName: submitter ? (branchName.get(submitter) ?? "—") : "全部（总部 / 超管提交）",
                  newStaff: count("new_staff"),
                  writable,
                  resolveTasks: count("possible_new_accounts"),
                  errors: count("error"),
                  entriesNow: count("plan_entries_now"),
                  entriesAfter: count("plan_entries_after"),
                  softCapExceeded: p.soft_cap_exceeded === true,
                  ownerNote,
                  ownerBlocked,
                  autoJoinBranches: count("auto_join_branches"),
                  autoJoinCodes: p.auto_join_branch_codes ?? [],
                }}
              />
            </div>
            <div className="stat-grid five" style={{ marginBottom: 14 }}>
              {(
                [
                  ["可写入", count("new"), "预检分类"],
                  ["将新建专员", count("new_staff"), "确认后新建"],
                  ["恢复", count("update"), "预检分类"],
                  ["未变", count("unchanged"), "预检分类"],
                  ["错误", count("error"), "需修改后重传"],
                ] as const
              ).map(([label, value, hint]) => (
                <div className="stat" key={label}><div className="stat-label">{label}</div><div className="stat-value">{n(value)}</div><div className="stat-hint">{hint}</div></div>
              ))}
            </div>
            {count("auto_join_branches") > 0 ? (
              <Callout icon="layers" style={{ marginBottom: 14 }}>
                本文件包含 {n(count("auto_join_branches"))} 家尚未加入计划的分公司（{(p.auto_join_branch_codes ?? []).join("、")}）：确认写入时会自动加入，不需要先手动加入。
              </Callout>
            ) : null}
            <Callout icon="shield" style={{ marginBottom: 14 }}>预检只读：专员、账号、归属、名单、负责人的行数都没有变化；没有调用供应商接口。示例行和表头不产生行结果。</Callout>
            {batch.rowsVisible && rowsView ? (
              <>
                <div className="filter-line" style={{ marginBottom: 12 }}>
                  <span className="filter-label">预检分类</span>
                  {CLASS_CHIPS.map(([v, l]) => <Link key={v} className={`chip ${(cls ?? "all") === v ? "active" : ""}`} href={href({ cls: v, page: undefined })} scroll={false}>{l}</Link>)}
                </div>
                <div className="table-wrap precheck-table">
                  <table>
                    <thead><tr><th>行</th><th>门店 · 专员</th><th>手机号</th><th>主页入口</th><th>预检</th><th>结果与原因</th></tr></thead>
                    <tbody>
                      {rowsView.items.map((r) => {
                        const raw = (r.raw ?? {}) as Record<string, string>;
                        return (
                          <tr key={r.rowNo}>
                            <td className="num">{r.rowNo}</td>
                            <td><div className="cell-main">{raw[ROSTER_HEADER[0]] ?? "—"}</div><div className="cell-sub">{raw[ROSTER_HEADER[1]] ?? ""}</div></td>
                            <td className="num">{raw[ROSTER_HEADER[2]] ?? "—"}</td>
                            <td className="locator" title={raw[ROSTER_HEADER[3]]}>{(raw[ROSTER_HEADER[3]] ?? "—").slice(0, 70)}</td>
                            <td><PrecheckBadge cls={r.precheckClass} /></td>
                            <td><ReasonCell code={r.reasonCode} /></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <Pager page={page} pages={pages} href={(pg) => href({ page: String(pg) })} />
              </>
            ) : (
              <Callout icon="lock">总部只能查看批次汇总，逐行明细由提交的分公司查看。</Callout>
            )}
            <Callout icon="alert" style={{ marginTop: 14 }}>
              确认写入后会：自动新建 {n(count("new_staff"))} 名专员；本地能命中的账号直接引用；其余 {n(count("possible_new_accounts"))} 行进入「解析中」，等待解析出账号。名额按本地可知事实占用。
            </Callout>
          </div>
        </div>
        {rail}
      </div>
    </>
  );
}
