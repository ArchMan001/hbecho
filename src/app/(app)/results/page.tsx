import Link from "next/link";
import { isReportError } from "../../../modules/report-detail";
import { Icon } from "../../_components/icon";
import { Badge, DeniedState, EmptyState, PageHead } from "../../_components/ui";
import { reports } from "../../_lib/reports";
import { requireUser } from "../../_lib/session";
import { fmtTime } from "../../_lib/labels";
import { PLATFORM_LABEL } from "../../_lib/plan-labels";
// 导航「活动计划判定结果」的落地页（刘学奎 2026-11-19）：范围内可见的判定计划，点进去看某次已完成执行的视频明细与账号维度。
// 四个角色都有入口；门店专员进入后只看到本人名下的行（由数据范围保证，页面不判断角色）。
export default async function ResultsPage() {
  const ctx = await requireUser();
  if (!ctx.capabilities.has("report.read")) return <DeniedState text="当前账号没有「活动计划判定结果」入口。" />;
  let rows;
  try {
    rows = await reports().overview(ctx);
  } catch (e) {
    if (isReportError(e) && e.kind === "auth") return <DeniedState text="当前账号没有可见的数据范围。请联系上级管理员确认你的品牌与人员范围。" />;
    throw e;
  }
  const scope = ctx.role === "store_staff" ? "只显示你名下的账号与内容。" : ctx.role === "branch_manager" ? "只显示本分公司范围内的账号与内容。" : "显示授权范围内的全部账号与内容。";
  return (
    <>
      <PageHead title="活动计划判定结果" sub={`选一个判定计划，查看它某次已完成执行里的全部视频与账号。${scope}`} />
      {rows.length === 0 ? (
        <EmptyState title="还没有可查看的判定计划" text="判定计划建好并完成一次执行后，会出现在这里。" />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>判定计划</th>
                <th>活动计划</th>
                <th>平台</th>
                <th>最近一次完成</th>
                <th>状态</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.planId}>
                  <td>{r.alias}</td>
                  <td>{r.activityPlanName}</td>
                  <td>{PLATFORM_LABEL[r.platformCode] ?? r.platformCode}</td>
                  <td className="num">{r.latest ? `${fmtTime(r.latest.completedAt)} · v${r.latest.version}` : "—"}</td>
                  <td>{r.latest ? <Badge tone="green">已完成</Badge> : <Badge tone="gray">没有已完成的执行</Badge>}{r.archived ? <> <Badge tone="gray">已归档</Badge></> : null}</td>
                  <td className="right">
                    <Link className="btn btn-sm" href={`/reports/${r.planId}`}>
                      <Icon name="layers" /> 查看
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
