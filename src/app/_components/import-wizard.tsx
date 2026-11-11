"use client";
// 用户批量导入：上传 → 预检 → 确认 → 完成。批次编号在 URL 里（?batch=），刷新或换设备后仍回到同一步。
// 预检和写入都在服务端同步完成（单批 ≤ 1,000 行）；确认时服务端会重新校验全部行。
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { confirmImport, precheckImport, returnFile } from "../_actions/import";
import { IMPORT_REASON_LABEL } from "../_lib/labels";
import { Icon } from "./icon";
import { useToast } from "./toast";
import { Badge, Callout } from "./ui";

export interface WizardRow {
  rowNo: number;
  name: string;
  role: string;
  phone: string;
  brand: string;
  scope: string;
  kind: "new" | "skip" | "error";
  outcome: string | null;
  reason: string | null;
  guidance: string;
}
export interface WizardBatch {
  batchId: string;
  status: string;
  fileName: string;
  totalRows: number;
  newRows: number;
  skippedRows: number;
  errorRows: number;
  conflictRows: number;
  rows: WizardRow[];
}

const TEMPLATE = "\uFEFF姓名,角色,手机号,品牌,分公司,门店编码\r\n";
const SHOW_STEP = 100;

function save(fileName: string, text: string) {
  const url = URL.createObjectURL(new Blob([text.startsWith("\uFEFF") ? text : `\uFEFF${text}`], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

export function ImportWizard({ batch }: { batch: WizardBatch | null }) {
  const router = useRouter();
  const toast = useToast();
  const fileInput = useRef<HTMLInputElement>(null);
  const [pending, start] = useTransition();
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [filter, setFilter] = useState<"all" | "new" | "skip" | "error">("all");
  const [shown, setShown] = useState(SHOW_STEP);

  const step = !batch ? 1 : batch.status === "completed" ? 4 : confirming || batch.status === "writing" ? 3 : 2;

  const upload = (file: File) =>
    start(async () => {
      setError(null);
      const form = new FormData();
      form.set("file", file);
      let r: Awaited<ReturnType<typeof precheckImport>>;
      try { r = await precheckImport(form); } catch { r = { ok: false, code: "network_error", message: "文件没有传上去，请检查网络后重试" }; }
      if (!r.ok) { setError({ code: r.code, message: r.message }); return; }
      toast("已读取文件并完成预检；预检只读，还没有写入任何用户");
      router.replace(`/users/import?batch=${r.data.batchId}`);
    });
  const download = () =>
    start(async () => {
      if (!batch) return;
      const r = await returnFile(batch.batchId);
      if (!r.ok) { setError({ code: r.code, message: r.message }); return; }
      save(r.data.fileName, r.data.csv);
      toast(`已下载回流文件（${r.data.rows} 行）`);
    });
  const confirm = () =>
    start(async () => {
      if (!batch) return;
      setError(null);
      let r: Awaited<ReturnType<typeof confirmImport>>;
      try { r = await confirmImport(batch.batchId); } catch { r = { ok: false, code: "network_error", message: "请求没有完成；已写入的行不会重复写入，刷新后可继续确认" }; }
      if (!r.ok) { setError({ code: r.code, message: r.message }); return; }
      toast(`已创建 ${r.data.created} 个待激活用户`);
      setConfirming(false);
      router.refresh();
    });

  const rows = batch ? batch.rows.filter((r) => filter === "all" || r.kind === filter) : [];
  return (
    <div className="card wizard-main">
      <div className="steps">
        {[["1", "上传"], ["2", "预检"], ["3", "确认"], ["4", "完成"]].map(([n, l]) => (
          <div key={n} className={`step ${Number(n) < step ? "done" : ""} ${Number(n) === step ? "active" : ""}`}>
            <span className="step-num">{n}</span>
            {l}
          </div>
        ))}
      </div>
      <div className="card-pad">
        {step === 1 ? (
          <div className="dropzone">
            <div className="state-icon"><Icon name="upload" /></div>
            <strong>上传用户 CSV</strong>
            <p className="hint">固定 6 列：姓名、角色、手机号、品牌、分公司、门店编码。角色写中文名；品牌、分公司写编码；门店编码仅门店专员填。</p>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center", marginTop: 6 }}>
              <input ref={fileInput} type="file" accept=".csv,text/csv" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ""; }} />
              <button type="button" className="btn btn-primary" onClick={() => fileInput.current?.click()} disabled={pending}><Icon name="upload" /> {pending ? "上传并预检中…" : "选择文件"}</button>
              <button type="button" className="btn" onClick={() => save("用户导入模板.csv", TEMPLATE)}><Icon name="download" /> 下载模板</button>
            </div>
            <p className="hint">单批 ≤ 1,000 行；文件大小上限 10 MB。</p>
          </div>
        ) : null}

        {batch && step === 2 ? (
          <>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, marginBottom: 12 }}>
              <div>
                <div className="card-title">预检报告</div>
                <div className="card-sub">{batch.fileName} · 数据行 {batch.totalRows}</div>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button type="button" className="btn btn-sm" onClick={download} disabled={pending}><Icon name="download" /> 回流文件</button>
                <button type="button" className="btn btn-sm" onClick={() => router.replace("/users/import")}>重新上传</button>
                <button type="button" className="btn btn-sm btn-primary" onClick={() => setConfirming(true)} disabled={batch.newRows === 0}>确认写入 <Icon name="arrowRight" /></button>
              </div>
            </div>
            <div className="stat-grid" style={{ marginBottom: 14 }}>
              <div className="stat"><div className="stat-label">新增</div><div className="stat-value">{batch.newRows}</div><div className="stat-hint">确认后创建</div></div>
              <div className="stat"><div className="stat-label">错误</div><div className="stat-value">{batch.errorRows}</div><div className="stat-hint">回流修改后重传</div></div>
              <div className="stat"><div className="stat-label">跳过</div><div className="stat-value">{batch.skippedRows}</div><div className="stat-hint">越权行，不让整批失败</div></div>
              <div className="stat"><div className="stat-label">总行数</div><div className="stat-value">{batch.totalRows}</div><div className="stat-hint">≤ 1,000</div></div>
            </div>
            <Callout icon="shield" style={{ marginBottom: 14 }}>越权行进「跳过」清单，不让整批失败；手机号已存在（待激活 / 有效）的行标记为「手机号已存在」，不静默改角色或范围。</Callout>
            <div className="filter-line" style={{ marginBottom: 10 }}>
              {([["all", "全部"], ["new", "可写入"], ["error", "错误"], ["skip", "跳过"]] as const).map(([v, l]) => (
                <button key={v} type="button" className={`chip ${filter === v ? "active" : ""}`} onClick={() => { setFilter(v); setShown(SHOW_STEP); }}>{l}</button>
              ))}
            </div>
            <div className="table-wrap user-import-table">
              <table>
                <thead><tr><th>行</th><th>用户</th><th>手机号</th><th>品牌</th><th>分公司 · 门店</th><th>结果</th><th>原因</th></tr></thead>
                <tbody>
                  {rows.slice(0, shown).map((r) => (
                    <tr key={r.rowNo}>
                      <td className="num">{r.rowNo}</td>
                      <td><div className="cell-main">{r.name || "—"}</div><div className="cell-sub">{r.role}</div></td>
                      <td className="num">{r.phone || "—"}</td>
                      <td>{r.brand ? r.brand.split(/[;；、|]/).map((b) => <span key={b} className="tag" style={{ marginRight: 4 }}>{b}</span>) : "—"}</td>
                      <td>{r.scope || "—"}</td>
                      <td>{r.kind === "new" ? <Badge tone="green">可写入</Badge> : r.kind === "skip" ? <Badge tone="amber">跳过</Badge> : <Badge tone="red">错误</Badge>}</td>
                      <td>{r.reason ? <><div className="reason-text">{IMPORT_REASON_LABEL[r.reason] ?? r.reason}</div><div className="reason-code">{r.reason}</div></> : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {rows.length > shown ? (
              <div style={{ textAlign: "center", marginTop: 10 }}><button type="button" className="btn btn-sm" onClick={() => setShown((n) => n + SHOW_STEP)}>再显示 {Math.min(SHOW_STEP, rows.length - shown)} 行（共 {rows.length} 行）</button></div>
            ) : null}
            <Callout icon="alert" style={{ marginTop: 14 }}>回流文件由提交人本人下载，只含本次提交的行；不占用「导出」权限。确认时会重新校验全部行；若有人先建了同号用户，该行标记为「手机号已存在」。</Callout>
          </>
        ) : null}

        {batch && step === 3 ? (
          <>
            <Callout icon="alert" tone="warn" style={{ marginBottom: 14 }}>确认后同步写入 {batch.newRows} 个用户；每行走与单个邀请相同的创建逻辑，逐条记审计。任一行的审计写入失败，该行整体回滚，其余行继续。</Callout>
            <div className="info-grid">
              <div><div className="info-label">将创建</div><div className="info-value num">{batch.newRows}</div></div>
              <div><div className="info-label">跳过</div><div className="info-value num">{batch.skippedRows}</div></div>
              <div><div className="info-label">错误回流</div><div className="info-value num">{batch.errorRows}</div></div>
              <div><div className="info-label">短信</div><div className="info-value">不发；用户自己到激活入口请求验证码</div></div>
            </div>
            {error ? <div className="callout danger" role="alert" style={{ marginTop: 14 }}><Icon name="alert" /><span>{error.message}（错误码 {error.code}）</span></div> : null}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
              <button type="button" className="btn" onClick={() => setConfirming(false)} disabled={pending || batch.status === "writing"}>上一步</button>
              <button type="button" className="btn btn-primary" onClick={confirm} disabled={pending}><Icon name="check" /> {pending ? "写入中…" : batch.status === "writing" ? "继续写入" : "确认写入"}</button>
            </div>
          </>
        ) : null}

        {batch && step === 4 ? (
          <div className="state">
            <div className="state-icon"><Icon name="check" /></div>
            <div className="state-title">批次已完成</div>
            <p className="state-text">已创建 {batch.rows.filter((r) => r.outcome === "imported").length} 个待激活用户；{batch.skippedRows} 行越权跳过，{batch.errorRows} 行有错误{batch.conflictRows ? `，${batch.conflictRows} 行确认时冲突` : ""}。用户会自己到激活入口请求验证码。</p>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center" }}>
              <Link className="btn" href="/users">查看用户列表</Link>
              <button type="button" className="btn btn-primary" onClick={download} disabled={pending}><Icon name="download" /> 下载回流文件</button>
            </div>
          </div>
        ) : null}

        {step !== 3 && error ? <div className="callout danger" role="alert" style={{ marginTop: 14 }}><Icon name="alert" /><span>{error.message}（错误码 {error.code}）</span></div> : null}
      </div>
    </div>
  );
}
