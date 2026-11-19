// 「AI分析」界面示意（design §10、U5：已确认要做）：静态占位，不发请求、不写数据；输入框与发送按钮不可用。
// 作品信息按广场同一套可见条件读取；不可见或不存在一律 404，不区分原因。
import Link from "next/link";
import { notFound } from "next/navigation";
import { get, isSquareError } from "../../../../../modules/video-square";
import { Icon } from "../../../../_components/icon";
import { Callout, DeniedState, PageHead } from "../../../../_components/ui";
import { requireUser } from "../../../../_lib/session";
import { square } from "../../../../_lib/square";
import { brandTone, daysAgo, fmtCount } from "../../../../_lib/square-url";
import { Cover, WatchButton } from "../../_card";

const ANALYZE = [
  ["内容亮点", ["开头 3 秒点出利益点（示例）", "门店场景真实，口语化表达（示例）"], "ul"],
  ["结构拆解", ["钩子：抛出问题", "主体：产品卖点与场景演示", "结尾：引导咨询或到店"], "ol"],
  ["可改进之处", ["字幕与话题可更聚焦（示例）"], "ul"],
  ["给你的建议", ["可参考其开场方式，换成本店真实案例（示例）"], "ul"],
] as const;
const REWRITE = [
  ["仿写标题（示例）", ["换成本店案例的标题写法", "保留原作品的提问式开头"], "ul"],
  ["仿写脚本（示例）", ["开场：门店场景 + 一个问题", "主体：本店主推产品的三个卖点", "结尾：引导咨询或到店"], "ol"],
  ["拍摄建议（示例）", ["时长控制在 30 秒内", "字幕与话题聚焦一个主题"], "ul"],
  ["话题与文案（示例）", ["3 个相关话题标签", "一段可直接发布的文案"], "ul"],
] as const;

export default async function SquareAiPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string }> }) {
  const ctx = await requireUser();
  if (!ctx.capabilities.has("square.read")) return <DeniedState text="当前账号没有视频广场入口。" />;
  const { id } = await params;
  const rewrite = (await searchParams).tab === "rewrite";
  if (!/^[1-9][0-9]{0,18}$/.test(id) || BigInt(id) > 9_223_372_036_854_775_807n) notFound();
  let card;
  try {
    card = await get(square(), ctx, BigInt(id));
  } catch (e) {
    if (isSquareError(e) && e.kind === "not_found") notFound();
    if (isSquareError(e) && e.kind === "auth") return <DeniedState text="当前账号没有视频广场入口，或没有可见的品牌范围。" />;
    throw e;
  }
  const blocks = rewrite ? REWRITE : ANALYZE;
  const tab = (active: boolean, label: string, to: string) => (
    <Link className={`sq-bigtab ${active ? "active" : ""}`} role="tab" aria-selected={active} href={to} scroll={false}>
      <span className="sq-bigtab-title">{label}</span>
    </Link>
  );
  return (
    <>
      <PageHead
        title="AI分析"
        sub="界面示意：AI分析与仿写功能正在开发中，下面的内容是占位示例，不是真实分析结果。"
        actions={
          <Link className="btn" href="/square">
            <Icon name="arrowLeft" /> 返回广场
          </Link>
        }
      />
      <Callout icon="clock" tone="warn" style={{ marginBottom: 14 }}>功能正在开发中：按钮与输入框暂不可用。</Callout>
      <div className="sq-ai">
        <aside className="card sq-ai-info" aria-label="作品信息">
          <Cover card={card} large />
          <div className="card-pad">
            <h2 className="sq-ai-title">{card.title}</h2>
            <dl className="sq-ai-dl">
              <div><dt>品牌</dt><dd><span className={`sq-brand sq-brand-${brandTone(card.brand.name)}`}>{card.brand.name}</span></dd></div>
              <div><dt>平台</dt><dd>{card.platform.name}</dd></div>
              <div><dt>账号</dt><dd>{card.accountName ?? "—"}</dd></div>
              <div><dt>分公司</dt><dd>{card.branchName}</dd></div>
              <div><dt>点赞</dt><dd className="num">{fmtCount(card.likeCount)}</dd></div>
              <div><dt>评论</dt><dd className="num">{card.commentCount === null ? "—" : fmtCount(card.commentCount)}</dd></div>
              <div><dt>发布</dt><dd>{daysAgo(card.publishedAt, Date.now())}</dd></div>
            </dl>
            <WatchButton url={card.watchUrl} className="btn" withIcon />
          </div>
        </aside>
        <section className="card sq-ai-main" aria-label="AI分析">
          <div className="sq-bigtabs sq-bigtabs-inner" role="tablist" aria-label="AI功能">
            {tab(!rewrite, "AI分析作品内容", `/square/${id}/ai`)}
            {tab(rewrite, "AI仿写", `/square/${id}/ai?tab=rewrite`)}
          </div>
          <div className="sq-ai-out">
            {blocks.map(([title, lines, kind]) => {
              const Tag = kind;
              return (
                <div key={title} className="sq-ai-block">
                  <h3>{title}</h3>
                  <Tag>{lines.map((l) => <li key={l}>{l}</li>)}</Tag>
                </div>
              );
            })}
          </div>
          <div className="sq-ai-input">
            <input className="input" type="text" placeholder="向 AI 提问，例如：这条视频的开头为什么有效？" disabled aria-label="向 AI 提问" />
            <button type="button" className="btn btn-primary" disabled>
              <Icon name="send" /> 发送
            </button>
          </div>
        </section>
      </div>
    </>
  );
}
