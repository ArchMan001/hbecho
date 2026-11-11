"use client";
// 资料详情：内联预览（本服务转发，见 playback.ts 的说明）+ 下载原件。预览不记审计，下载记审计。
// 微信内置浏览器不允许网页触发文件下载（G-D35）：按钮改成「复制链接，在浏览器打开」的提示。
import { useEffect, useRef, useState } from "react";
import { downloadAction } from "../../_actions/learning";
import { Icon } from "../icon";
import { useToast } from "../toast";

const isWeChat = () => typeof navigator !== "undefined" && /MicroMessenger/i.test(navigator.userAgent);

export function DocumentView({ courseId, mime, title }: { courseId: string; mime: string; title: string }) {
  const src = `/api/learning/courses/${courseId}/preview`;
  const toast = useToast();
  const [wechat, setWechat] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const opened = useRef(false);
  useEffect(() => {
    setWechat(isWeChat());
    if (opened.current) return;
    opened.current = true;
    // 记「打开」：首末时间与打开次数（资料不计时长）
    void fetch("/api/learning/progress", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ courseId, positionSec: 0, deltaWatchedSec: 0, started: true }), keepalive: true }).catch(() => undefined);
  }, [courseId]);

  const download = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await downloadAction(courseId);
      if (!r.ok) setError({ code: r.code, message: r.message });
      else window.location.assign(r.data.url);
    } catch {
      setError({ code: "network_error", message: "请求没有完成，请检查网络后重试" });
    } finally {
      setBusy(false);
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      toast("链接已复制，请到手机浏览器粘贴打开");
    } catch {
      toast("复制失败，请长按地址栏手动复制");
    }
  };

  return (
    <>
      <div className="doc-preview">
        {mime === "application/pdf" ? (
          <iframe title={`${title} 预览`} src={src} style={{ width: "100%", height: "70vh", border: 0, borderRadius: 10, background: "#fff" }} />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img alt={title} src={src} style={{ maxWidth: "100%", borderRadius: 10 }} />
        )}
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
        <a className="btn" href={src} target="_blank" rel="noreferrer">
          <Icon name="file" /> 在新窗口打开
        </a>
        {wechat ? (
          <button type="button" className="btn" onClick={copy}>
            <Icon name="download" /> 复制链接，在浏览器打开
          </button>
        ) : (
          <button type="button" className="btn" onClick={download} disabled={busy}>
            <Icon name="download" /> {busy ? "准备中…" : "下载原件"}
          </button>
        )}
      </div>
      {wechat ? (
        <div className="callout" style={{ marginTop: 12 }}>
          <Icon name="alert" />
          <span>微信内不能直接下载文件。请复制链接，到手机浏览器里打开后再下载。</span>
        </div>
      ) : null}
      {error ? (
        <div className="callout danger" role="alert" style={{ marginTop: 12 }}>
          <Icon name="alert" />
          <span>
            {error.message}（错误码 {error.code}）
          </span>
        </div>
      ) : null}
    </>
  );
}
