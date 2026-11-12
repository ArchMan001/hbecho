import Link from "next/link";
import { ClickRow } from "../../_components/click-row";
import { Pager } from "../../_components/plans/pager";
import { Badge, BackLink, DeniedState, EmptyState, PageHead } from "../../_components/ui";
import { bjt, BATCH_STATUS, n } from "../../_lib/plan-labels";
import { directory, hrefWith, pageOf, PAGE_SIZE } from "../../_lib/plan-page";
import { ap, planActorOf } from "../../_lib/plan";
import { requireUser, web } from "../../_lib/session";

type Q = { plan?: string | undefined; page?: string | undefined };
interface Confirm {
  imported?: number;
  unchanged?: number;
  conflict?: number;
  pending_account?: number;
}

export default async function BatchesPage({ searchParams }: { searchParams: Promise<Q> }) {
  const ctx = await requireUser();
  if (!ctx.capabilities.has("activity_plan.create") && !ctx.capabilities.has("activity_plan.join")) return <DeniedState text="当前角色没有「活动计划」入口。" />;
  const q = await searchParams;
  const planId = q.plan && /^[1-9]\d{0,18}$/.test(q.plan) ? q.plan : undefined;
  const actor = await planActorOf(ctx);
  // ponytail: 批次在内存里过滤和分页（query.batches 没有总数）；批次数到几千时把总数和分页下推到查询里
  const all = await ap().query.batches(actor, { ...(planId ? { planId: BigInt(planId) } : {}), limit: 500 });
  const { page, pages, offset } = pageOf(q.page, all.length);
  const rows = all.slice(offset, offset + PAGE_SIZE);
  const [names, dir] = await Promise.all([web().actorNames(rows.map((b) => b.uploadedBy)), directory()]);
  const branchName = new Map(dir.branches.map((b) => [b.id, b.name]));
  return (
    <>
      <BackLink href={planId ? `/plans/${planId}` : "/plans"}>{planId ? "返回计划详情" : "返回活动计划"}</BackLink>
      <PageHead title="导入批次" sub="预检只读、确认写入、解析归并；批次与行结果是历史事实，计划清除后仍保留。" />
      <div className="result-bar">
        <span>共 <strong>{all.length}</strong> 个批次{planId ? "（仅此计划）" : ""}</span>
        {planId ? <Link className="btn btn-sm" href="/batches">查看全部批次</Link> : null}
      </div>
      {rows.length === 0 ? (
        <EmptyState title="还没有导入批次" text="在计划详情里上传名单后，批次会出现在这里。" action={<Link className="btn" href="/plans">去活动计划</Link>} />
      ) : (
        <>
          <div className="table-wrap">
            <table>
              <thead><tr><th>批次</th><th>计划 / 文件</th><th>提交人</th><th>时间</th><th>状态</th><th className="right">结果计数</th><th className="right">操作</th></tr></thead>
              <tbody>
                {rows.map((b) => {
                  const st = BATCH_STATUS[b.status] ?? { label: b.status, tone: "gray" as const };
                  const c = (b.confirm ?? {}) as Confirm;
                  const confirmed = b.confirm !== null && Object.keys(b.confirm as object).length > 0;
                  return (
                    <ClickRow key={b.batchId} href={`/batches/${b.batchId}`}>
                      <td><div className="cell-main num">{b.batchId}</div><div className="cell-sub">{b.submitterBranchId ? (branchName.get(b.submitterBranchId) ?? "") : "总部 / 超管"}</div></td>
                      <td><div className="cell-main">{b.planName ?? "（计划已清除）"}</div><div className="cell-sub">{b.fileName}</div></td>
                      <td>{names.get(b.uploadedBy) ?? b.uploadedBy}</td>
                      <td className="num nowrap">{bjt(b.uploadedAt)}</td>
                      <td><Badge tone={st.tone}>{st.label}</Badge></td>
                      <td className="right">
                        {confirmed ? (
                          <><span className="num">{n((c.imported ?? 0) + (c.unchanged ?? 0))}</span><br /><span className="cell-sub">成功 / 冲突 {c.conflict ?? 0} / 解析中 {c.pending_account ?? 0}</span></>
                        ) : (
                          <span className="cell-sub">共 {n(b.totalRows)} 行</span>
                        )}
                      </td>
                      <td className="right"><Link className="btn btn-sm" href={`/batches/${b.batchId}`}>查看</Link></td>
                    </ClickRow>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Pager page={page} pages={pages} href={(pg) => hrefWith("/batches", q, { page: String(pg) })} />
        </>
      )}
    </>
  );
}
