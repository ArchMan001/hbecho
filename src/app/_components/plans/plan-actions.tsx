"use client";
// 计划详情页的动作按钮：每个都是「按钮 + 带影响范围的确认弹窗 + 一个服务端动作」。
// 文案来自已确认原型（ui-lab/hbecho-ui-v2），影响范围按服务端预览的真实数字写明；按钮写动作名，不写「确定」。
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { assignOwner, deletePlan, type DeletePreview, type ExitPreview, type RemovePreview, editPlan, exitBranch, joinPlan, previewDeletePlan, previewExitBranch, previewRemoveFromRoster, removeFromRoster, restorePlan, setPlanStatus } from "../../_actions/plans";
import type { ActionResult } from "../../_lib/result";
import { n } from "../../_lib/plan-labels";
import { ConfirmAction, Dialog } from "../dialog";
import { Icon } from "../icon";
import { useToast } from "../toast";
import { Callout } from "../ui";
import { PreviewAction } from "./preview-action";

const Plan = ({ name }: { name: string }) => (
  <p className="hint" style={{ marginBottom: 12 }}>
    计划：<strong>{name}</strong>
  </p>
);

export function PlanStatusButtons({ planId, name, status }: { planId: string; name: string; status: string }) {
  if (status === "collecting") {
    return (
      <>
        <ConfirmAction label="暂停" icon="pause" buttonClass="btn" title="暂停计划" confirmLabel="暂停" action={setPlanStatus.bind(null, planId, "pause")} doneMessage="计划已暂停">
          <Plan name={name} />
          <Callout icon="pause" tone="warn">暂停后名单、参与关系与负责人冻结；计划不再计入引用，账号保留 15 天宽限后才关闭。</Callout>
        </ConfirmAction>
        <ConfirmAction label="归档" icon="archive" buttonClass="btn" title="归档计划" confirmLabel="归档" action={setPlanStatus.bind(null, planId, "archive")} doneMessage="计划已归档">
          <Plan name={name} />
          <Callout icon="archive" tone="warn">归档后名单、参与关系与负责人冻结；计划不再计入引用，账号保留 15 天宽限后才关闭。</Callout>
        </ConfirmAction>
      </>
    );
  }
  return (
    <ConfirmAction label="恢复" icon="play" buttonClass="btn" title="恢复计划" confirmLabel="恢复" action={setPlanStatus.bind(null, planId, "resume")} doneMessage="计划已恢复为采集中">
      <Plan name={name} />
      <Callout icon="play">恢复后名单、参与关系与负责人解冻；因无引用关闭的账号按引用规则重开。</Callout>
    </ConfirmAction>
  );
}

export function DeletePlanButton({ planId, name }: { planId: string; name: string }) {
  return (
    <PreviewAction<DeletePreview>
      label="删除"
      icon="trash"
      buttonClass="btn btn-danger"
      title="删除活动计划"
      confirmLabel="删除计划"
      danger
      preview={previewDeletePlan.bind(null, planId)}
      action={deletePlan.bind(null, planId)}
      doneMessage={(r) => `计划已进入回收站，已关闭 ${(r as { accountsClosed: number }).accountsClosed} 个账号的监控`}
      after="/plans"
    >
      {(p) => (
        <>
          <Plan name={name} />
          <Callout icon="alert" tone="danger">
            下面有 <strong>{n(p.judgementPlans)}</strong> 个监控判定计划、共 <strong>{n(p.results)}</strong> 条结果；名单内账号 <strong>{n(p.inRoster)}</strong> 个，其中只被本计划引用的 <strong>{n(p.accountsToClose)}</strong> 个会立即关闭监控。计划进入回收站 30 天，期满物理清除计划层对象。
          </Callout>
          {p.running > 0 ? (
            <Callout icon="clock" tone="warn" style={{ marginTop: 12 }}>
              下游还有 {p.running} 个判定正在执行，需要等它们结束后才能删除。
            </Callout>
          ) : null}
          <p className="hint" style={{ marginTop: 12 }}>删除不删账号、不删底层采集数据，也不删导入批次与行结果。</p>
        </>
      )}
    </PreviewAction>
  );
}

