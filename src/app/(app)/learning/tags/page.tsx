import { listTags } from "../../../../modules/learning";
import { TagManager } from "../../../_components/learning/tag-manager";
import { Callout, DeniedState, PageHead } from "../../../_components/ui";
import { learning } from "../../../_lib/learning";
import { requireUser } from "../../../_lib/session";
import { denied, LearningTabs } from "../_shared";

export default async function TagsPage() {
  const ctx = await requireUser();
  if (!ctx.capabilities.has("learning.tag.manage")) return <DeniedState text="标签集合只有平台超管可以维护；请联系平台管理员处理。" home="/learning" />;
  let tags;
  try {
    tags = await listTags(learning(), ctx, { withCounts: true });
  } catch (e) {
    return denied(e, "没有标签管理权限。", "/learning");
  }
  return (
    <>
      <PageHead title="标签管理" sub="标签是平台超管维护的预设集合；课程只能选择，不能新建。被引用的标签不能删除。" />
      <LearningTabs caps={ctx.capabilities} active="tags" />
      {tags.length === 0 ? <Callout icon="alert" style={{ marginBottom: 12 }}>还没有标签。先新建几个，课程才能保存（每门课至少选一个标签）。</Callout> : null}
      <TagManager tags={tags.map((t) => ({ tagId: t.tagId, name: t.name, courseCount: t.courseCount ?? 0 }))} />
      <Callout icon="shield" style={{ marginTop: 14 }}>删除被引用的标签会被拒绝并显示引用数；课程未选任何标签不能保存。</Callout>
    </>
  );
}
