// 加载态：20 块卡片骨架，保留网格结构，不用全屏遮罩（design §10.4、ui-foundation §5）。
export default function Loading() {
  return (
    <div className="sq-grid" aria-busy="true" aria-label="加载中">
      {Array.from({ length: 20 }).map((_, i) => (
        <div key={i} className="sq-skel-card">
          <div className="skeleton skeleton-block" />
          <div className="skeleton skeleton-line" style={{ width: "80%" }} />
          <div className="skeleton skeleton-line" style={{ width: "55%" }} />
        </div>
      ))}
    </div>
  );
}
