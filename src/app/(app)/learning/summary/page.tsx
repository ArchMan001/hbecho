import Link from "next/link";
import { getSummary } from "../../../../modules/learning";
import { Icon } from "../../../_components/icon";
import { DeniedState, PageHead } from "../../../_components/ui";
import { learning } from "../../../_lib/learning";
import { requireUser } from "../../../_lib/session";
import { denied, LearningTabs } from "../_shared";

const nf = new Intl.NumberFormat("zh-CN");

export default async function SummaryPage({ searchParams }: { searchParams: Promise<{ brand?: string | undefined }> }) {
  const ctx = await requireUser();
  if (!ctx.capabilities.has("learning.report.read")) return <DeniedState text="学习汇总只有总部与平台超管可见；请联系平台管理员开通学习汇总权限。" home="/learning" />;
  const { brand } = await searchParams;
  let s;
  try {
    s = await getSummary(learning(), ctx, brand ? { brandId: brand } : {});
  } catch (e) {
    return denied(e, "没有可汇总的范围，或所选品牌不在你的范围内。", "/learning");
  }
  const scopeText = s.mode === "merged" ? "合计（已去重）" : (s.brandOptions.find((b) => b.brandId === s.brandId)?.name ?? "单品牌");
  const hours = (s.watchedSeconds / 3600).toLocaleString("zh-CN", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return (
    <>
      <PageHead title="学习汇总" sub="累计总量；不提供按人、门店或课程的明细，也不提供导出。" />
      <LearningTabs caps={ctx.capabilities} active="summary" />
      <div className="summary-band" aria-label="汇总口径">
        <div>
          <div className="summary-title">{scopeText} · 累计</div>
          <div className="summary-sub">含已下架课程的历史；课程数只算已发布且可播放。</div>
        </div>
        <div className="summary-metrics">
          <div className="summary-metric"><span>{nf.format(s.courseCount)}</span><small>课程数</small></div>
          <div className="summary-metric"><span>{nf.format(s.learnerCount)}</span><small>学习人数</small></div>
          <div className="summary-metric"><span>{hours}</span><small>累计观看（小时）</small></div>
          <div className="summary-metric"><span>{nf.format(s.playCount)}</span><small>累计播放（次）</small></div>
        </div>
      </div>
      {s.brandOptions.length > 1 ? (
        <div className="filter-bar">
          <span className="filter-note" style={{ marginLeft: 0 }}>范围</span>
          <Link className={`chip ${s.mode === "merged" ? "active" : ""}`} href="/learning/summary">{`全部品牌${s.mode === "merged" ? "（已去重）" : ""}`}</Link>
          {s.brandOptions.map((b) => (
            <Link key={b.brandId} className={`chip ${s.brandId === b.brandId ? "active" : ""}`} href={`/learning/summary?brand=${b.brandId}`}>{b.name}</Link>
          ))}
        </div>
      ) : null}
      <div className="note-list" aria-label="汇总口径">
        <div className="note-item"><Icon name="clock" /><span><strong>累计只增不减：</strong>学习人数、累计观看与播放次数统计所有课程（含已下架与已归档）；只有课程数只算已发布且可播放。</span></div>
        <div className="note-item"><Icon name="users" /><span><strong>学习人数按登录账号去重：</strong>换门店会重建账号，同一自然人可能计两次；合计已去重，单品牌之间不可直接相加。</span></div>
        <div className="note-item"><Icon name="play" /><span><strong>播放次数 = 开始播放的次数：</strong>续播重新打开也计一次，暂停后继续不计；它不等于观看人数。</span></div>
        <div className="note-item"><Icon name="alert" /><span><strong>观看时长来自播放心跳：</strong>不含资料预览；锁屏与切后台不计时，宁少算不高估，<strong>观看时长不可作为考核依据</strong>。</span></div>
      </div>
    </>
  );
}