export function RestorePlanButton({ planId, name }: { planId: string; name: string }) {
  return (
    <ConfirmAction label="恢复" buttonClass="btn btn-sm" title="恢复计划" confirmLabel="恢复" action={restorePlan.bind(null, planId)} doneMessage="计划已恢复">
      <Plan name={name} />
      <p className="hint">恢复后回到删除前状态；因无引用关闭的账号会按引用规则重开，人工关闭与上级关闭的不动。</p>
    </ConfirmAction>
  );
}

export function JoinBranchButton({ planId, branchId, name, rejoin }: { planId: string; branchId: string; name: string; rejoin: boolean }) {
  return (
    <ConfirmAction
      label={rejoin ? "重新加入" : "加入计划"}
      buttonClass={rejoin ? "btn btn-sm" : "btn btn-sm btn-primary"}
      title={rejoin ? "重新加入计划" : "加入计划"}
      confirmLabel={rejoin ? "重新加入" : "加入"}
      action={joinPlan.bind(null, planId, branchId)}
      doneMessage={rejoin ? "已重新加入；名单项仍为已移出，等待重新提交" : "已加入计划"}
    >
      <p className="hint">
        <strong>{name}</strong> {rejoin ? "重新加入后只恢复参与关系；此前被移出的名单项保持「已移出」，重新提交对应账号时才会恢复。" : "加入后可以提报名单；负责人名额在第一次提交新增行时自动占用。"}
      </p>
    </ConfirmAction>
  );
}

export function ExitBranchButton({ planId, branchId, name }: { planId: string; branchId: string; name: string }) {
  return (
    <PreviewAction<ExitPreview>
      label="退出"
      title="分公司退出计划"
      confirmLabel="退出"
      danger
      preview={previewExitBranch.bind(null, planId, branchId)}
      action={exitBranch.bind(null, planId, branchId)}
      doneMessage={(r) => `已退出；关闭了 ${(r as { accountsClosed: number }).accountsClosed} 个账号的监控`}
    >
      {(p) => (
        <>
          <p className="hint" style={{ marginBottom: 12 }}>
            分公司：<strong>{name}</strong>
          </p>
          <Callout icon="alert" tone="danger">
            退出后：该分公司在本计划下的 <strong>{n(p.rosterEntries)}</strong> 个名单项置为「已移出活动计划」，释放负责人名额{p.owners.length ? `（${p.owners.join("、")}）` : ""}，其中只被本计划引用的 <strong>{n(p.accountsToClose)}</strong> 个账号立即关闭监控；已采数据与判定结果保留。
          </Callout>
        </>
      )}
    </PreviewAction>
  );
}

export function RemoveEntryButton({ planId, accountId, label }: { planId: string; accountId: string; label: string }) {
  return (
    <PreviewAction<RemovePreview>
      label="移出"
      title="移出名单"
      confirmLabel="移出"
      danger
      preview={previewRemoveFromRoster.bind(null, planId, [accountId])}
      action={removeFromRoster.bind(null, planId, [accountId])}
      doneMessage={(r) => ((r as { accountsClosed: number }).accountsClosed > 0 ? "已移出名单，账号监控已关闭" : "已移出名单，账号仍被其他计划引用，监控保持开启")}
    >
      {(p) => (
        <>
          <p className="hint" style={{ marginBottom: 12 }}>
            名单项：<strong>{label}</strong>
          </p>
          <Callout icon="alert" tone="danger">
            移出后名单项置为「已移出活动计划」，永不物理删除；{p.accountsToClose > 0 ? "这个账号只被本计划引用，会立即关闭监控。" : "账号仍被其他有效计划引用，保持开启。"}
          </Callout>
        </>
      )}
    </PreviewAction>
  );
}

const Field = ({ label, children, hint, wide }: { label: string; children: React.ReactNode; hint?: string; wide?: boolean }) => (
  <div className={`field ${wide ? "span-2" : ""}`}>
    <label>{label}</label>
    {children}
    {hint ? <span className="hint">{hint}</span> : null}
  </div>
);

