import { CreatePlanForm } from "../../../_components/plans/create-plan-form";
import { BackLink, Callout, DeniedState, PageHead } from "../../../_components/ui";
import { PLAN_PLATFORMS, SECTOR_KEYS } from "../../../../modules/activity-plan/constants";
import { PLATFORM_LABEL, SECTOR_LABEL } from "../../../_lib/plan-labels";
import { bjtToday, directory } from "../../../_lib/plan-page";
import { requireUser } from "../../../_lib/session";

export default async function NewPlanPage() {
  const ctx = await requireUser();
  if (!ctx.capabilities.has("activity_plan.create")) return <DeniedState text="创建活动计划需要「创建计划」权限；分公司与门店没有该权限。" home="/plans" />;
  // 只列出授权范围内、仍在使用的品牌；服务端创建时还会再校验一次
  const brands = (await directory()).brands.filter((b) => b.active && (ctx.scope.brands === "all" || ctx.scope.brands.has(BigInt(b.id))));
  // 计划必须绑定品牌：目录为空时直接说明，而不是给一个只有「请选择品牌」的空下拉
  if (brands.length === 0) {
    return (
      <>
        <BackLink href="/plans">返回活动计划</BackLink>
        <PageHead title="新建活动计划" sub="创建即发布，没有草稿。品牌、平台、板块创建后不可修改。" />
        <Callout icon="alert" tone="warn">
          没有可用的品牌：组织主档还没有导入，而计划必须绑定品牌。请超管先完成组织主档引导（运维手册 §10.3），完成后刷新本页。
        </Callout>
      </>
    );
  }
  return (
    <>
      <BackLink href="/plans">返回活动计划</BackLink>
      <PageHead title="新建活动计划" sub="创建即发布，没有草稿。品牌、平台、板块创建后不可修改。" />
      <div className="wizard-layout">
        <CreatePlanForm
          brands={brands.map((b) => ({ value: b.code, label: b.name }))}
          platforms={PLAN_PLATFORMS.map((p) => ({ value: p, label: PLATFORM_LABEL[p] ?? p }))}
          sectors={SECTOR_KEYS.map((s) => ({ value: s, label: SECTOR_LABEL[s] ?? s }))}
          today={bjtToday()}
        />
        <aside className="wizard-rail" aria-label="创建说明">
          <div className="rail-card">
            <div className="rail-kicker">创建之后</div>
            <div className="rail-title">创建即发布</div>
            <div className="rail-list">
              <div className="rail-row"><span>初始状态</span><strong>采集中</strong></div>
              <div className="rail-row"><span>名单</span><strong>从 0 开始</strong></div>
              <div className="rail-row"><span>判定计划</span><strong>按板块声明</strong></div>
            </div>
            <div className="rail-text">创建计划后只列出本计划需要的监控判定计划数量；判定计划在「判定计划」页创建。</div>
          </div>
          <div className="rail-card">
            <div className="rail-kicker">不可修改</div>
            <div className="rail-title">创建后不可修改</div>
            <div className="rail-text">品牌、平台、板块决定账号归属与判定口径。要调整范围，暂停 / 归档或删除重建，不在原计划上改。</div>
          </div>
          <div className="rail-card">
            <div className="rail-kicker">日期规则</div>
            <div className="rail-title">北京时间自然日</div>
            <div className="rail-text">结束日留空表示无结束日，视为持续引用；到期后名单保留，但不再计入引用。</div>
          </div>
        </aside>
      </div>
    </>
  );
}
