import Link from "next/link";
import { listCourses, listTags, parseListQuery } from "../../../modules/learning";
import { FilterCard } from "../../_components/filter-card";
import { Icon } from "../../_components/icon";
import { DeniedState, EmptyState, PageHead } from "../../_components/ui";
import { learning } from "../../_lib/learning";
import { clock, COURSE_KIND, MIME_LABEL } from "../../_lib/learning-labels";
import { fmtTime } from "../../_lib/labels";
import { requireUser } from "../../_lib/session";
import { Cover, denied, LearningTabs, qs } from "./_shared";

type Q = { q?: string | undefined; tag?: string | undefined; inProgress?: string | undefined; offset?: string | undefined };

export default async function LearningPage({ searchParams }: { searchParams: Promise<Q> }) {
  const ctx = await requireUser();
  if (!ctx.capabilities.has("learning.read")) return <DeniedState text="当前账号没有学习入口。" />;
  const q = await searchParams;
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (typeof v === "string" && v) sp.set(k, v);
  const filtersActive = (q.q ? 1 : 0) + (q.tag ? 1 : 0) + (q.inProgress ? 1 : 0);

  let result;
  let tags;
  let query;
  try {
    const deps = learning();
    query = parseListQuery(sp);
    [result, tags] = await Promise.all([listCourses(deps, ctx, query), listTags(deps, ctx)]);
  } catch (e) {
    return denied(e, "你的账号没有可见的学习范围。请联系平台管理员确认你的品牌与人员范围。", "/");
  }
  const canManage = ctx.capabilities.has("learning.manage");
  const offset = query.offset;
  const pageHref = (o: number) => qs("/learning", { ...q, offset: o > 0 ? String(o) : undefined });

  return (
    <>
      <PageHead title="学习中心" sub="只显示你品牌范围内的已发布课程；可以按标签筛选或搜索标题。" />
      <LearningTabs caps={ctx.capabilities} active="center" />
      <FilterCard activeCount={filtersActive}>
        <form className="filter-line" method="get" action="/learning" aria-label="课程筛选">
          <label className="course-search">
            <Icon name="search" />
            <input type="search" name="q" defaultValue={q.q ?? ""} placeholder="搜索课程标题" aria-label="搜索课程标题" />
          </label>
          <label className="filter-select">
            <span>标签</span>
            <select name="tag" defaultValue={q.tag ?? ""}>
              <option value="">全部标签</option>
              {tags.map((t) => (
                <option key={t.tagId} value={t.tagId}>{t.name}</option>
              ))}
            </select>
          </label>
          <label className={`chip ${q.inProgress ? "active" : ""}`}>
            <input type="checkbox" name="inProgress" value="1" defaultChecked={Boolean(q.inProgress)} style={{ accentColor: "#0FA3A8" }} /> 只看在学
          </label>
          <button type="submit" className="btn btn-sm">筛选</button>
          {filtersActive ? <Link className="btn btn-sm btn-ghost" href="/learning">清空</Link> : null}
        </form>
      </FilterCard>
      <div className="result-bar">
        <span>本页 <strong>{result.items.length}</strong> 门课程</span>
        <span className="hint">按最近更新排序</span>
      </div>
      {result.items.length === 0 ? (
        <EmptyState
          title={filtersActive ? "没有符合条件的课程" : "本品牌还没有课程"}
          text={filtersActive ? "换个关键词或标签；也可以清空筛选。" : canManage ? "课程由总部维护；可以先新建一门课。" : "等总部发布课程后会出现在这里。"}
          action={canManage && !filtersActive ? <Link className="btn btn-primary" href="/learning/manage/new">新建课程</Link> : filtersActive ? <Link className="btn" href="/learning">清空筛选</Link> : undefined}
        />
      ) : (
        <div className="course-grid">
          {result.items.map((c) => {
            const kind = COURSE_KIND[c.kind]!;
            return (
              <Link key={c.courseId} className="course-card" href={`/learning/${c.courseId}`}>
                <div className={`course-cover is-${c.kind}`}>
                  <Cover url={c.coverUrl} />
                  <span className="course-kind"><Icon name={kind.icon} /></span>
                  {c.kind === "video" && c.durationSec ? <span className="course-duration">{clock(c.durationSec)}</span> : null}
                </div>
                <div className="course-body">
                  <div className="course-title">{c.title}</div>
                  <div className="course-tags">{c.tags.map((t) => <span key={t.tagId} className="tag">{t.name}</span>)}</div>
                  <div className="course-meta"><span>{kind.label}</span><span>更新 {fmtTime(c.updatedAt)}</span></div>
                  {c.inProgress ? (
                    <div className="course-progress"><Icon name="play" /><span>在学 · 最近学习 {fmtTime(c.lastLearnedAt)}</span></div>
                  ) : null}
                </div>
              </Link>
            );
          })}
        </div>
      )}
      <div className="pagination">
        <span>{offset > 0 ? `从第 ${offset + 1} 门起` : "第一页"} · 每页 {query.limit} 门</span>
        <div className="pagination-actions">
          {offset > 0 ? <Link className="btn btn-sm" href={pageHref(Math.max(0, offset - query.limit))}>上一页</Link> : <button type="button" className="btn btn-sm" disabled>上一页</button>}
          {result.hasMore ? <Link className="btn btn-sm" href={pageHref(offset + query.limit)}>下一页</Link> : <button type="button" className="btn btn-sm" disabled>下一页</button>}
        </div>
      </div>
    </>
  );
}
