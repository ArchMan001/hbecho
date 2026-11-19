"use client";
// 活动计划判定结果页里需要浏览器状态的几块：搜索框、图片放大、跳到能力列、导出对话框。其余都是服务端渲染。
// 下拉直接用 square.tsx 的 SquareSelect（通用的「单选 + 地址即状态」），不另写一份。
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Dialog } from "./dialog";
import { Icon } from "./icon";
import { useToast } from "./toast";

/** 专员姓名 / 门店编码搜索：提交即跳转（地址即状态）；hrefBase 是去掉 q 之后的地址。 */
export function ReportSearch({ value, hrefBase, disabled = false }: { value: string; hrefBase: string; disabled?: boolean }) {
  const router = useRouter();
  const [text, setText] = useState(value);
  function submit(e: FormEvent) {
    e.preventDefault();
    const q = text.trim();
    router.push(q ? `${hrefBase}${hrefBase.includes("?") ? "&" : "?"}q=${encodeURIComponent(q)}` : hrefBase, { scroll: false });
  }
  return (
    <form className="el-search" role="search" onSubmit={submit}>
      <label className="top-search" style={{ minWidth: 220 }}>
        <Icon name="search" />
        <input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="专员姓名 / 门店编码" aria-label="搜索专员" disabled={disabled} maxLength={50} />
      </label>
      <button className="btn btn-sm" type="submit" disabled={disabled}>
        搜索
      </button>
    </form>
  );
}

const SHAPE = { cover: "el-thumb", avatar: "el-thumb el-thumb-avatar", background: "el-thumb el-thumb-background" } as const;
/** 缩略图：点击放大。图片只用签名链接；没有图（缺失、未归档、签名失败）显示占位，不让整行失败。 */
export function Thumb({ kind, src, label }: { kind: keyof typeof SHAPE; src?: string | undefined; label: string }) {
  const [open, setOpen] = useState(false);
  if (!src)
    return (
      <span className={`${SHAPE[kind]} is-empty`} title={`${label}：暂无图片`}>
        <Icon name="image" />
      </span>
    );
  return (
    <>
      <button type="button" className={SHAPE[kind]} onClick={() => setOpen(true)} aria-label={`放大查看${label}`}>
        {/* 签名链接 5 分钟有效，不走 next/image 的优化与缓存 */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt="" loading="lazy" />
      </button>
      {open ? (
        <Dialog open title={label} onClose={() => setOpen(false)} foot={<button type="button" className="btn btn-primary" onClick={() => setOpen(false)}>关闭</button>}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="el-zoom" src={src} alt={label} />
        </Dialog>
      ) : null}
    </>
  );
}

/** 表格可以左右滚动；能力列在最右，给审阅的人一个直达的按钮。 */
export function JumpToAbility({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <p className="filter-note el-hint">
      表格可左右滚动；青色表头的 {count} 列是按判定计划设定生成的能力列。
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => {
          const box = document.querySelector<HTMLElement>(".el-scroll");
          const th = box?.querySelector<HTMLElement>("th.is-ability");
          if (box && th) box.scrollTo({ left: th.offsetLeft - 120, behavior: "smooth" });
        }}
      >
        跳到能力列 ›
      </button>
    </p>
  );
}

interface Preview {
  fileName: string;
  warnings: string[];
  videoRows: number;
  accountRows: number;
  tooMany: boolean;
  limits: { videoRows: number; accountRows: number };
  videoColumns: Array<{ header: string; kind: string }>;
  accountColumns: Array<{ header: string; kind: string }>;
}
const WARN_TEXT: Record<string, string> = {
  videos_pruned: "视频明细 sheet 不生成：这次执行的内容明细已过保留期。",
  abilities_unavailable: "账号能力列为空：该执行早于「账号能力结果」功能，重新执行后可见。",
};
const num = (v: number) => v.toLocaleString("en-US");
function Heads({ cols }: { cols: Preview["videoColumns"] }) {
  return (
    <div className="el-headlist">
      {cols.map((c, i) => (
        <span key={i} className={`chip ${c.kind === "fixed" ? "" : "active"}`}>
          {c.header}
        </span>
      ))}
    </div>
  );
}
/** 导出：先取预览（文件名、行数、警告、两张表的表头），确认后下载；错误留在弹窗里显示人话。 */
export function ExportButton({ previewHref, downloadHref }: { previewHref: string; downloadHref: string }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function openPreview() {
    setOpen(true);
    setPreview(null);
    setError(null);
    try {
      const res = await fetch(previewHref, { cache: "no-store" });
      const body = await res.json();
      if (!res.ok) setError(body.message ?? "无法生成导出预览");
      else setPreview(body as Preview);
    } catch {
      setError("网络异常，请稍后重试");
    }
  }
  async function download() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(downloadHref, { cache: "no-store" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.message ?? "导出失败，请稍后重试");
        return;
      }
      const blob = await res.blob();
      const m = /filename\*=UTF-8''([^;]+)/.exec(res.headers.get("content-disposition") ?? "");
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = m ? decodeURIComponent(m[1]!) : "全量明细.xlsx";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(a.href);
      setOpen(false);
      toast("已开始下载");
    } catch {
      setError("导出中断，没有得到完整的文件，请重试");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button type="button" className="btn btn-primary" onClick={openPreview}>
        <Icon name="download" /> 导出 Excel
      </button>
      <Dialog
        open={open}
        title="导出 Excel"
        onClose={() => setOpen(false)}
        foot={
          <>
            <button type="button" className="btn" onClick={() => setOpen(false)}>
              取消
            </button>
            <button type="button" className="btn btn-primary" disabled={busy || !preview || preview.tooMany} onClick={download}>
              {busy ? "正在生成…" : "开始导出"}
            </button>
          </>
        }
      >
        {error ? (
          <div className="callout danger">
            <Icon name="alert" />
            <span>{error}</span>
          </div>
        ) : null}
        {!preview && !error ? <p className="page-sub">正在准备…</p> : null}
        {preview ? (
          <>
            {preview.tooMany ? (
              <div className="callout danger">
                <Icon name="alert" />
                <span>
                  视频明细 {num(preview.videoRows)} 行或账号维度 {num(preview.accountRows)} 行，超过上限（{num(preview.limits.videoRows)} / {num(preview.limits.accountRows)}）。请先用筛选缩小范围，不会生成任何文件。
                </span>
              </div>
            ) : null}
            <p className="page-sub">
              导出当前执行与<b>当前筛选</b>下的全部行；一个文件、两个 sheet；<b>不含图片</b>。文件名：<code>{preview.fileName}</code>
            </p>
            {preview.warnings.map((w) => (
              <div key={w} className="callout warn" style={{ marginTop: 8 }}>
                <Icon name="alert" />
                <span>{WARN_TEXT[w] ?? w}</span>
              </div>
            ))}
            <h4 className="el-h">sheet 1 · 视频明细 · {preview.warnings.includes("videos_pruned") ? "不生成" : `${num(preview.videoRows)} 行`}</h4>
            {preview.warnings.includes("videos_pruned") ? null : <Heads cols={preview.videoColumns} />}
            <h4 className="el-h">sheet 2 · 账号维度 · {num(preview.accountRows)} 行</h4>
            <Heads cols={preview.accountColumns} />
            <p className="filter-note" style={{ marginTop: 10 }}>
              高亮的是按判定计划设定生成的能力列。内容 ID、门店编码写成文本；时间为北京时间；以 = + - @ 开头的文本自动加前缀。
            </p>
          </>
        ) : null}
      </Dialog>
    </>
  );
}
