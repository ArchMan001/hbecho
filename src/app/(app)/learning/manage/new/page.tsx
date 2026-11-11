import { CourseForm } from "../../../../_components/learning/course-form";
import { BackLink, DeniedState, PageHead } from "../../../../_components/ui";
import { requireUser } from "../../../../_lib/session";
import { LearningTabs } from "../../_shared";
import { formOptions, RAIL } from "../_form-data";

export default async function NewCoursePage() {
  const ctx = await requireUser();
  if (!ctx.capabilities.has("learning.manage")) return <DeniedState text="课程管理需要「维护课程与资料」权限。" home="/learning" />;
  const o = await formOptions(ctx);
  return (
    <>
      <BackLink href="/learning/manage">返回课程管理</BackLink>
      <PageHead title="新建课程" sub="保存即发布，没有草稿与审核；品牌范围、人员级别、标签、封面与文件决定学员能否看到。" />
      <LearningTabs caps={ctx.capabilities} active="manage" />
      <div className="wizard-layout">
        <CourseForm brands={o.brands} tags={o.tags} limits={o.limits} />
        <aside className="wizard-rail" aria-label="发布说明">
          {RAIL.map((r) => (
            <div key={r.kicker} className="rail-card"><div className="rail-kicker">{r.kicker}</div><div className="rail-title">{r.title}</div><div className="rail-text">{r.text}</div></div>
          ))}
        </aside>
      </div>
    </>
  );
}
