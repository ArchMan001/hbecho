import { RestorePlanButton } from "../../../_components/plans/plan-actions";
import { BackLink, Badge, Callout, DeniedState, EmptyState, PageHead } from "../../../_components/ui";
import { n, bjt, PLAN_STATUS, PLATFORM_LABEL } from "../../../_lib/plan-labels";
import { brandNameByCode } from "../../../_lib/plan-page";
import { ap, planActorOf } from "../../../_lib/plan";
import { requireUser, web } from "../../../_lib/session";

export default async function TrashPage() {
  const ctx = await requireUser();
  if (!ctx.capabilities.has("activity_plan.create")) return <DeniedState text="回收站只对计划创建者与超管开放。" home="/plans" />;
  const [rows, brandName] = await Promise.all([ap().plans.trash(await planActorOf(ctx)), brandNameByCode()]);
  const names = await web().actorNames(rows.map((p) => p.createdBy));
  return (
    <>
      <BackLink href="/plans">返回活动计划</BackLink>
      <PageHead title="回收站" sub="已删除计划保留 30 天；期间不出现在列表、详情、名单读取与批次查询中。" />
      {rows.length === 0 ? (
        <EmptyState title="回收站为空" text="删除的计划会在这里保留 30 天。" />
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>计划</th><th>品牌 · 平台</th><th>删除前状态</th><th>删除时间</th><th>清除时间</th><th className="right">操作</th></tr></thead>
            <tbody>
              {rows.map((p) => {
                const before = PLAN_STATUS[p.status] ?? { label: p.status, tone: "gray" as const };
                return (
                  <tr key={p.planId}>
                    <td><div className="cell-main">{p.name}</div><div className="cell-sub">创建者 {names.get(p.createdBy) ?? p.createdBy}</div></td>
                    <td className="nowrap"><span className="tag">{brandName.get(p.brand) ?? p.brand}</span> <span className="cell-sub" style={{ display: "inline" }}>{PLATFORM_LABEL[p.platform] ?? p.platform}</span></td>
                    <td><Badge tone={before.tone}>{before.label}</Badge></td>
                    <td className="num nowrap">{bjt(p.deletedAt)}</td>
                    <td className="num nowrap">{bjt(p.purgeAfter)}</td>
                    <td className="right"><RestorePlanButton planId={p.planId} name={p.name} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <Callout icon="alert" style={{ marginTop: 14 }}>恢复后回到删除前状态；因无引用关闭的账号会按引用规则重开，人工关闭与上级关闭的不动。共 {n(rows.length)} 个计划在回收站。</Callout>
    </>
  );
}
