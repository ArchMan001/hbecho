"use client";
// 「账号与监控」右侧的账号详情：确认疑似空账号、手工补抓、移出名单、五级监控开关。
// 开关变更先预览影响的账号数、显式确认才写入（上级关闭优先，下级打开不能覆盖上级关闭）；
// 组织级（分公司 / 经销商 / 门店 / 专员）开关只给全部品牌范围的主体，其余人只能改账号级。
import { useRouter } from "next/navigation";
import { useState, useTransition, type ReactNode } from "react";
import { confirmEmptyAccount, setMonitoringSwitch, supplementAccount, type SupplementOutcome, type SwitchResult } from "../../_actions/accounts";
import type { ActionResult } from "../../_lib/result";
import { SWITCH_LEVEL_LABEL } from "../../_lib/plan-labels";
import { ConfirmAction, Dialog } from "../dialog";
import { Icon } from "../icon";
import { useToast } from "../toast";
import { Callout } from "../ui";
import { RemoveEntryButton } from "./plan-actions";

export interface ChainNode {
  level: "branch" | "dealer" | "store" | "staff" | "account";
  id: string;
  name: string;
  enabled: boolean;
  active: boolean;
}
export interface PanelProps {
  accountId: string;
  statusCode: string;
  canConfirmEmpty: boolean;
  canSync: boolean;
  canRemove: boolean;
  canMonitor: boolean;
  canOrgSwitches: boolean;
  chain: ChainNode[];
  closedReason: string | null;
  plans: Array<{ planId: string; name: string }>;
  staffLabel: string;
}

const NOT_ELIGIBLE: Record<string, string> = {
  suspected_empty: "疑似空账号，需先确认",
  account_off: "账号监控已关闭",
  branch_off: "分公司监控已关闭",
  dealer_off: "经销商监控已关闭",
  store_off: "门店监控已关闭",
  staff_off: "专员监控已关闭",
  store_closed: "门店已撤店",
  staff_inactive: "专员已停用",
  deleted: "账号已确认删除",
  no_assignment: "没有归属",
};
const DISPOSITION_TEXT: Record<string, string> = {
  queued: "已提交手工补抓，由同步任务执行",
  reused_active_task: "这个账号已经有进行中的采集任务，不再重复提交",
  not_due: "最近刚采集过，暂不需要补抓",
  out_of_scope: "账号不在你的范围内",
  not_found: "账号不存在",
  no_accounts: "没有可补抓的账号",
};

function SwitchRow({ node, anchor, disabledReason, closedReason }: { node: ChainNode; anchor: string; disabledReason: string | null; closedReason: string | null }) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<SwitchResult | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [pending, start] = useTransition();
  const router = useRouter();
  const toast = useToast();
  const next = !node.enabled;
  const label = SWITCH_LEVEL_LABEL[node.level] ?? node.level;
  const org = node.level !== "account";

  const openIt = async () => {
    setOpen(true);
    setPreview(null);
    setError(null);
    if (!org) return; // 账号级只影响一个对象：不需要预览
    setLoading(true);
    let r: ActionResult<SwitchResult>;
    try {
      r = await setMonitoringSwitch(anchor, node.level, node.id, next, false);
    } catch {
      r = { ok: false, code: "network_error", message: "请求没有完成，请检查网络后重试" };
    }
    setLoading(false);
    if (r.ok) setPreview(r.data);
    else setError({ code: r.code, message: r.message });
  };
  const apply = () =>
    start(async () => {
      setError(null);
      let r: ActionResult<SwitchResult>;
      try {
        r = await setMonitoringSwitch(anchor, node.level, node.id, next, true);
      } catch {
        r = { ok: false, code: "network_error", message: "请求没有完成，请检查网络后重试" };
      }
      if (!r.ok) {
        setError({ code: r.code, message: r.message });
        return;
      }
      setOpen(false);
      toast(r.data.kind === "noop" ? "开关已经是这个状态" : `${label}监控已${next ? "打开" : "关闭"}`);
      router.refresh();
    });
  const note = !node.active ? `${label}已停用 / 已撤店` : node.level === "account" && !node.enabled ? (closedReason === "manual" ? "人工关闭" : closedReason === "unreferenced_15d" ? "15 天无计划引用自动关闭" : "账号级开关") : node.level === "dealer" ? "经销商级仅超管可改" : "";
  return (
    <div className="list-row">
      <div style={{ flex: 1 }}>
        <div className="cell-main">{label} · {node.name}</div>
        {note ? <div className="cell-sub">{note}</div> : null}
        {disabledReason ? <div className="cell-sub">{disabledReason}</div> : null}
      </div>
      <button type="button" className={`switch ${node.enabled ? "on" : ""}`} aria-pressed={node.enabled} aria-label={`${label}监控开关：${node.name}`} disabled={disabledReason !== null} onClick={openIt}>
        <span />
      </button>
      <Dialog
        open={open}
        title={`${next ? "打开" : "关闭"}${label}监控`}
        onClose={() => (pending ? undefined : setOpen(false))}
        foot={
          <>
            <button type="button" className="btn" onClick={() => setOpen(false)} disabled={pending}>取消</button>
            <button type="button" className={`btn ${next ? "btn-primary" : "btn-danger"}`} onClick={apply} disabled={pending || loading || (org && preview === null)}>
              {pending ? "处理中…" : next ? "打开监控" : "关闭监控"}
            </button>
          </>
        }
      >
        <p className="hint" style={{ marginBottom: 12 }}>{label}：<strong>{node.name}</strong></p>
        {loading ? <div className="skeleton skeleton-block" aria-busy="true" aria-label="正在计算影响范围" /> : null}
        {preview ? (
          <Callout icon="alert" tone={next ? undefined : "warn"}>
            只改这一级自己的开关，不改下级的值；影响其下 <strong>{preview.affectedAccounts.toLocaleString("en-US")}</strong> 个账号的有效监控。上级关闭优先，下级打开不能覆盖上级关闭。
          </Callout>
        ) : null}
        {!org ? <Callout icon="alert" tone={next ? undefined : "warn"}>只影响这一个账号。关闭后记为「人工关闭」，不会被 15 天无引用的自动规则重开；打开后重新计 15 天无引用宽限。</Callout> : null}
        {error ? (
          <div className="callout danger" role="alert" style={{ marginTop: 12 }}>
            <Icon name="alert" />
            <span>{error.message}（错误码 {error.code}）</span>
          </div>
        ) : null}
      </Dialog>
    </div>
  );
}

