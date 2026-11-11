"use client";
// 视频播放：点击才取播放凭证并起播（不自动播放，G-D38）；凭证每次现取；阿里云 Web 播放器 SDK 用 CDN 脚本加载（ADR-0017）。
// 进度：起播上报一次 started；播放中每 15 秒心跳；暂停 / 结束 / 切后台 / 关页前补报。位置取最后上报值，不做回退保护。
import { useCallback, useEffect, useRef, useState } from "react";
import { getPlaybackAction } from "../../_actions/learning";
import { clock } from "../../_lib/learning-labels";
import { Icon } from "../icon";

const PLAYER_VERSION = "2.25.1";
const CDN = `https://g.alicdn.com/apsara-media-box/imp-web-player/${PLAYER_VERSION}`;
const HEARTBEAT_MS = 15_000;

interface AliplayerInstance {
  on(ev: string, cb: (...a: unknown[]) => void): void;
  getCurrentTime(): number;
  seek(sec: number): void;
  dispose(): void;
}
declare global {
  interface Window {
    Aliplayer?: new (cfg: Record<string, unknown>, ready?: (p: AliplayerInstance) => void) => AliplayerInstance;
  }
}

let sdk: Promise<void> | undefined;
function loadSdk(): Promise<void> {
  if (window.Aliplayer) return Promise.resolve();
  return (sdk ??= new Promise<void>((resolve, reject) => {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = `${CDN}/skins/default/aliplayer-min.css`;
    document.head.appendChild(css);
    const js = document.createElement("script");
    js.charset = "utf-8";
    js.src = `${CDN}/aliplayer-min.js`;
    js.onload = () => resolve();
    js.onerror = () => {
      sdk = undefined; // 允许重试
      reject(new Error("player_sdk_load_failed"));
    };
    document.head.appendChild(js);
  }));
}

export interface PlayerProps {
  courseId: string;
  durationSec: number | null;
  positionSec: number;
  /** 课程当前的 VOD 状态；非 normal 时不可点击，学员侧列表本来就看不到，这里兜底直链。 */
  vodVideoStatus: string | null;
  license?: { domain: string; key: string } | undefined;
}

export function CoursePlayer({ courseId, durationSec, positionSec, vodVideoStatus, license }: PlayerProps) {
  const [phase, setPhase] = useState<"idle" | "loading" | "playing">("idle");
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const player = useRef<AliplayerInstance | null>(null);
  const state = useRef({ playing: false, lastTick: 0, started: false });

  const report = useCallback(
    (beacon: boolean, started = false) => {
      const s = state.current;
      const now = Date.now();
      const delta = s.playing && s.lastTick ? Math.round((now - s.lastTick) / 1000) : 0;
      if (s.playing) s.lastTick = now;
      const body = JSON.stringify({ courseId, positionSec: Math.max(0, Math.floor(player.current?.getCurrentTime() ?? 0)), deltaWatchedSec: Math.max(0, delta), started });
      if (beacon && navigator.sendBeacon) navigator.sendBeacon("/api/learning/progress", new Blob([body], { type: "application/json" }));
      else void fetch("/api/learning/progress", { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true }).catch(() => undefined);
    },
    [courseId],
  );

  useEffect(() => {
    const flush = () => {
      if (player.current) report(true);
    };
    const onHide = () => document.visibilityState === "hidden" && flush();
    const timer = setInterval(() => state.current.playing && report(false), HEARTBEAT_MS);
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", flush);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", flush);
      flush();
      player.current?.dispose();
      player.current = null;
    };
  }, [report]);

  const start = async () => {
    setError(null);
    setPhase("loading");
    try {
      const r = await getPlaybackAction(courseId);
      if (!r.ok) throw Object.assign(new Error(r.message), { code: r.code });
      if (r.data.state === "processing" || r.data.kind !== "video") throw Object.assign(new Error("视频还在转码，转码完成后自动可播"), { code: "video_processing" });
      await loadSdk();
      const { videoId, playAuth, positionSec: resume } = r.data;
      setPhase("playing");
      // 容器一直在 DOM 里（playing 时才显示）；等两帧让它真正可见、有宽度，再交给播放器
      await new Promise<void>((res) => requestAnimationFrame(() => requestAnimationFrame(() => res())));
      const P = window.Aliplayer;
      if (!P) throw Object.assign(new Error("播放器没有加载成功"), { code: "player_sdk_load_failed" });
      const p = new P({ id: `player-${courseId}`, width: "100%", height: "420px", vid: videoId, playauth: playAuth, autoplay: true, ...(license ? { license } : {}) }, (inst) => {
        if (resume > 3) inst.seek(Math.max(0, resume - 2)); // 从上次位置前几秒继续
      });
      player.current = p;
      p.on("play", () => {
        const s = state.current;
        s.playing = true;
        s.lastTick = Date.now();
        if (!s.started) {
          s.started = true;
          report(false, true);
        }
      });
      const stop = () => {
        report(false);
        state.current.playing = false;
      };
      p.on("pause", stop);
      p.on("ended", stop);
      p.on("error", () => {
        state.current.playing = false;
        setError({ code: "player_error", message: "视频播放出错。播放凭证过期的话，刷新页面后重新点击播放即可" });
      });
    } catch (e) {
      setPhase("idle");
      const err = e as Error & { code?: string };
      setError({ code: err.code ?? "unknown", message: err.message || "暂时无法播放，请稍后重试" });
    }
  };

  const blocked = vodVideoStatus !== null && vodVideoStatus !== "normal";
  const pct = durationSec ? Math.min(100, Math.round((positionSec / durationSec) * 100)) : 0;
  return (
    <div className={`player ${blocked ? "is-disabled" : ""}`}>
      <div id={`player-${courseId}`} style={{ display: phase === "playing" ? "block" : "none" }} />
      {phase !== "playing" ? (
        <div className="player-cover">
          {blocked ? (
            <div className="player-state">
              <Icon name={vodVideoStatus === "failed" ? "alert" : "clock"} />
              <strong>{vodVideoStatus === "failed" ? "转码失败，暂不可播放" : "转码中，暂不可播放"}</strong>
              <span>{vodVideoStatus === "failed" ? "维护者需要替换文件后才能播放。" : "课程已发布，转码完成后自动可播。"}</span>
            </div>
          ) : (
            <button type="button" className="player-btn" onClick={start} disabled={phase === "loading"} aria-label={positionSec > 0 ? `从 ${clock(positionSec)} 继续播放` : "开始播放"}>
              <Icon name="play" />
            </button>
          )}
        </div>
      ) : null}
      <div className="player-bar">
        <div className="player-progress" style={{ width: `${pct}%` }} />
      </div>
      <div className="player-foot">
        <span>{blocked ? "转码完成后自动可播" : positionSec > 0 && durationSec ? `上次看到 ${clock(positionSec)} / ${clock(durationSec)}` : durationSec ? clock(durationSec) : ""}</span>
        <span>{blocked ? "暂不可播放" : phase === "loading" ? "正在准备播放…" : "点击播放，不自动播放"}</span>
      </div>
      {error ? (
        <div className="callout danger" role="alert" style={{ margin: 12 }}>
          <Icon name="alert" />
          <span>
            {error.message}（错误码 {error.code}）
          </span>
        </div>
      ) : null}
    </div>
  );
}
