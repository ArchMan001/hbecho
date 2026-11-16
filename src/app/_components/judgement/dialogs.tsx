"use client";
// 向导与详情页的三个确认弹窗：回退一层、新建草稿、发布并执行。
// 每个弹窗写明影响范围，按钮写动作名；失败留在弹窗里，显示人话 + 稳定错误码（ui-foundation §6.5）。
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { executeJudgementPlan, newJudgementDraft, rollbackJudgementPlan, type RollbackPreview } from "../../_actions/judgement";
import { BLOCKER, timeText } from "../../_lib/judgement-labels";
import { Dialog } from "../dialog";
import { Icon } from "../icon";
import { useToast } from "../toast";
import { Callout } from "../ui";
import { ErrorLine } from "./wizard-common";

const net = { ok: false as const, code: "network_error", message: "请求没有完成，请检查网络后重试" };
type Err = { code: string; message: string } | null;
const STEP_NUMBER: Record<string, number> = { draft: 1, circled: 2, compared: 3 };
const STEP_TEXT: Record<string, string> = { draft: "第 1 页", circled: "第 2 页", compared: "第 3 页" };

/** 回退一层：先打开弹窗预览将删除什么（不写任何表），确认后才删。回退只作用于草稿。 */
export function RollbackButton({ planId, label = "回退", className = "btn" }: { planId: string; label?: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<RollbackPreview | null>(null);
  const [error, setError] = useState<Err>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const toast = useToast();
  const show = () => {
    setOpen(true);
    setPreview(null);
    setError(null);
    start(async () => {
      let r: Awaited<ReturnType<typeof rollbackJudgementPlan>>;
      try {
        r = await rollbackJudgementPlan(planId, false);
      } catch {
        r = net;
      }
      if (r.ok) setPreview(r.data);
      else setError(r);
    });
  };
  const apply = () =>
    start(async () => {
      setError(null);
      let r: Awaited<ReturnType<typeof rollbackJudgementPlan>>;
      try {
        r = await rollbackJudgementPlan(planId, true);
      } catch {
        r = net;
      }
      if (!r.ok) return setError(r);
      toast(`已回退到${STEP_TEXT[r.data.to] ?? ""}`);
      setOpen(false);
      router.push(`/judgement/${planId}/wizard/${STEP_NUMBER[r.data.to] ?? 1}`);
      router.refresh();
    });
  return (
    <>
      <button type="button" className={className} onClick={show}>
        <Icon name="refresh" /> {label}
      </button>
      <Dialog
        open={open}
        title="回退一层？"
        onClose={() => (pending ? undefined : setOpen(false))}
        foot={
          <>
            <button type="button" className="btn" disabled={pending} onClick={() => setOpen(false)}>取消</button>
            <button type="button" className="btn btn-danger" disabled={pending || !preview} onClick={apply}>确认回退</button>
          </>
        }
      >
        <Callout icon="alert" tone="warn">回退只作用于草稿；已发布版本的执行结果不受影响，也不会删除历史。</Callout>
        {preview ? (
          <div style={{ marginTop: 12 }}>
            <div className="kv-row"><span className="k">回退到</span><span className="v">{STEP_TEXT[preview.to] ?? preview.to}</span></div>
            <div className="kv-row"><span className="k">将删除</span><span className="v">{preview.runs} 次{preview.to === "circled" ? "试跑" : "圈定与试跑"}运行 · {preview.rows} 行结果</span></div>
            <p className="hint" style={{ marginTop: 10 }}>删除不可恢复；要改配置，也可以不回退，直接修改当前草稿，页面会按影响范围自动让旧结果失效。</p>
          </div>
        ) : pending && !error ? (
          <p className="hint" style={{ marginTop: 12 }}>正在计算将删除的内容…</p>
        ) : null}
        <ErrorLine error={error} />
      </Dialog>
    </>
  );
}

/** 新建草稿：从某个已发布版本复制配置与图片；旧版本的结果保留。 */
export function NewDraftButton({ planId, versions, nextVersion, label = "新建草稿", className = "btn btn-primary", defaultFrom }: { planId: string; versions: Array<{ version: number; publishedAt: Date | null }>; nextVersion: number; label?: string; className?: string; defaultFrom?: number }) {
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState<number>(defaultFrom ?? versions[0]?.version ?? 1);
  const [page, setPage] = useState<1 | 2 | 3>(1);
  const [error, setError] = useState<Err>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const toast = useToast();
  const submit = () =>
    start(async () => {
      setError(null);
      let r: Awaited<ReturnType<typeof newJudgementDraft>>;
      try {
        r = await newJudgementDraft(planId, from);
      } catch {
        r = net;
      }
      if (!r.ok) return setError(r);
      toast(`已新建草稿 v${r.data.version}`);
      setOpen(false);
      router.push(`/judgement/${planId}/wizard/${page}`);
    });
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)}>
        <Icon name="plus" /> {label}
      </button>
      <Dialog
        open={open}
        title="新建草稿"
        onClose={() => (pending ? undefined : setOpen(false))}
        foot={
          <>
            <button type="button" className="btn" disabled={pending} onClick={() => setOpen(false)}>取消</button>
            <button type="button" className="btn btn-primary" disabled={pending || versions.length === 0} onClick={submit}>创建草稿</button>
          </>
        }
      >
        <Callout icon="alert">草稿的向导进度归零：圈定与试跑结果不带过去。旧版本的执行结果保留可查。</Callout>
        <div className="form-grid" style={{ marginTop: 12 }}>
          <div className="field">
            <label htmlFor="nd-from">从哪个已发布版本复制</label>
            <select className="select" id="nd-from" value={from} onChange={(e) => setFrom(Number(e.target.value))}>
              {versions.map((v) => (
                <option key={v.version} value={v.version}>v{v.version} · {timeText(v.publishedAt)}</option>
              ))}
            </select>
            <span className="hint">可以指定任意已发布版本，对应「回到某一版」。</span>
          </div>
          <div className="field">
            <label htmlFor="nd-page">创建后进入</label>
            <select className="select" id="nd-page" value={page} onChange={(e) => setPage(Number(e.target.value) as 1 | 2 | 3)}>
              <option value={1}>第 1 页 · 圈定</option>
              <option value={2}>第 2 页 · 比对</option>
              <option value={3}>第 3 页 · 理解与执行</option>
            </select>
            <span className="hint">只影响进入的页面；进度仍从「草稿」开始，前一步完成前后面的页不可用。</span>
          </div>
          <div className="kv-row"><span className="k">新草稿版本</span><span className="v">v{nextVersion}</span></div>
        </div>
        <ErrorLine error={error} />
      </Dialog>
    </>
  );
}

