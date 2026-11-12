"use client";
// 名单导入向导的客户端部分（已确认原型的五步：选择计划 → 下载模板 → 上传与预检 → 确认写入 → 批次详情）。
// 预检报告与明细表由页面在服务端渲染；这里只有需要浏览器的部分：选文件上传、下载模板 / 回流文件、确认写入。
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { confirmRoster, precheckRoster, rosterReturnFile, rosterTemplate } from "../../_actions/plans";
import { Dialog } from "../dialog";
import { Icon } from "../icon";
import { useToast } from "../toast";
import { Callout } from "../ui";
import { saveCsv } from "./download";

export const IMPORT_STEPS = ["选择计划", "下载模板", "上传与预检", "确认写入", "批次详情"] as const;

export function Steps({ current }: { current: number }) {
  return (
    <div className="steps" aria-label="导入步骤">
      {IMPORT_STEPS.map((label, i) => (
        <div key={label} className={`step ${i + 1 < current ? "done" : ""} ${i + 1 === current ? "active" : ""}`}>
          <span className="step-num">{i + 1}</span>
          {label}
        </div>
      ))}
    </div>
  );
}

interface Err {
  code: string;
  message: string;
  hint?: string | undefined;
}
const ErrorBox = ({ error }: { error: Err }) => (
  <div className="callout danger" role="alert" style={{ marginTop: 12 }}>
    <Icon name="alert" />
    <span>
      {error.message}
      {error.hint ? `（${error.hint}）` : ""}（错误码 {error.code}）
    </span>
  </div>
);

/** 没有批次时的三步：选择计划 → 下载模板 → 上传。上传成功后带 ?batch= 回到本页，进入预检报告。 */
export function RosterUpload({ planId, planName, planLine, accounts, branchOptions }: { planId: string; planName: string; planLine: string; accounts: number; branchOptions: Array<{ id: string; name: string }> }) {
  const [stage, setStage] = useState<1 | 2 | 3>(1);
  const [branch, setBranch] = useState(branchOptions.length === 1 ? branchOptions[0]!.id : "");
  const [error, setError] = useState<Err | null>(null);
  const [pending, start] = useTransition();
  const fileInput = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const toast = useToast();

  const template = () =>
    start(async () => {
      const r = await rosterTemplate();
      if (!r.ok) {
        setError(r);
        return;
      }
      saveCsv(r.data.fileName, r.data.csv);
      toast("已下载模板（roster-import.v1）");
    });
  const upload = (file: File) =>
    start(async () => {
      setError(null);
      const form = new FormData();
      form.set("planId", planId);
      form.set("file", file);
      if (branch) form.set("branchId", branch);
      let r: Awaited<ReturnType<typeof precheckRoster>>;
      try {
        r = await precheckRoster(form);
      } catch {
        r = { ok: false, code: "network_error", message: "文件没有传上去，请检查网络后重试" };
      }
      if (!r.ok) {
        setError(r);
        return;
      }
      toast("已读取文件并完成预检；预检只读，还没有写入任何数据");
      router.replace(`/plans/${planId}/import?batch=${r.data.batchId}`);
    });

  let body: ReactNode;
  if (stage === 1) {
    body = (
      <>
        <Callout icon="file" style={{ marginBottom: 14 }}>
          当前计划：<strong>{planName}</strong> · {planLine}。名单模板没有平台列，平台由计划带出。
        </Callout>
        <div className="info-grid">
          <div><div className="info-label">模板版本</div><div className="info-value">roster-import.v1</div></div>
          <div><div className="info-label">列</div><div className="info-value">门店编码 / 专员姓名 / 手机号 / 主页链接</div></div>
          <div><div className="info-label">上限</div><div className="info-value">2,000 行 / 10 MB / 单批 ≤ 10 分钟</div></div>
        </div>
        <p className="hint" style={{ marginTop: 10 }}>计划当前名单 {accounts.toLocaleString("en-US")} 个账号。</p>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button type="button" className="btn btn-primary" onClick={() => setStage(2)}>
            <Icon name="arrowRight" /> 下一步
          </button>
        </div>
      </>
    );
  } else if (stage === 2) {
    body = (
      <div className="dropzone">
        <div className="state-icon"><Icon name="download" /></div>
        <strong>先下载模板</strong>
        <p className="hint">固定 4 列：门店编码、专员姓名、手机号、主页链接。Excel 编辑后请另存为 CSV；门店编码、手机号先设为文本格式，避免前导零丢失。</p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center", marginTop: 6 }}>
          <button type="button" className="btn" onClick={template} disabled={pending}><Icon name="download" /> 下载模板</button>
          <button type="button" className="btn btn-primary" onClick={() => setStage(3)}><Icon name="arrowRight" /> 我有文件了</button>
        </div>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setStage(1)}>上一步</button>
      </div>
    );
  } else {
    body = (
      <div className="dropzone">
        <div className="state-icon"><Icon name="upload" /></div>
        <strong>上传名单 CSV</strong>
        <p className="hint">固定 4 列：门店编码、专员姓名、手机号、主页链接。表头会自动跳过；与模板示例行完全相同的数据行会标为「示例行」，不进入数据。</p>
        {branchOptions.length > 1 ? (
          <div className="field" style={{ width: "100%", maxWidth: 320 }}>
            <label htmlFor="roster-branch">本次提交的分公司 *</label>
            <select id="roster-branch" className="select" value={branch} onChange={(e) => setBranch(e.target.value)}>
              <option value="">请选择分公司</option>
              {branchOptions.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          </div>
        ) : null}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center", marginTop: 6 }}>
          <input ref={fileInput} type="file" accept=".csv,text/csv" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ""; }} />
          <button type="button" className="btn btn-primary" onClick={() => fileInput.current?.click()} disabled={pending || (branchOptions.length > 1 && !branch)}>
            <Icon name="upload" /> {pending ? "上传并预检中…" : "选择文件"}
          </button>
          <button type="button" className="btn" onClick={template} disabled={pending}><Icon name="download" /> 下载模板</button>
        </div>
        <p className="hint">Excel 编辑后请另存为 CSV；门店编码、手机号先设为文本格式，避免前导零丢失。单个文件 ≤ 2,000 行、≤ 10 MB。</p>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setStage(2)}>上一步</button>
      </div>
    );
  }
  return (
    <>
      <Steps current={stage} />
      <div className="card-pad">
        {body}
        {error ? <ErrorBox error={error} /> : null}
      </div>
    </>
  );
}

