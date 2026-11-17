import { listTagTree } from "../../../../modules/learning";
import { TagManager } from "../../../_components/learning/tag-manager";
import { Callout, DeniedState, PageHead } from "../../../_components/ui";
import { learning } from "../../../_lib/learning";
import { requireUser } from "../../../_lib/session";
import { denied, LearningTabs } from "../_shared";

export default async function TagsPage() {
  const ctx = await requireUser();
  if (!ctx.capabilities.has("learning.tag.manage")) return <DeniedState text="标签集合只有平台超管可以维护；请联系平台管理员处理。" home="/learning" />;
  let categories;
  try {
    categories = await listTagTree(learning(), ctx, { withCounts: true });
  } catch (e) {
    return denied(e, "没有标签管理权限。", "/learning");
  }
  return (
    <>
      <PageHead title="标签管理" sub="两级标签：一级标签、二级标签都由平台超管维护，课程只能选择；被引用的二级标签不能删除。" />
      <LearningTabs caps={ctx.capabilities} active="tags" />
      {categories.every((c) => c.tags.length === 0) ? <Callout icon="alert" style={{ marginBottom: 12 }}>还没有二级标签。先新建一级标签，再在它下面新建二级标签，课程才能保存（每门课至少选一个二级标签）。</Callout> : null}
      <TagManager
        categories={categories.map((c) => ({
          categoryId: c.categoryId,
          name: c.name,
          courseCount: c.courseCount ?? 0,
          tags: c.tags.map((t) => ({ tagId: t.tagId, name: t.name, courseCount: t.courseCount ?? 0 })),
        }))}
      />
      <Callout icon="shield" style={{ marginTop: 14 }}>二级标签名暂时全局唯一；一级标签下还有二级标签时不能删除；改名不影响课程引用。学习中心的筛选项按这里的一级标签生成。</Callout>
    </>
  );
}
