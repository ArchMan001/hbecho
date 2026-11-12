import Link from "next/link";
import { notFound } from "next/navigation";
import { ClickRow } from "../../../_components/click-row";
import { Icon } from "../../../_components/icon";
import { AssignOwnersButton, DeletePlanButton, EditPlanButton, ExitBranchButton, JoinBranchButton, JoinPicker, PlanStatusButtons, RemoveEntryButton } from "../../../_components/plans/plan-actions";
import { Pager } from "../../../_components/plans/pager";
import { BackLink, Badge, Callout, DeniedState, EmptyState } from "../../../_components/ui";
import { ACCOUNT_STATUS_TONE, bjt, n, PLAN_STATUS, PLATFORM_LABEL, SECTOR_LABEL, changeText, sectorText } from "../../../_lib/plan-labels";
import { brandNameByCode, directory, hrefWith, orNotFound, pageNumber, pageOf, PAGE_SIZE } from "../../../_lib/plan-page";
import { ap, planActorOf } from "../../../_lib/plan";
import { requireUser, web } from "../../../_lib/session";

type Q = { tab?: string | undefined; state?: string | undefined; page?: string | undefined };
const TABS: Array<[string, string]> = [["basic", "基本信息"], ["participants", "参与分公司"], ["roster", "名单"], ["downstream", "下游判定计划"], ["changes", "变更记录"]];