export interface ConfirmFacts {
  batchId: string;
  planName: string;
  branchName: string;
  newStaff: number;
  writable: number;
  resolveTasks: number;
  errors: number;
  entriesNow: number;
  entriesAfter: number;
  softCapExceeded: boolean;
  /** 名额占用说明（服务端按本地可知事实算好的一句话）。 */
  ownerNote: string;
  /** 名额已满：确认会被拒绝。 */
  ownerBlocked: boolean;
}

/** 预检报告上方的操作：下载回流文件、确认写入（第 4 步：弹窗里核对后才写入）。 */
export function RosterReportActions({ planId, facts, canConfirm, hasReturnRows }: { planId: string; facts: ConfirmFacts; canConfirm: boolean; hasReturnRows: boolean }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<Err | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const toast = useToast();

  const download = () =>
    start(async () => {
      const r = await rosterReturnFile(facts.batchId);
      if (!r.ok) {
        setError(r);
        return;
      }
      saveCsv(r.data.fileName, r.data.csv);
      toast(`已下载回流文件（${r.data.rows} 行）`);
    });
  const confirm = () =>
    start(async () => {
      setError(null);
      let r: Awaited<ReturnType<typeof confirmRoster>>;
      try {
        r = await confirmRoster(facts.batchId);
      } catch {
        r = { ok: false, code: "network_error", message: "请求没有完成；已写入的行不会重复写入，刷新后可继续确认" };
      }
      if (!r.ok) {
        setError(r);
        return;
      }
      setOpen(false);
      toast(r.data.pending > 0 ? `已确认写入，${r.data.pending} 行解析中` : "已确认写入，全部行已有结果");
      router.push(`/batches/${facts.batchId}`);
    });
  return (
    <>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {hasReturnRows ? <button type="button" className="btn btn-sm" onClick={download} disabled={pending}><Icon name="download" /> 下载回流文件</button> : null}
        <Link className="btn btn-sm" href={`/plans/${planId}/import`}>重新上传</Link>
        {canConfirm ? (
          <button type="button" className="btn btn-sm btn-primary" onClick={() => { setError(null); setOpen(true); }}>
            确认写入 <Icon name="arrowRight" />
          </button>
        ) : null}
      </div>
      {error && !open ? <ErrorBox error={error} /> : null}
      <Dialog
        open={open}
        title="确认写入"
        onClose={() => (pending ? undefined : setOpen(false))}
        foot={
          <>
            <button type="button" className="btn" onClick={() => setOpen(false)} disabled={pending}>上一步</button>
            <button type="button" className="btn btn-primary" onClick={confirm} disabled={pending}>
              <Icon name="check" /> {pending ? "写入中…" : "确认写入"}
            </button>
          </>
        }
      >
        <Callout icon="alert" tone="warn" style={{ marginBottom: 14 }}>确认后是本批次唯一的写入点；写入分块执行，中断后可续跑。确认前请核对负责人名额与计划状态。</Callout>
        <div className="info-grid">
          <div><div className="info-label">计划</div><div className="info-value">{facts.planName}</div></div>
          <div><div className="info-label">批次</div><div className="info-value num">{facts.batchId}</div></div>
          <div><div className="info-label">提交分公司</div><div className="info-value">{facts.branchName}</div></div>
          <div><div className="info-label">将新建专员</div><div className="info-value num">{facts.newStaff.toLocaleString("en-US")}</div></div>
          <div><div className="info-label">名单写入 / 恢复</div><div className="info-value num">{facts.writable.toLocaleString("en-US")}</div></div>
          <div><div className="info-label">账号解析任务</div><div className="info-value num">{facts.resolveTasks.toLocaleString("en-US")}</div></div>
          <div><div className="info-label">负责人名额</div><div className="info-value">{facts.ownerNote}</div></div>
          <div><div className="info-label">错误行</div><div className="info-value num">{facts.errors.toLocaleString("en-US")}</div></div>
          <div><div className="info-label">预检时名单数 → 预计</div><div className="info-value num">{facts.entriesNow.toLocaleString("en-US")} → {facts.entriesAfter.toLocaleString("en-US")}</div></div>
        </div>
        {facts.softCapExceeded ? <Callout icon="alert" tone="warn" style={{ marginTop: 12 }}>写入后本计划名单将超过 1,200 个账号。这只是提示，不会阻止确认。</Callout> : null}
        {facts.ownerBlocked ? <Callout icon="lock" tone="danger" style={{ marginTop: 12 }}>本计划在你的分公司的两个负责人名额已满，确认会被拒绝；请联系计划创建者替换负责人。</Callout> : null}
        {error ? <ErrorBox error={error} /> : null}
      </Dialog>
    </>
  );
}

