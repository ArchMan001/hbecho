"use client";
// 详情页的归档 / 取消归档（按钮 + 带影响范围的确认弹窗 + 一个服务端动作；按钮写动作名）。
import { archiveJudgementPlan, unarchiveJudgementPlan } from "../../_actions/judgement";
import { ConfirmAction } from "../dialog";
import { Callout } from "../ui";
export function ArchiveButton({ planId, alias, archived }: { planId: string; alias: string; archived: boolean }) {
  if (archived) {
    return (
      <ConfirmAction label="取消归档" icon="refresh" buttonClass="btn" title="取消归档" confirmLabel="取消归档" action={unarchiveJudgementPlan.bind(null, planId)} doneMessage="已取消归档">
        <p className="hint" style={{ marginBottom: 12 }}>判定计划：<strong>{alias}</strong></p>
        <Callout icon="refresh">取消归档后可以新建草稿与重新执行；已有版本与结果不受影响。</Callout>
      </ConfirmAction>
    );
  }
  return (
    <ConfirmAction label="归档" icon="archive" buttonClass="btn" title="归档判定计划" confirmLabel="归档" action={archiveJudgementPlan.bind(null, planId)} doneMessage="已归档">
      <p className="hint" style={{ marginBottom: 12 }}>判定计划：<strong>{alias}</strong></p>
      <Callout icon="archive" tone="warn">归档后不能新建草稿、不能执行；已有版本、执行记录与结果保持可读，可随时取消归档。</Callout>
    </ConfirmAction>
  );
}
