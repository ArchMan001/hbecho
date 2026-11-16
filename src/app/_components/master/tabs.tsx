import Link from "next/link";

/** 主数据区的「浏览 ⇄ 导入」切换（a-master-data-browse design §16.1，2026-11-16 确认）。 */
export function MasterTabs({ active }: { active: "browse" | "import" }) {
  const cls = (key: typeof active) => `chip${active === key ? " active" : ""}`;
  return (
    <div className="md-tabs" role="tablist" aria-label="主数据视图">
      <Link className={cls("browse")} href="/master-data" role="tab" aria-selected={active === "browse"}>
        主数据浏览
      </Link>
      <Link className={cls("import")} href="/master-data/import" role="tab" aria-selected={active === "import"}>
        主数据导入
      </Link>
    </div>
  );
}