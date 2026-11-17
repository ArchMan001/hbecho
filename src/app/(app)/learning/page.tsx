import Link from "next/link";
import { listCourses, listTagTree, parseListQuery } from "../../../modules/learning";
import { FilterCard } from "../../_components/filter-card";
import { HoverFilter } from "../../_components/hover-filter";
import { Icon } from "../../_components/icon";
import { DeniedState, EmptyState, PageHead } from "../../_components/ui";
import { learning } from "../../_lib/learning";
import { clock, COURSE_KIND, MIME_LABEL } from "../../_lib/learning-labels";
import { fmtTime } from "../../_lib/labels";
import { hrefMulti, valuesOf, type Params } from "../../_lib/multi-url";
import { requireUser, web } from "../../_lib/session";
import { Cover, denied, LearningTabs } from "./_shared";

type Q = Params;

export default async function LearningPage({ searchParams }: { searchParams: Promise<Q> }) {
  const ctx = await requireUser();
  if (!ctx.capabilities.has("learning.read")) return <DeniedState text="当前账号没有学习入口。" />;
  const q = await searchParams;
  const sp = new URLSearchParams();
  for (const [k, vs] of Object.entries(q)) for (const v of valuesOf(vs)) sp.append(k, v);
  const keyword = valuesOf(q.q)[0] ?? "";
  const pickedBrand = valuesOf(q.brand)[0];
  const pickedKind = valuesOf(q.kind)[0];
  const pickedTags = valuesOf(q.tag);
  const inProgress = Boolean(valuesOf(q.inProgress)[0]);
  const filtersActive = (keyword ? 1 : 0) + pickedTags.length + (pickedBrand ? 1 : 0) + (pickedKind ? 1 : 0) + (inProgress ? 1 : 0);
  const href = (patch: Params) => hrefMulti("/learning", q, { offset: undefined, ...patch });

  let result;
  let tree;
  let query;
  let brands;
  try {
    const deps = learning();
    query = parseListQuery(sp);
    [result, tree, brands] = await Promise.all([listCourses(deps, ctx, query), listTagTree(deps, ctx), web().directory()]);
  } catch (e) {
    return denied(e, "你的账号没有可见的学习范围。请联系平台管理员确认你的品牌与人员范围。", "/");
  }
  const canManage = ctx.capabilities.has("learning.manage");
  const offset = query.offset;
  const pageHref = (o: number) => hrefMulti("/learning", q, { offset: o > 0 ? String(o) : undefined });
  const myBrands = brands.brands.filter((b) => ctx.scope.brands === "all" || ctx.scope.brands.has(BigInt(b.id)));
  /** 单选下拉：点未选项 = 选中它（同组其他项取消）；点已选项 = 取消。 */
  const single = (current: string | undefined, value: string) => (current === value ? undefined : value);

  return (
    <>
      <PageHead title="学习中心" sub="只显示你品牌范围内的已发布课程；可以按品牌、课程类型、标签筛选或搜索课程名。" />
      <LearningTabs caps={ctx.capabilities} active="center" />
      <FilterCard activeCount={filtersActive}>
        <div className="hf-row">
          <HoverFilter
            label="品牌"
            mode="single"
            options={myBrands.map((b) => ({ value: b.id, label: b.name, selected: pickedBrand === b.id, href: href({ brand: single(pickedBrand, b.id) }) }))}
            clearHref={href({ brand: undefined })}
          />
          <HoverFilter
            label="课程类型"
            mode="single"
            options={(["video", "document"] as const).map((k) => ({ value: k, label: COURSE_KIND[k]!.label, selected: pickedKind === k, href: href({ kind: single(pickedKind, k) }) }))}
            clearHref={href({ kind: undefined })}
          />
          {tree
            .filter((c) => c.tags.length > 0)
            .map((c) => {
              const ids = c.tags.map((t) => t.tagId);
              const others = pickedTags.filter((id) => !ids.includes(id));
              const mine = pickedTags.find((id) => ids.includes(id));
              return (
                <HoverFilter
                  key={c.categoryId}
                  label={c.name}
                  mode="single"
                  options={c.tags.map((t) => ({ value: t.tagId, label: t.name, selected: mine === t.tagId, href: href({ tag: mine === t.tagId ? others : [...others, t.tagId] }) }))}
                  clearHref={href({ tag: others })}
                />
              );
            })}
        </div>
        <form className="filter-line" method="get" action="/learning" aria-label="课程搜索">
          {pickedBrand ? <input type="hidden" name="brand" value={pickedBrand} /> : null}
          {pickedKind ? <input type="hidden" name="kind" value={pickedKind} /> : null}
          {pickedTags.map((id) => <input key={id} type="hidden" name="tag" value={id} />)}
          {inProgress ? <input type="hidden" name="inProgress" value="1" /> : null}
          <label className="course-search">
            <Icon name="search" />
            <input type="search" name="q" defaultValue={keyword} placeholder="搜索课程名" aria-label="搜索课程名" />
          </label>
          <button type="submit" className="btn btn-primary btn-sm">检索</button>
          <Link className={`chip ${inProgress ? "active" : ""}`} href={href({ inProgress: inProgress ? undefined : "1" })} scroll={false}>只看在学</Link>
          {filtersActive ? <Link className="btn btn-sm btn-ghost" href="/learning">清空全部</Link> : null}
          <span className="filter-note">品牌、课程类型固定；其余筛选项来自「标签管理」中的一级标签，每个下拉单选。</span>
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