/** 编辑名称 / 说明 / 起止日期。品牌、平台、板块没有更新路径，所以表单里没有这些字段。 */
export function EditPlanButton({ plan }: { plan: { planId: string; name: string; description: string; startsOn: string; endsOn: string } }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState(plan);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const toast = useToast();
  const save = () =>
    start(async () => {
      setError(null);
      let r: ActionResult<{ changed: string[] }>;
      try {
        r = await editPlan(plan.planId, { name: f.name, description: f.description, startsOn: f.startsOn, endsOn: f.endsOn });
      } catch {
        r = { ok: false, code: "network_error", message: "请求没有完成，请检查网络后重试" };
      }
      if (!r.ok) {
        setError({ code: r.code, message: r.message });
        return;
      }
      setOpen(false);
      toast(r.data.changed.length ? "计划已更新" : "没有需要保存的修改");
      router.refresh();
    });
  return (
    <>
      <button
        type="button"
        className="btn"
        onClick={() => {
          setF(plan);
          setError(null);
          setOpen(true);
        }}
      >
        <Icon name="edit" /> 编辑
      </button>
      <Dialog
        open={open}
        title="编辑活动计划"
        onClose={() => (pending ? undefined : setOpen(false))}
        foot={
          <>
            <button type="button" className="btn" onClick={() => setOpen(false)} disabled={pending}>取消</button>
            <button type="button" className="btn btn-primary" onClick={save} disabled={pending}>{pending ? "保存中…" : "保存"}</button>
          </>
        }
      >
        <div className="form-grid">
          <Field label="计划名称 *" wide>
            <input className="input" maxLength={200} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </Field>
          <Field label="说明" wide>
            <textarea className="textarea" maxLength={2000} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
          </Field>
          <Field label="开始日期 *">
            <input className="input" type="date" value={f.startsOn} onChange={(e) => setF({ ...f, startsOn: e.target.value })} />
          </Field>
          <Field label="结束日期" hint="留空表示无结束日。改结束日会立即按引用规则重新检查名单账号的监控。">
            <input className="input" type="date" value={f.endsOn} onChange={(e) => setF({ ...f, endsOn: e.target.value })} />
          </Field>
        </div>
        <p className="hint" style={{ marginTop: 12 }}>品牌、平台、板块创建后不可修改；要调整范围，请暂停 / 归档或删除后重建。</p>
        {error ? (
          <div className="callout danger" role="alert" style={{ marginTop: 12 }}>
            <Icon name="alert" />
            <span>{error.message}（错误码 {error.code}）</span>
          </div>
        ) : null}
      </Dialog>
    </>
  );
}