function Supplement({ accountId }: { accountId: string }) {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<SupplementOutcome | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [pending, start] = useTransition();
  const run = () =>
    start(async () => {
      setError(null);
      let r: ActionResult<SupplementOutcome>;
      try {
        r = await supplementAccount(accountId);
      } catch {
        r = { ok: false, code: "network_error", message: "请求没有完成，请检查网络后重试" };
      }
      if (!r.ok) setError({ code: r.code, message: r.message });
      else setResult(r.data);
    });
  return (
    <>
      <button type="button" className="btn" onClick={() => { setResult(null); setError(null); setOpen(true); }}>
        <Icon name="refresh" /> 手工补抓
      </button>
      <Dialog
        open={open}
        title="手工补抓"
        onClose={() => (pending ? undefined : setOpen(false))}
        foot={
          <>
            <button type="button" className="btn" onClick={() => setOpen(false)} disabled={pending}>{result ? "关闭" : "取消"}</button>
            {result ? null : <button type="button" className="btn btn-primary" onClick={run} disabled={pending}>{pending ? "提交中…" : "提交补抓"}</button>}
          </>
        }
      >
        <p className="hint">为这个账号立即提交一次完整采集（主页信息与内容列表）。页面只创建任务，由同步任务在放行的能力范围内执行；已有进行中的任务不会重复提交。</p>
        {result ? (
          <Callout icon={result.disposition === "queued" ? "check" : "alert"} tone={result.disposition === "queued" ? undefined : "warn"} style={{ marginTop: 12 }}>
            {result.disposition === "not_eligible" ? `当前不能补抓：${NOT_ELIGIBLE[result.reason ?? ""] ?? result.reason ?? "不满足监控条件"}` : (DISPOSITION_TEXT[result.disposition] ?? result.disposition)}
          </Callout>
        ) : null}
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

/** 动作按钮 → children（账号资料）→ 监控开关链，顺序与已确认原型一致。 */
export function AccountPanel({ children, ...p }: PanelProps & { children?: ReactNode }): ReactNode {
  return (
    <>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
        {p.statusCode === "suspected_empty" && p.canConfirmEmpty ? (
          <ConfirmAction label="确认疑似空账号" icon="check" buttonClass="btn btn-primary" title="确认疑似空账号" confirmLabel="确认" action={confirmEmptyAccount.bind(null, p.accountId)} doneMessage="疑似空账号已确认；下一次监控目标解析包含它">
            <p className="hint">确认后录入状态由「疑似空账号」改为「正常录入」，下一次监控目标解析会包含它。需要「账号管理」权限，且账号所属分公司在你的范围内；此操作记审计。</p>
          </ConfirmAction>
        ) : null}
        {p.canSync ? <Supplement accountId={p.accountId} /> : null}
        {p.canRemove ? p.plans.map((pl) => <RemoveEntryButton key={pl.planId} planId={pl.planId} accountId={p.accountId} label={`${p.staffLabel}（${pl.name}）`} />) : null}
      </div>
      {children}
      <div className="card" style={{ boxShadow: "none" }}>
        <div className="card-head">
          <div>
            <div className="card-title">监控开关链</div>
            <div className="card-sub">上级关闭优先；下级打开不能覆盖上级关闭。</div>
          </div>
        </div>
        <div className="card-pad" style={{ paddingTop: 4, paddingBottom: 4 }}>
          {p.chain.map((node) => {
            const reason = !p.canMonitor ? "没有监控开关权限" : node.level !== "account" && !p.canOrgSwitches ? "组织级开关需要全部品牌范围（超管）" : null;
            return <SwitchRow key={node.level} node={node} anchor={p.accountId} disabledReason={reason} closedReason={p.closedReason} />;
          })}
        </div>
      </div>
    </>
  );
}
