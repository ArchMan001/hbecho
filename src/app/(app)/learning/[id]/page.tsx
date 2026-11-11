import { getCourse } from "../../../../modules/learning";
import { BackLink, Badge, Callout, PageHead } from "../../../_components/ui";
import { CoursePlayer } from "../../../_components/learning/course-player";
import { DocumentView } from "../../../_components/learning/document-view";
import { fmtTime } from "../../../_lib/labels";
import { learning } from "../../../_lib/learning";
import { AUDIENCE_LABEL, clock, COURSE_KIND, fileSize, MIME_LABEL, VOD_STATUS } from "../../../_lib/learning-labels";
import { requireUser } from "../../../_lib/session";
import { DeniedState } from "../../../_components/ui";
import { denied } from "../_shared";

export default async function CourseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireUser();
  if (!ctx.capabilities.has("learning.read")) return <DeniedState text="当前账号没有学习入口。" />;
  const { id } = await params;
  let c;
  try {
    c = await getCourse(learning(), ctx, id);
  } catch (e) {
    return denied(e, "课程不存在、已下架，或不在你的品牌范围内。请联系平台管理员确认你的品牌与人员范围。");
  }
  const kind = COURSE_KIND[c.kind]!;
  const vod = c.vodVideoStatus && c.vodVideoStatus !== "normal" ? VOD_STATUS[c.vodVideoStatus] : undefined;
  const license = process.env.HBECHO_PLAYER_LICENSE_DOMAIN && process.env.HBECHO_PLAYER_LICENSE_KEY ? { domain: process.env.HBECHO_PLAYER_LICENSE_DOMAIN, key: process.env.HBECHO_PLAYER_LICENSE_KEY } : undefined;
  const scope = c.brandScope === "all" ? "全部品牌" : "指定品牌";
  return (
    <>
      <BackLink href="/learning">返回学习中心</BackLink>
      <PageHead
        title={
          <span style={{ display: "inline-flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
            {c.title} <span className="tag">{kind.label}</span> {vod ? <Badge tone={vod.tone}>{vod.label}</Badge> : null}
          </span>
        }
        sub={`${scope} · ${AUDIENCE_LABEL[c.audienceLevel]} · 更新 ${fmtTime(c.updatedAt)} · 上传者 ${c.createdByName ?? "—"}`}
      />
      <div className="detail-grid">
        <div className="card detail-main">
          <div className="card-pad">
            {c.kind === "video" ? (
              <CoursePlayer courseId={c.courseId} durationSec={c.durationSec} positionSec={c.positionSec} vodVideoStatus={c.vodVideoStatus} license={license} />
            ) : (
              <DocumentView courseId={c.courseId} mime={c.fileMime ?? "application/pdf"} title={c.title} />
            )}
            <div className="course-tags" style={{ marginTop: 16 }}>{c.tags.map((t) => <span key={t.tagId} className="tag">{t.name}</span>)}</div>
            <p className="course-detail-desc">{c.description}</p>
            <div className="info-grid" style={{ marginTop: 18 }}>
              <div><div className="info-label">类型</div><div className="info-value">{kind.label}{c.fileMime ? ` · ${MIME_LABEL[c.fileMime] ?? ""}` : ""}</div></div>
              <div><div className="info-label">{c.kind === "video" ? "时长" : "文件大小"}</div><div className="info-value num">{c.kind === "video" ? (c.durationSec ? clock(c.durationSec) : "—") : fileSize(c.fileSize)}</div></div>
              <div><div className="info-label">上传者</div><div className="info-value">{c.createdByName ?? "—"}</div></div>
              <div><div className="info-label">品牌范围</div><div className="info-value">{scope}</div></div>
              <div><div className="info-label">适用人员</div><div className="info-value">{AUDIENCE_LABEL[c.audienceLevel]}</div></div>
              <div><div className="info-label">最近更新</div><div className="info-value num">{fmtTime(c.updatedAt)}</div></div>
            </div>
            {c.kind === "document" ? (
              <Callout icon="shield" style={{ marginTop: 14 }}>预览与下载是两个动作：预览不记审计，下载会记录谁、何时、哪门课与文件标识。</Callout>
            ) : null}
          </div>
        </div>
        <aside className="detail-rail" aria-label="学习进度">
          <div className="rail-card">
            <div className="rail-kicker">我的进度</div>
            <div className="rail-title">{c.inProgress ? (c.kind === "video" && c.positionSec > 0 ? `看到 ${clock(c.positionSec)}` : "已开始学习") : "还没开始"}</div>
            <div className="rail-list">
              <div className="rail-row"><span>最近学习</span><strong className="num">{fmtTime(c.lastLearnedAt)}</strong></div>
              {c.kind === "video" ? (
                <>
                  <div className="rail-row"><span>累计观看</span><strong className="num">{clock(c.watchedSec)}</strong></div>
                  <div className="rail-row"><span>播放次数</span><strong className="num">{c.playCount}</strong></div>
                </>
              ) : (
                <div className="rail-row"><span>打开次数</span><strong className="num">{c.playCount}</strong></div>
              )}
            </div>
            <div className="rail-text">学习进度按账号记录，换设备以服务端记录为准；本课程不设完成标记。</div>
          </div>
        </aside>
      </div>
    </>
  );
}
