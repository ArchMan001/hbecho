import Link from "next/link";
import { listManageCourses, parseManageQuery } from "../../../../modules/learning";
import { republishAction, unpublishAction } from "../../../_actions/learning";
import { ConfirmAction } from "../../../_components/dialog";
import { FilterCard } from "../../../_components/filter-card";
import { Icon } from "../../../_components/icon";
import { Badge, DeniedState, EmptyState, PageHead } from "../../../_components/ui";
import { fmtTime } from "../../../_lib/labels";
import { learning } from "../../../_lib/learning";
import { AUDIENCE_LABEL, COURSE_KIND, COURSE_STATUS, VOD_STATUS } from "../../../_lib/learning-labels";
import { requireUser } from "../../../_lib/session";
import { denied, LearningTabs, qs } from "../_shared";

type Q = { status?: string | undefined; kind?: string | undefined; q?: string | undefined; offset?: string | undefined };
const STATUS_CHIPS: Array<[string, string]> = [["all", "全部状态"], ["published", "已发布"], ["unpublished", "已下架"], ["archived", "已归档"]];
const KIND_CHIPS: Array<[string, string]> = [["all", "全部类型"], ["video", "视频"], ["document", "资料"]];

export default async function ManagePage({ searchParams }: { searchParams: Promise<Q> }) {
  const ctx = await requireUser();
  if (!ctx.capabilities.has("learning.manage")) return <DeniedState text="课程管理需要「维护课程与资料」权限；请联系平台管理员或总部管理员补充授权。" />;
  const q = await searchParams;
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (typeof v === "string" && v && v !== "all") sp.set(k, v);
  let query;
  let result;
  try {
    query = parseManageQuery(sp);
    result = await listManageCourses(learning(), ctx, query);
  } catch (e) {
    return denied(e, "没有课程管理的范围。", "/learning");
  }
  const active = (q.status && q.status !== "all" ? 1 : 0) + (q.kind && q.kind !== "all" ? 1 : 0) + (q.q ? 1 : 0);
  const href = (patch: Partial<Q>) => qs("/learning/manage", { ...q, offset: undefined, ...patch });
  const chip = (group: "status" | "kind", value: string, label: string) => (
    <Link key={value} className={`chip ${(q[group] ?? "all") === value ? "active" : ""}`} href={href({ [group]: value })} scroll={false}>{label}</Link>
  );
  const offset = query.offset;
  const page = (o: number) => qs("/learning/manage", { ...q, offset: o > 0 ? String(o) : undefined });

  return (
    <>
      <PageHead
        title="课程管理"
        sub="保存即发布；替换文件直接覆盖、不保留旧版本；下架满 30 天自动归档并删除媒体。"
        actions={<Link className="btn btn-primary" href="/learning/manage/new"><Icon name="plus" /> 新建课程</Link>}
      />
      <LearningTabs caps={ctx.capabilities} active="manage" />
      <FilterCard activeCount={active}>
        <div className="filter-line"><span className="filter-label">状态</span>{STATUS_CHIPS.map(([v, l]) => chip("status", v, l))}</div>
        <div className="filter-line"><span className="filter-label">类型</span>{KIND_CHIPS.map(([v, l]) => chip("kind", v, l))}</div>
      </FilterCard>
      <div className="result-bar">
        <span>本页 <strong>{result.items.length}</strong> 门课程</span>
        <span className="hint">含已下架、已归档与转码中的课程；学员侧只显示已发布且可播放的。</span>
      </div>
      {result.items.length === 0 ? (
        <EmptyState
          title={active ? "没有符合条件的课程" : "还没有课程"}
          text={active ? "换个状态或类型筛选。" : "新建第一门课程；保存即对范围内学员可见。"}
          action={active ? <Link className="btn" href="/learning/manage">清空筛选</Link> : <Link className="btn btn-primary" href="/learning/manage/new">新建课程</Link>}
        />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>课程</th><th>类型</th><th>品牌范围</th><th>适用人员</th><th>标签</th><th>状态</th><th>更新时间</th><th className="right">操作</th></tr>
            </thead>
            <tbody>
              {result.items.map((c) => {
                const s = COURSE_STATUS[c.status]!;
                const vod = c.kind === "video" && c.vodVideoStatus && c.vodVideoStatus !== "normal" ? VOD_STATUS[c.vodVideoStatus] : undefined;
                return (
                  <tr key={c.courseId}>
                    <td><div className="cell-main">{c.title}</div></td>
                    <td><Badge tone="plain">{COURSE_KIND[c.kind]!.label}</Badge></td>
                    <td>{c.brandScope === "all" ? "全部品牌" : c.brandNames.join("、")}</td>
                    <td>{AUDIENCE_LABEL[c.audienceLevel]}</td>
                    <td className="nowrap">{c.tags.map((t) => <span key={t.tagId} className="tag">{t.name}</span>)}</td>
                    <td className="nowrap"><span className="status-pair"><Badge tone={s.tone}>{s.label}</Badge>{vod ? <Badge tone={vod.tone}>{vod.label}</Badge> : null}</span></td>
                    <td className="num nowrap">{fmtTime(c.updatedAt)}</td>
                    <td className="right nowrap">
                      {c.status === "archived" ? (
                        <span className="cell-sub">不可编辑</span>
                      ) : (
                        <>
                          <Link className="btn btn-sm" href={`/learning/manage/${c.courseId}`}>编辑</Link>{" "}
                          {c.status === "published" ? (
                            <ConfirmAction label="下架" title={`下架「${c.title}」`} confirmLabel="下架课程" action={unpublishAction.bind(null, c.courseId)} doneMessage="已下架，学员列表不再显示">
                              <p>下架是全局的：所有品牌的学员列表立即不再显示这门课，已持有的链接下一次访问被拒绝。学习进度保留。</p>
                              <p>下架 30 天内可以重新上架；<strong>满 30 天自动归档并删除视频 / 资料文件，不可恢复</strong>。</p>
                            </ConfirmAction>
                          ) : (
                            <ConfirmAction label="上架" title={`重新上架「${c.title}」`} confirmLabel="重新上架" buttonClass="btn btn-sm btn-primary" action={republishAction.bind(null, c.courseId)} doneMessage="已重新上架">
                              <p>恢复后范围内的学员立即可见，原有学习进度继续使用。下架满 30 天后不能再上架。</p>
                            </ConfirmAction>
                          )}
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="pagination">
        <span>{offset > 0 ? `从第 ${offset + 1} 条起` : "第一页"} · 每页 {query.limit} 条</span>
        <div className="pagination-actions">
          {offset > 0 ? <Link className="btn btn-sm" href={page(Math.max(0, offset - query.limit))}>上一页</Link> : <button type="button" className="btn btn-sm" disabled>上一页</button>}
          {result.hasMore ? <Link className="btn btn-sm" href={page(offset + query.limit)}>下一页</Link> : <button type="button" className="btn btn-sm" disabled>下一页</button>}
        </div>
      </div>
    </>
  );
}
