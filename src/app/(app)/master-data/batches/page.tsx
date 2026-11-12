import Link from "next/link";
import { ClickRow } from "../../../_components/click-row";
import { Pager } from "../../../_components/plans/pager";
import { BackLink, Badge, DeniedState, EmptyState, PageHead } from "../../../_components/ui";
import { MD_MODE } from "../../../_lib/master-labels";
import { masterData, mdActorOf } from "../../../_lib/master-data";
import { bjt, BATCH_STATUS, n } from "../../../_lib/plan-labels";
import { hrefWith, pageOf, PAGE_SIZE } from "../../../_lib/plan-page";
import { requireUser, web } from "../../../_lib/session";

type Q = { page?: string | undefined };
interface Summary {
  mode?: string;
  error?: number;
  needs_superadmin?: number;
  imported?: number;
  unchanged_written?: number;
}

export default async function MasterBatchesPage({ searchParams }: { searchParams: Promise<Q> }) {
  const ctx = await requireUser();
  if (!ctx.capabilities.has("data.master_data.import") && !ctx.capabilities.has("data.master_data.structure")) return <DeniedState text="主数据导入只对超管与总部人员开放。" />;
  const q = await searchParams;
  // ponytail: 批次在内存里分页（query.list 没有总数，最多取 500 条）；导入是低频操作，批次数到几百再下推
  const all = await masterData().query.list({ limit: 500 }, await mdActorOf(ctx));
  const { page, pages, offset } = pageOf(q.page, all.length);
  const rows = all.slice(offset, offset + PAGE_SIZE);
  const names = await web().actorNames(rows.flatMap((b) => [b.uploadedByActor]));
  return (
    <>
      <BackLink href="/master-data/import">返回主数据导入</BackLink>
      <PageHead title="导入记录" sub="批次与行结果是历史事实，长期保留；只显示你授权品牌内的批次。" />
      {rows.length === 0 ? (
        <EmptyState title="还没有导入记录" text="上传第一份门店信息后，记录会出现在这里。" action={<Link className="btn btn-primary" href="/master-data/import">去导入</Link>} />
      ) : (
        <>
          <div className="table-wrap">
            <table>
              <thead><tr><th>批次</th><th>文件</th><th>模式</th><th>提交人 · 时间</th><th>状态</th><th className="right">结果计数</th><th className="right">操作</th></tr></thead>
              <tbody>
                {rows.map((b) => {
                  const st = BATCH_STATUS[b.status] ?? { label: b.status, tone: "gray" as const };
                  const s = (b.summary ?? {}) as Summary;
                  return (
                    <ClickRow key={b.batchId} href={`/master-data/batches/${b.batchId}`}>
                      <td><div className="cell-main num">{b.batchId}</div></td>
                      <td>{b.fileName ?? "—"}</td>
                      <td>{MD_MODE[s.mode ?? ""] ?? s.mode ?? "—"}</td>
                      <td><div className="cell-main">{names.get(b.uploadedByActor) ?? b.uploadedByActor}</div><div className="cell-sub num">{bjt(b.uploadedAt)}</div></td>
                      <td><Badge tone={st.tone}>{st.label}</Badge></td>
                      <td className="right"><span className="num">共 {n(b.totalRows)} 行</span><br /><span className="cell-sub">错误 {s.error ?? 0} / 需超管 {s.needs_superadmin ?? 0}</span></td>
                      <td className="right"><Link className="btn btn-sm" href={`/master-data/batches/${b.batchId}`}>查看</Link></td>
                    </ClickRow>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Pager page={page} pages={pages} href={(pg) => hrefWith("/master-data/batches", q, { page: String(pg) })} />
        </>
      )}
    </>
  );
}
