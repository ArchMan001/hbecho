// 分页条（服务端渲染，链接即状态）。只有一页时不显示。
import Link from "next/link";

export function Pager({ page, pages, href }: { page: number; pages: number; href: (page: number) => string }) {
  if (pages <= 1) return null;
  return (
    <div className="result-bar" style={{ marginTop: 12 }}>
      <span>
        第 <strong>{page}</strong> / {pages} 页
      </span>
      <span style={{ display: "flex", gap: 8 }}>
        {page > 1 ? <Link className="btn btn-sm" href={href(page - 1)}>上一页</Link> : <button type="button" className="btn btn-sm" disabled>上一页</button>}
        {page < pages ? <Link className="btn btn-sm" href={href(page + 1)}>下一页</Link> : <button type="button" className="btn btn-sm" disabled>下一页</button>}
      </span>
    </div>
  );
}
