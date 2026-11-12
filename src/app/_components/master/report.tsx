"use client";
// 主数据预检报告的交互部分：待确认撤店的勾选、下载回流文件、确认写入（第 4 步弹窗）。
// 勾选状态在 Provider 里，顶部操作条与撤店表共用；预检只读，不勾选就一家店都不会关闭（design §7.5）。
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createContext, useContext, useState, useTransition, type ReactNode } from "react";
import { confirmMasterImport, masterReturnFile } from "../../_actions/master-data";
import { Dialog } from "../dialog";
import { Icon } from "../icon";
import { saveCsv } from "../plans/download";
import { useToast } from "../toast";
import { Callout } from "../ui";

export interface ClosureItem {
  storeId: string;
  code: string;
  name: string;
  brand: string;
  dealerCode: string;
  sectorCode: string;
}
interface Ctx {
  selected: string[];
  toggle(id: string): void;
  all(on: boolean): void;
}
const C = createContext<Ctx | null>(null);
const useSel = (): Ctx => {
  const c = useContext(C);
  if (!c) throw new Error("ClosureProvider 缺失");
  return c;
};
export function ClosureProvider({ items, children }: { items: ClosureItem[]; children: ReactNode }) {
  const [selected, setSelected] = useState<string[]>([]); // 默认一个都不勾
  const toggle = (id: string) => setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  const all = (on: boolean) => setSelected(on ? items.map((i) => i.storeId) : []);
  return <C.Provider value={{ selected, toggle, all }}>{children}</C.Provider>;
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

export interface ConfirmFacts {
  batchId: string;
  modeLabel: string;
  fileName: string;
  totalRows: number;
  newCount: number;
  updateCount: number;
  notImported: number;
  errorCount: number;
  needsCount: number;
}

export function ReportBar({ facts, hasReturnRows }: { facts: ConfirmFacts; hasReturnRows: boolean }) {
  const { selected } = useSel();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<Err | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const toast = useToast();
  const download = () =>
    start(async () => {
      const r = await masterReturnFile(facts.batchId);
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
      let r: Awaited<ReturnType<typeof confirmMasterImport>>;
      try {
        r = await confirmMasterImport(facts.batchId, selected);
      } catch {
        r = { ok: false, code: "network_error", message: "请求没有完成；已写入的行不会重复写入，刷新后可继续确认" };
      }
      if (!r.ok) {
        setError(r);
        return;
      }
      setOpen(false);
      toast(r.data.closed ? `已确认写入，关闭了 ${r.data.closed} 家门店` : "已确认写入");
      router.push(`/master-data/batches/${facts.batchId}`);
    });
  return (
    <>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {hasReturnRows ? <button type="button" className="btn btn-sm" onClick={download} disabled={pending}><Icon name="download" /> 下载回流文件</button> : null}
        <Link className="btn btn-sm" href="/master-data/import">重新上传</Link>
        <button type="button" className="btn btn-sm btn-primary" onClick={() => { setError(null); setOpen(true); }}>
          确认写入 <Icon name="arrowRight" />
        </button>
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
        <Callout icon="alert" tone="warn" style={{ marginBottom: 14 }}>确认后是本批次唯一的写入点；分块写入，中断后可续跑，已写入的行不会重复写入。</Callout>
        <div className="info-grid">
          <div><div className="info-label">模式</div><div className="info-value">{facts.modeLabel}</div></div>
          <div><div className="info-label">文件</div><div className="info-value">{facts.fileName}</div></div>
          <div><div className="info-label">数据行</div><div className="info-value num">{facts.totalRows.toLocaleString("en-US")}</div></div>
          <div><div className="info-label">将新增门店</div><div className="info-value num">{facts.newCount.toLocaleString("en-US")}</div></div>
          <div><div className="info-label">将更新门店</div><div className="info-value num">{facts.updateCount.toLocaleString("en-US")}</div></div>
          <div><div className="info-label">将关闭门店</div><div className="info-value num">{selected.length}{selected.length ? "（你勾选的）" : "（未勾选，不关店）"}</div></div>
          <div><div className="info-label">不导入的行</div><div className="info-value num">{facts.notImported.toLocaleString("en-US")}（错误 {facts.errorCount} + 需超管处理 {facts.needsCount}）</div></div>
        </div>
        {selected.length ? <Callout icon="alert" tone="danger" style={{ marginTop: 14 }}>将关闭 {selected.length} 家门店；关闭后门店不再进入监控，可由后续导入恢复。</Callout> : null}
        {error ? <ErrorBox error={error} /> : null}
      </Dialog>
    </>
  );
}

export function ClosureTable({ items }: { items: ClosureItem[] }) {
  const { selected, toggle, all } = useSel();
  if (items.length === 0) return null;
  return (
    <>
      <div className="section-note">待确认撤店 · {items.length} 家</div>
      <Callout icon="alert" tone="warn" style={{ marginBottom: 10 }}>
        下面这些门店库里仍在用，但这份文件里没有。<strong>不会自动关店</strong>；勾选的才会在确认时关闭，默认一个都不勾。范围只取文件里出现的品牌。
      </Callout>
      <div className="table-wrap" style={{ marginBottom: 6 }}>
        <table>
          <thead>
            <tr>
              <th style={{ width: 42 }}><input type="checkbox" aria-label="全选" checked={selected.length === items.length} onChange={(e) => all(e.target.checked)} /></th>
              <th>门店</th><th>品牌</th><th>所属商家渠道编码</th><th>板块编码</th>
            </tr>
          </thead>
          <tbody>
            {items.map((s) => (
              <tr key={s.storeId}>
                <td><input type="checkbox" aria-label={`关闭 ${s.name}`} checked={selected.includes(s.storeId)} onChange={() => toggle(s.storeId)} /></td>
                <td><div className="cell-main">{s.name}</div><div className="cell-sub">{s.code}</div></td>
                <td>{s.brand}</td><td className="num">{s.dealerCode}</td><td className="num">{s.sectorCode}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="cell-sub" style={{ marginBottom: 14 }}>已勾选 <strong className="num">{selected.length}</strong> / {items.length} 家将在确认时关闭。</div>
    </>
  );
}

/** 批次详情页的回流文件按钮。 */
export function ReturnFileButton({ batchId }: { batchId: string }) {
  const [error, setError] = useState<Err | null>(null);
  const [pending, start] = useTransition();
  const toast = useToast();
  const go = () =>
    start(async () => {
      setError(null);
      const r = await masterReturnFile(batchId);
      if (!r.ok) {
        setError(r);
        return;
      }
      saveCsv(r.data.fileName, r.data.csv);
      toast(`已下载回流文件（${r.data.rows} 行）`);
    });
  return (
    <>
      <button type="button" className="btn" onClick={go} disabled={pending}><Icon name="download" /> 回流文件</button>
      {error ? <span className="hint" role="alert" style={{ color: "#B42318" }}>{error.message}（错误码 {error.code}）</span> : null}
    </>
  );
}