export interface ExecuteInfo {
  planId: string;
  alias: string;
  /** 有草稿 = 发布并执行；没有 = 对最近已发布版本重新执行（不升版） */
  draftVersion: number | null;
  publishedVersion: number | null;
  contents: number | null;
  participants: number | null;
  hasAsr: boolean;
}
/** 确认执行 / 重新执行。1.0 不展示费用预估；幂等键每次打开弹窗生成，重复点击返回同一次执行。 */
export function ExecuteButton({ info, disabled, blockers = [], label, className = "btn btn-primary" }: { info: ExecuteInfo; disabled?: boolean; blockers?: string[]; label?: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<Err>(null);
  const [pending, start] = useTransition();
  const key = useRef("");
  const router = useRouter();
  const toast = useToast();
  const publish = info.draftVersion !== null;
  const version = info.draftVersion ?? info.publishedVersion;
  const submit = () =>
    start(async () => {
      setError(null);
      let r: Awaited<ReturnType<typeof executeJudgementPlan>>;
      try {
        r = await executeJudgementPlan(info.planId, key.current);
      } catch {
        r = net;
      }
      if (!r.ok) return setError(r);
      toast(publish ? `已发布 v${r.data.version} 并开始执行` : "已提交重新执行");
      setOpen(false);
      router.push(`/judgement/executions/${r.data.runId}`);
    });
  return (
    <>
      <button
        type="button"
        className={className}
        disabled={disabled}
        onClick={() => {
          key.current = crypto.randomUUID();
          setError(null);
          setOpen(true);
        }}
      >
        <Icon name={publish ? "check" : "play"} /> {label ?? (publish ? "确认执行" : "重新执行")}
      </button>
      <Dialog
        open={open}
        title={publish ? "发布并执行" : "重新执行"}
        onClose={() => (pending ? undefined : setOpen(false))}
        foot={
          <>
            <button type="button" className="btn" disabled={pending} onClick={() => setOpen(false)}>取消</button>
            <button type="button" className="btn btn-primary" disabled={pending || blockers.length > 0} onClick={submit}>
              {pending ? "提交中…" : publish ? `发布 v${version} 并执行` : `对 v${version} 重新执行`}
            </button>
          </>
        }
      >
        <p className="hint" style={{ marginBottom: 12 }}>判定计划：<strong>{info.alias}</strong></p>
        <Callout icon="alert">
          {publish ? <>确认执行会把草稿 <b>v{version}</b> 发布为新版本并开始执行；已发布版本不可修改。</> : <>对最近已发布的 <b>v{version}</b> 再执行一次，不产生新版本。</>}
        </Callout>
        <div style={{ marginTop: 12 }}>
          {publish ? <div className="kv-row"><span className="k">将发布</span><span className="v">v{version}（不可变）</span></div> : null}
          {info.contents !== null ? <div className="kv-row"><span className="k">将执行</span><span className="v">{info.contents} 条内容 · {info.participants ?? "—"} 名参与专员</span></div> : null}
          <div className="kv-row"><span className="k">第 3 层</span><span className="v">{info.hasAsr ? "包含音频 ASR 判定（付费调用）" : "不含付费判定"}</span></div>
          <div className="kv-row"><span className="k">执行期间</span><span className="v">名单、归属、组织链与内容快照冻结</span></div>
        </div>
        <Callout icon="clock" tone="warn" style={{ marginTop: 12 }}>1.0 不展示费用预估，费用由账户硬上限兜底。执行可能因采集等待较久，可随时在执行记录里取消。</Callout>
        {blockers.length ? (
          <div className="callout danger" role="alert" style={{ marginTop: 12 }}>
            <Icon name="alert" />
            <span>现在不能执行：{blockers.map((b) => BLOCKER[b] ?? b).join("；")}</span>
          </div>
        ) : null}
        <ErrorLine error={error} />
      </Dialog>
    </>
  );
}
