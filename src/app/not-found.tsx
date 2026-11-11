import Link from "next/link";
import { Icon } from "./_components/icon";

export default function NotFound() {
  return (
    <main className="page" style={{ maxWidth: 560, margin: "12vh auto" }}>
      <div className="card">
        <div className="state">
          <div className="state-icon"><Icon name="file" /></div>
          <div className="state-title">页面不存在</div>
          <p className="state-text">地址可能输错了，或页面已经移走。</p>
          <Link className="btn" href="/">回到首页</Link>
        </div>
      </div>
    </main>
  );
}
