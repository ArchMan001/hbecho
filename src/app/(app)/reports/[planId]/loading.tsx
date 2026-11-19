import { ListSkeleton } from "../../../_components/ui";
// 加载态：顶部信息条与表格骨架（design §10.4），不用全屏遮罩。
export default function Loading() {
  return (
    <>
      <div className="skeleton skeleton-line" style={{ width: "40%", height: 28, marginBottom: 16 }} />
      <ListSkeleton rows={10} />
    </>
  );
}