export default async function PlanDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Q> }) {
  const ctx = await requireUser();
  if (!ctx.capabilities.has("activity_plan.create") && !ctx.capabilities.has("activity_plan.join")) return <DeniedState text="当前角色没有「活动计划」入口。" />;
  const { id } = await params;
  if (!/^[1-9]\d{0,18}$/.test(id)) notFound();
  const q = await searchParams;
  const tab = TABS.some(([k]) => k === q.tab) ? q.tab! : "basic";
  const actor = await planActorOf(ctx);
  // 计划不存在、已删除、越范围都表现为「未找到」，对外不可区分
  const d = await orNotFound(ap().query.planDetail(actor, BigInt(id)));
  const canManage = actor.capabilities.has("activity_plan.create") && (actor.platformAdmin || d.createdBy === actor.actor);
  const canJoin = actor.capabilities.has("activity_plan.join");
  const collecting = d.status === "collecting";
  const canUpload = collecting && canJoin;
  const st = PLAN_STATUS[d.status] ?? { label: d.status, tone: "gray" as const };
  const [brandName, dir] = await Promise.all([brandNameByCode(), directory()]);
  const branchName = new Map(dir.branches.map((b) => [b.id, b.name]));

  // 展示名：创建者、负责人（审计字段里存的是主体字符串）、变更记录操作者
  const owners = d.branches.flatMap((b) => b.owners.map((o) => o.owner));
  const names = await web().actorNames([d.createdBy, ...owners, ...d.changes.map((c) => c.actor)]);
  const ownerName = (o: { owner: string; displayName: string | null }) => (o.displayName && o.displayName !== o.owner ? o.displayName : (names.get(o.owner) ?? o.owner));
  const sectorList = d.sectors;

  const href = (patch: Partial<Q>) => hrefWith(`/plans/${id}`, q, patch);
  const tabHref = (t: string) => hrefWith(`/plans/${id}`, { tab: t }, {});

  // 负责人候选：同分公司的有效用户（只有创建者 / 超管能指派，且仅采集中）
  const candidates = new Map<string, Array<{ id: string; name: string }>>();
  if (canManage && collecting && tab === "participants") {
    const users = await web().admin.list(ctx).catch(() => []);
    for (const b of d.branches) candidates.set(b.branchId, users.filter((u) => u.status === "active" && u.branchIds.includes(b.branchId)).map((u) => ({ id: `user:${u.userId}`, name: u.name })));
  }
  // 可加入的分公司：目录里在用、在自己范围内、还没有参与记录的
  const known = new Set(d.branches.map((b) => b.branchId));
  const joinable = dir.branches.filter((b) => b.active && !known.has(b.id) && (actor.branchScope === "all" || actor.branchScope.has(BigInt(b.id))));

  let body: React.ReactNode;
  if (tab === "participants") {
    body = (
      <>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 12 }}>
          <div><div className="card-title">参与分公司与负责人</div><div className="card-sub">每个（计划 × 分公司）最多 2 名负责人；负责人不是权限。</div></div>
        </div>
        {d.branches.length === 0 ? (
          <EmptyState title="还没有分公司加入" text="同品牌的分公司都可以加入；加入后由分公司提报名单。" />
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>分公司</th><th>状态</th><th>负责人槽位</th><th className="right">操作</th></tr></thead>
              <tbody>
                {d.branches.map((b) => (
                  <tr key={b.branchId}>
                    <td><div className="cell-main">{b.name}</div></td>
                    <td>{b.status === "joined" ? <Badge tone="green">已参加</Badge> : <Badge tone="gray">已退出</Badge>}</td>
                    <td>
                      {[1, 2].map((slot) => {
                        const o = b.owners.find((x) => x.slotNo === slot);
                        return <span key={slot} className="tag">{o ? ownerName(o) : "—"}</span>;
                      })}
                      {b.owners.length === 0 ? <span className="cell-sub">空槽，提交新增行时自动占用</span> : null}
                    </td>
                    <td className="right nowrap">
                      {canManage && collecting && b.status === "joined" ? (
                        <AssignOwnersButton planId={id} branchId={b.branchId} branchName={b.name} owners={b.owners.map((o) => ({ slotNo: o.slotNo, owner: o.owner, name: ownerName(o) }))} candidates={candidates.get(b.branchId) ?? []} />
                      ) : null}{" "}
                      {canJoin && collecting && (actor.branchScope === "all" || actor.branchScope.has(BigInt(b.branchId))) ? (
                        b.status === "joined" ? <ExitBranchButton planId={id} branchId={b.branchId} name={b.name} /> : <JoinBranchButton planId={id} branchId={b.branchId} name={b.name} rejoin />
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {canJoin && collecting ? (
          actor.branchScope !== "all" && joinable.length <= 3 ? (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 14 }}>
              {joinable.map((b) => <JoinBranchButton key={b.id} planId={id} branchId={b.id} name={b.name} rejoin={false} />)}
            </div>
          ) : (
            <JoinPicker planId={id} options={joinable.map((b) => ({ id: b.id, name: b.name }))} />
          )
        ) : null}
        <Callout icon="alert" style={{ marginTop: 14 }}>退出会把该分公司在本计划下全部「在名单」项置为「已移出活动计划」，释放负责人名额，并立即按引用计数检查账号监控；已采数据不删除。</Callout>
      </>
    );
  } else if (tab === "roster") {
    const state = q.state === "removed" || q.state === "all" ? q.state : "in_roster";
    const fetchPage = (pg: number) => ap().query.roster(actor, BigInt(id), { offset: (pg - 1) * PAGE_SIZE, limit: PAGE_SIZE, ...(state === "all" ? {} : { state }) });
    const wanted = pageNumber(q.page);
    let res = await fetchPage(wanted);
    const { page, pages } = pageOf(q.page, res.total);
    if (page !== wanted) res = await fetchPage(page); // 页码超出范围时落到最后一页
    const chip = (v: string, l: string) => <Link key={v} className={`chip ${state === v ? "active" : ""}`} href={href({ state: v === "in_roster" ? undefined : v, page: undefined })} scroll={false}>{l}</Link>;
    body = (
      <>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 12 }}>
          <div><div className="card-title">名单</div><div className="card-sub">按门店 · 专员 · 账号；分公司只看自己报的那部分。</div></div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Link className="btn btn-sm" href={`/batches?plan=${id}`}><Icon name="file" /> 批次</Link>
            {canUpload ? <Link className="btn btn-sm btn-primary" href={`/plans/${id}/import`}><Icon name="upload" /> 上传名单</Link> : null}
          </div>
        </div>
        <div className="filter-line" style={{ marginBottom: 12 }}><span className="filter-label">名单状态</span>{chip("in_roster", "在名单")}{chip("removed", "已移出")}{chip("all", "全部")}</div>
        {res.total === 0 ? (
          <EmptyState title={state === "removed" ? "没有已移出的名单项" : "名单为空"} text="上传名单后，预检只读、确认写入才会产生名单项。" action={canUpload ? <Link className="btn btn-primary" href={`/plans/${id}/import`}>上传名单</Link> : undefined} />
        ) : (
          <>
            <div className="table-wrap">
              <table>
                <thead><tr><th>门店 · 专员</th><th>手机号</th><th>账号主页</th><th>分公司</th><th>综合状态</th><th>加入时间</th><th className="right">操作</th></tr></thead>
                <tbody>
                  {res.items.map((it) => (
                    <tr key={it.accountId}>
                      <td><div className="cell-main">{it.store.name}</div><div className="cell-sub">{it.staff.name}</div></td>
                      <td className="num">{it.staff.phone}</td>
                      <td className="locator" title={it.homeLocator ?? ""}>{it.homeLocator ? it.homeLocator.slice(0, 60) : "—"}</td>
                      <td>{branchName.get(it.branchId) ?? "—"}</td>
                      <td><Badge tone={ACCOUNT_STATUS_TONE[it.status.code] ?? "gray"}>{it.status.label}</Badge>{it.status.detail ? <div className="cell-sub">{it.status.detail}</div> : null}</td>
                      <td className="num nowrap">{bjt(it.addedAt)}</td>
                      <td className="right nowrap">
                        {it.entryState === "removed" ? <span className="cell-sub">已移出</span> : canJoin && collecting ? <RemoveEntryButton planId={id} accountId={it.accountId} label={`${it.store.name} · ${it.staff.name}`} /> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager page={page} pages={pages} href={(pg) => href({ page: String(pg) })} />
          </>
        )}
        <Callout icon="alert" style={{ marginTop: 14 }}>名单项永不物理删除；移出后账号仅被本计划引用时立即关闭监控，仍被其他有效计划引用时保持开启。</Callout>
      </>
    );
  } else if (tab === "downstream") {
    body = (
      <>
        <div className="card-sub" style={{ marginBottom: 12 }}>每板块一份；这里只列出本计划需要的监控判定计划，判定字段在判定计划页维护。</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(260px,1fr))", gap: 12 }}>
          {sectorList.map((s) => (
            <div key={s} className="card card-pad">
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                <div className="card-title">{SECTOR_LABEL[s] ?? s}</div>
                <Badge tone="amber">待创建</Badge>
              </div>
              <div className="cell-sub" style={{ marginTop: 6 }}>{d.name} · {SECTOR_LABEL[s] ?? s}</div>
              <p className="hint" style={{ marginTop: 12 }}>判定计划在「判定计划」页创建；该页面随判定计划功能上线后出现。</p>
            </div>
          ))}
        </div>
      </>
    );
  } else if (tab === "changes") {
    body =
      d.changes.length === 0 ? (
        <EmptyState title="还没有变更" text="创建、编辑、状态变化、参与关系、负责人和名单变更会记录在这里；计划清除时一并清除。" />
      ) : (
        <div className="timeline">
          {d.changes.map((c, i) => {
            const t = changeText(c.event, c.detail as Record<string, unknown> | null, c.branchId ? (branchName.get(c.branchId) ?? null) : null);
            return (
              <div key={`${c.at}-${i}`} className="timeline-item">
                <div className="timeline-time">{bjt(c.at)}</div>
                <div><div className="timeline-title">{t.title} · {names.get(c.actor) ?? c.actor}</div><div className="timeline-text">{t.text}</div></div>
              </div>
            );
          })}
        </div>
      );
  } else {
    body = (
      <>
        <div className="stat-grid" style={{ marginBottom: 18 }}>
          <div className="stat"><div className="stat-label">名单账号</div><div className="stat-value">{n(d.counts.accounts)}</div><div className="stat-hint">只计数，不做比率</div></div>
          <div className="stat"><div className="stat-label">参与分公司</div><div className="stat-value">{n(d.counts.branches)}</div><div className="stat-hint">同品牌的分公司均可参加</div></div>
          <div className="stat"><div className="stat-label">板块</div><div className="stat-value">{d.counts.sectors}</div><div className="stat-hint">{sectorText(sectorList)}</div></div>
          <div className="stat"><div className="stat-label">待处理</div><div className="stat-value">{n(d.counts.pending)}</div><div className="stat-hint">解析中 / 疑似空账号</div></div>
        </div>
        <div className="info-grid">
          <div><div className="info-label">品牌</div><div className="info-value">{brandName.get(d.brand) ?? d.brand}</div></div>
          <div><div className="info-label">平台</div><div className="info-value">{PLATFORM_LABEL[d.platform] ?? d.platform}</div></div>
          <div><div className="info-label">板块</div><div className="info-value">{sectorText(sectorList)}</div></div>
          <div><div className="info-label">开始日期</div><div className="info-value num">{d.startsOn}</div></div>
          <div><div className="info-label">结束日期</div><div className="info-value num">{d.endsOn ?? "无结束日"}</div></div>
          <div><div className="info-label">创建者</div><div className="info-value">{names.get(d.createdBy) ?? d.createdBy}</div></div>
          <div style={{ gridColumn: "1/-1" }}><div className="info-label">说明（仅作说明，不参与判定）</div><div className="info-value">{d.description || "—"}</div></div>
        </div>
        <Callout icon="clipboard" style={{ marginTop: 18 }}>{d.required.text}。创建计划只声明需求，判定计划在「判定计划」页创建。</Callout>
      </>
    );
  }

  return (
    <>
      <BackLink href="/plans">返回活动计划</BackLink>
      <div className="page-head">
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
            <h1 className="page-title">{d.name}</h1>
            <Badge tone={st.tone}>{st.label}</Badge>
          </div>
          <p className="page-sub">{brandName.get(d.brand) ?? d.brand} · {PLATFORM_LABEL[d.platform] ?? d.platform} · {sectorText(sectorList)} · {d.startsOn}{d.endsOn ? ` 至 ${d.endsOn}` : " 起（无结束日）"}</p>
        </div>
        <div className="page-actions">
          {canManage ? <EditPlanButton plan={{ planId: id, name: d.name, description: d.description ?? "", startsOn: d.startsOn, endsOn: d.endsOn ?? "" }} /> : null}
          {canManage ? <PlanStatusButtons planId={id} name={d.name} status={d.status} /> : null}
          {canManage ? <DeletePlanButton planId={id} name={d.name} /> : null}
          {canUpload ? <Link className="btn btn-primary" href={`/plans/${id}/import`}><Icon name="upload" /> 上传名单</Link> : null}
        </div>
      </div>
      {!canManage ? <Callout icon="lock" style={{ marginBottom: 14 }}>你可以在授权品牌内看到这个计划，但只有计划创建者或超管可以编辑、暂停 / 归档 / 删除、替换负责人。</Callout> : null}
      {!collecting ? <Callout icon="lock" tone="warn" style={{ marginBottom: 14 }}>计划当前为「{st.label}」：名单、参与关系与负责人已冻结；恢复为采集中后才能继续维护。</Callout> : null}
      <div className="detail-grid">
        <div className="card detail-main">
          <div className="tabs" role="tablist" aria-label="计划详情">
            {TABS.map(([key, label]) => (
              <Link key={key} role="tab" aria-selected={tab === key} className={`tab ${tab === key ? "active" : ""}`} href={tabHref(key)} scroll={false}>{label}</Link>
            ))}
          </div>
          <div className="card-pad">{body}</div>
        </div>
        <aside className="detail-rail" aria-label="计划上下文">
          <div className="rail-card">
            <div className="rail-kicker">计划概览</div>
            <div className="rail-title">{st.label} · {sectorText(sectorList)}</div>
            <div className="rail-list">
              <div className="rail-row"><span>名单账号</span><strong className="num">{n(d.counts.accounts)}</strong></div>
              <div className="rail-row"><span>参与分公司</span><strong className="num">{n(d.counts.branches)}</strong></div>
              <div className="rail-row"><span>待处理</span><strong className="num">{n(d.counts.pending)}</strong></div>
              <div className="rail-row"><span>判定计划</span><strong className="num">{d.required.count}</strong></div>
            </div>
            <div className="rail-text">{d.endsOn ? `结束日 ${d.endsOn}；暂停 / 归档 / 删除会冻结名单。` : "无结束日，视为持续引用。"}</div>
          </div>
          <div className="rail-card">
            <div className="rail-kicker">负责人</div>
            <div className="rail-title">{d.branches[0]?.name ?? "参与分公司"}</div>
            <div className="owner-stack">
              {(d.branches[0]?.owners ?? []).length ? d.branches[0]!.owners.map((o) => <span key={o.slotNo} className="owner-chip"><span className="mini-avatar">{ownerName(o).slice(0, 1)}</span>{ownerName(o)}</span>) : <span className="rail-text">空槽，提交新增行时自动占用</span>}
            </div>
            <div className="rail-text">每个（计划 × 分公司）最多 2 名负责人；负责人不是权限。</div>
            <Link className="btn btn-sm" style={{ marginTop: 10 }} href={tabHref("participants")}>查看参与分公司</Link>
          </div>
          <div className="rail-card">
            <div className="rail-kicker">下游判定</div>
            <div className="rail-title">{d.required.count} 份监控判定计划</div>
            <div className="rail-text">{sectorText(sectorList)}；创建计划只声明需求，判定计划在「判定计划」页创建。</div>
            <Link className="btn btn-sm" style={{ marginTop: 10 }} href={tabHref("downstream")}>查看下游</Link>
          </div>
        </aside>
      </div>
    </>
  );
}