export interface OwnerSlot {
  slotNo: number;
  owner: string;
  name: string;
}
export interface OwnerCandidate {
  id: string;
  name: string;
}
/** 指派 / 替换负责人：两个槽位各选一个人；只有计划创建者与超管能打开（服务端动作再判断一次）。 */
export function AssignOwnersButton({ planId, branchId, branchName, owners, candidates }: { planId: string; branchId: string; branchName: string; owners: OwnerSlot[]; candidates: OwnerCandidate[] }) {
  const current = (slotNo: number) => owners.find((o) => o.slotNo === slotNo)?.owner ?? "";
  const [open, setOpen] = useState(false);
  const [pick, setPick] = useState<Record<number, string>>({ 1: current(1), 2: current(2) });
  const [error, setError] = useState<{ code: string; message: string; hint?: string | undefined } | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const toast = useToast();
  const names = new Map(candidates.map((c) => [c.id, c.name]));
  for (const o of owners) if (!names.has(o.owner)) names.set(o.owner, o.name);
  const save = () =>
    start(async () => {
      setError(null);
      let changed = 0;
      for (const slotNo of [1, 2]) {
        const owner = pick[slotNo] ?? "";
        if (owner === "" || owner === current(slotNo)) continue;
        let r: Awaited<ReturnType<typeof assignOwner>>;
        try {
          r = await assignOwner({ planId, branchId, owner, displayName: names.get(owner) ?? owner, slotNo, apply: true });
        } catch {
          r = { ok: false, code: "network_error", message: "请求没有完成，请检查网络后重试" };
        }
        if (!r.ok) {
          setError({ code: r.code, message: r.message, hint: r.hint });
          if (changed > 0) router.refresh(); // 已成功的槽位要在页面上显示出来
          return;
        }
        if (r.data.kind === "applied") changed += 1;
      }
      setOpen(false);
      toast(changed ? "负责人已更新并记入变更记录" : "没有需要保存的修改");
      router.refresh();
    });
  return (
    <>
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => {
          setPick({ 1: current(1), 2: current(2) });
          setError(null);
          setOpen(true);
        }}
      >
        <Icon name="users" /> 指派 / 替换
      </button>
      <Dialog
        open={open}
        title="指派 / 替换负责人"
        onClose={() => (pending ? undefined : setOpen(false))}
        foot={
          <>
            <button type="button" className="btn" onClick={() => setOpen(false)} disabled={pending}>取消</button>
            <button type="button" className="btn btn-primary" onClick={save} disabled={pending}>{pending ? "保存中…" : "保存"}</button>
          </>
        }
      >
        <p className="hint">分公司：<strong>{branchName}</strong></p>
        <div className="form-grid" style={{ marginTop: 12 }}>
          {[1, 2].map((slotNo) => (
            <div className="field" key={slotNo}>
              <label htmlFor={`owner-${branchId}-${slotNo}`}>槽位 {slotNo}</label>
              <select id={`owner-${branchId}-${slotNo}`} className="select" value={pick[slotNo] ?? ""} onChange={(e) => setPick({ ...pick, [slotNo]: e.target.value })}>
                <option value="">{current(slotNo) ? "（不变）" : "空槽"}</option>
                {[...names].map(([id, name]) => (
                  <option key={id} value={id}>{name}{id === current(slotNo) ? "（当前）" : ""}</option>
                ))}
              </select>
            </div>
          ))}
        </div>
        <Callout icon="users" style={{ marginTop: 12 }}>负责人不是权限，只作责任标记；只有计划创建者与超管可以替换，分公司不能自己换。同一个人不能占两个槽。</Callout>
        {error ? (
          <div className="callout danger" role="alert" style={{ marginTop: 12 }}>
            <Icon name="alert" />
            <span>{error.message}{error.hint ? `（${error.hint}）` : ""}（错误码 {error.code}）</span>
          </div>
        ) : null}
      </Dialog>
    </>
  );
}

/** 选一个还没加入的分公司加入计划（总部 / 超管代加入或有多个分公司范围时用；单个分公司的人直接点「加入计划」）。 */
export function JoinPicker({ planId, options }: { planId: string; options: Array<{ id: string; name: string }> }) {
  const [branch, setBranch] = useState("");
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const toast = useToast();
  if (options.length === 0) return null;
  const go = () =>
    start(async () => {
      setError(null);
      let r: Awaited<ReturnType<typeof joinPlan>>;
      try {
        r = await joinPlan(planId, branch);
      } catch {
        r = { ok: false, code: "network_error", message: "请求没有完成，请检查网络后重试" };
      }
      if (!r.ok) {
        setError({ code: r.code, message: r.message });
        return;
      }
      toast("已加入计划");
      setBranch("");
      router.refresh();
    });
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 14 }}>
      <label htmlFor="join-branch" className="filter-label">加入分公司</label>
      <select id="join-branch" className="select" style={{ maxWidth: 260 }} value={branch} onChange={(e) => setBranch(e.target.value)}>
        <option value="">请选择分公司</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>{o.name}</option>
        ))}
      </select>
      <button type="button" className="btn btn-sm btn-primary" disabled={!branch || pending} onClick={go}>{pending ? "加入中…" : "加入"}</button>
      {error ? <span className="hint" role="alert" style={{ color: "#B42318" }}>{error.message}（错误码 {error.code}）</span> : null}
    </div>
  );
}
