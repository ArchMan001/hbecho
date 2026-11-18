import { getManageCourse } from "../../../../../modules/learning";
import { republishAction, unpublishAction } from "../../../../_actions/learning";
import { ConfirmAction } from "../../../../_components/dialog";
import { CourseForm, ReplaceFile } from "../../../../_components/learning/course-form";
import { BackLink, Badge, Callout, DeniedState, PageHead } from "../../../../_components/ui";
import { fmtTime } from "../../../../_lib/labels";
import { learning } from "../../../../_lib/learning";
import { COURSE_STATUS, VOD_STATUS } from "../../../../_lib/learning-labels";
import { requireUser } from "../../../../_lib/session";
import { denied, LearningTabs } from "../../_shared";
import { formOptions, RAIL } from "../_form-data";

export default async function EditCoursePage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireUser();
  if (!ctx.capabilities.has("learning.manage")) return <DeniedState text="课程管理需要「维护课程与资料」权限。" home="/learning" />;
  const { id } = await params;
  let c;
  try {
    c = await getManageCourse(learning(), ctx, id);
  } catch (e) {
    return denied(e, "课程不存在，或不在你的维护范围内。", "/learning/manage");
  }
  const o = await formOptions(ctx);
  const s = COURSE_STATUS[c.status]!;
  const vod = c.kind === "video" && c.vodVideoStatus && c.vodVideoStatus !== "normal" ? VOD_STATUS[c.vodVideoStatus] : undefined;
  return (
    <>
      <BackLink href="/learning/manage">返回课程管理</BackLink>
      <PageHead
        title={<span style={{ display: "inline-flex", gap: 9, alignItems: "center", flexWrap: "wrap" }}>编辑课程 <Badge tone={s.tone}>{s.label}</Badge>{vod ? <Badge tone={vod.tone}>{vod.label}</Badge> : null}</span>}
        sub="修改直接生效并记审计；品牌减少时，已不在范围内的学员立即看不到这门课，历史进度保留。"
        actions={
          c.status === "published" ? (
            <ConfirmAction label="下架" title={`下架「${c.title}」`} confirmLabel="下架课程" action={unpublishAction.bind(null, c.courseId)} doneMessage="已下架，学员列表不再显示" after="/learning/manage">
              <p>下架是全局的：所有品牌的学员列表立即不再显示这门课，已持有的链接下一次访问被拒绝。学习进度保留。</p>
              <p>下架 30 天内可以重新上架；<strong>满 30 天自动归档并删除视频 / 资料文件，不可恢复</strong>。</p>
            </ConfirmAction>
          ) : (
            <ConfirmAction label="重新上架" buttonClass="btn btn-primary" title={`重新上架「${c.title}」`} confirmLabel="重新上架" action={republishAction.bind(null, c.courseId)} doneMessage="已重新上架" after="/learning/manage">
              <p>恢复后范围内的学员立即可见，原有学习进度继续使用。</p>
            </ConfirmAction>
          )
        }
      />
      <LearningTabs caps={ctx.capabilities} active="manage" />
      {c.status === "unpublished" && c.archiveAt ? (
        <Callout icon="clock" tone="warn" style={{ marginBottom: 16 }}>这门课已下架，将在 {fmtTime(c.archiveAt)} 自动归档：删除视频 / 资料文件，之后不能再上架。</Callout>
      ) : null}
      <div className="wizard-layout">
        <div>
          <CourseForm
            brands={o.brands}
            categories={o.categories}
            limits={o.limits}
            initial={{ courseId: c.courseId, kind: c.kind, title: c.title, description: c.description ?? "", brandScope: c.brandScope, brandIds: c.brandIds, audienceLevel: c.audienceLevel, allowDownload: c.allowDownload, tagIds: c.tagIds, coverUrl: c.coverUrl }}
          />
          <ReplaceFile courseId={c.courseId} kind={c.kind} limits={{ docMaxBytes: o.limits.docMaxBytes, videoMaxBytes: o.limits.videoMaxBytes }} />
        </div>
        <aside className="wizard-rail" aria-label="编辑说明">
          {RAIL.map((r) => (
            <div key={r.kicker} className="rail-card"><div className="rail-kicker">{r.kicker}</div><div className="rail-title">{r.title}</div><div className="rail-text">{r.text}</div></div>
          ))}
        </aside>
      </div>
    </>
  );
}
