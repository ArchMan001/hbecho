// 广场卡片与封面（服务端渲染）：卡片只露出标题、点赞、评论、品牌标签、账号名，加封面、平台与类型角标（requirements D3、R5）。
import type { ReactNode } from "react";
import type { SquareCard } from "../../../modules/video-square";
import { Icon } from "../../_components/icon";
import { AiButton } from "../../_components/square";
import { brandTone, fmtCount } from "../../_lib/square-url";

/** 封面：签名地址是短期的私有桶地址，不走 next/image 的优化代理；没有封面（或签名失败）用类型图标占位。 */
export function Cover({ card, large = false, children }: { card: Pick<SquareCard, "coverUrl" | "kind">; large?: boolean; children?: ReactNode }) {
  const icon = card.kind === "video" ? "play" : "layers";
  return (
    <div className={`sq-cover ${large ? "sq-cover-lg" : ""}`}>
      {card.coverUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img className="sq-cover-img" src={card.coverUrl} alt="" loading="lazy" referrerPolicy="no-referrer" />
      ) : (
        <span className="sq-cover-empty">
          <Icon name={icon} />
        </span>
      )}
      <span className="sq-kind">
        <Icon name={icon} />
        {card.kind === "video" ? "视频" : "图文"}
      </span>
      {children}
    </div>
  );
}

/** 「观看」：新标签页打开原链接；没有可用链接时置灰。 */
export function WatchButton({ url, className = "btn btn-sm", withIcon = false }: { url: string | null; className?: string; withIcon?: boolean }) {
  const body = (
    <>
      {withIcon ? <Icon name="external" /> : null} 观看
    </>
  );
  return url ? (
    <a className={className} href={url} target="_blank" rel="noopener noreferrer">
      {body}
    </a>
  ) : (
    <button type="button" className={className} disabled title="该作品没有可用的原链接">
      {body}
    </button>
  );
}

export function Card({ card }: { card: SquareCard }) {
  return (
    <article className="sq-card">
      <Cover card={card}>
        <span className="sq-platform">{card.platform.name}</span>
        <div className="sq-hover">
          <WatchButton url={card.watchUrl} withIcon />
          <AiButton contentId={card.contentId} withIcon />
        </div>
      </Cover>
      <div className="sq-body">
        <h3 className="sq-title" title={card.title}>{card.title}</h3>
        <div className="sq-meta">
          <span className="sq-stat" title="点赞"><Icon name="thumb" /><span className="num">{fmtCount(card.likeCount)}</span></span>
          <span className="sq-stat" title="评论"><Icon name="comment" /><span className="num">{card.commentCount === null ? "—" : fmtCount(card.commentCount)}</span></span>
          <span className={`sq-brand sq-brand-${brandTone(card.brand.name)}`}>{card.brand.name}</span>
        </div>
        <div className="sq-account" title={card.accountName ?? ""}>{card.accountName ?? "—"}</div>
      </div>
      <div className="sq-actions-touch">
        <WatchButton url={card.watchUrl} />
        <AiButton contentId={card.contentId} className="btn btn-sm" />
      </div>
    </article>
  );
}