/** 批次详情上方的刷新与回流文件（解析中的批次每 8 秒自动刷新一次）。 */
export function BatchActions({ batchId, hasReturnRows, live }: { batchId: string; hasReturnRows: boolean; live: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [error, setError] = useState<Err | null>(null);
  const refresh = useCallback(() => router.refresh(), [router]);
  useAutoRefresh(live, refresh);
  const download = () =>
    start(async () => {
      const r = await rosterReturnFile(batchId);
      if (!r.ok) {
        setError(r);
        return;
      }
      saveCsv(r.data.fileName, r.data.csv);
      toast(`已下载回流文件（${r.data.rows} 行）`);
    });
  return (
    <>
      <button type="button" className="btn" onClick={() => router.refresh()}><Icon name="refresh" /> 刷新</button>
      {hasReturnRows ? <button type="button" className="btn" onClick={download} disabled={pending}><Icon name="download" /> 回流文件</button> : null}
      {error ? <span className="hint" role="alert" style={{ color: "#B42318" }}>{error.message}（错误码 {error.code}）</span> : null}
    </>
  );
}

function useAutoRefresh(on: boolean, fn: () => void) {
  useEffect(() => {
    if (!on) return;
    const t = setInterval(fn, 8000);
    return () => clearInterval(t);
  }, [on, fn]);
}
