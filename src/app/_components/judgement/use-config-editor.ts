"use client";
// 向导的配置编辑状态：本地即时更新，防抖后整份保存到服务端（一次只有一个保存在途，期间的新改动合并成下一次）。
// 本地配置在草稿存续期间是权威：服务端刷新（router.refresh）只更新圈定 / 试跑结果与步骤，不覆盖正在编辑的内容。
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Config } from "../../../modules/judgement/config";
import { saveJudgementConfig } from "../../_actions/judgement";

export type SaveState = { kind: "saved" } | { kind: "dirty" } | { kind: "saving" } | { kind: "error"; code: string; message: string };

export function useConfigEditor(planId: string, initial: Config, editable: boolean) {
  const [config, setConfig] = useState<Config>(initial);
  const [state, setState] = useState<SaveState>({ kind: "saved" });
  const latest = useRef(initial);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const inflight = useRef<Promise<void> | null>(null);
  const router = useRouter();

  /** 保存当前最新配置；返回是否已保存成功（给「确认圈定 / 开始试跑 / 上传」在动作前同步用）。 */
  const flush = useCallback(async (): Promise<boolean> => {
    clearTimeout(timer.current);
    while (inflight.current) await inflight.current;
    const sent = latest.current;
    setState({ kind: "saving" });
    let ok = false;
    const p = (async () => {
      let r: Awaited<ReturnType<typeof saveJudgementConfig>>;
      try {
        r = await saveJudgementConfig(planId, sent);
      } catch {
        r = { ok: false, code: "network_error", message: "请求没有完成，请检查网络后重试" };
      }
      if (r.ok) {
        ok = true;
        // 保存期间又有新的改动：留给下一轮防抖，不在这里覆盖状态
        setState(latest.current === sent ? { kind: "saved" } : { kind: "dirty" });
        router.refresh();
      } else setState({ kind: "error", code: r.code, message: r.message });
    })();
    inflight.current = p;
    await p;
    inflight.current = null;
    if (ok && latest.current !== sent) return flush();
    return ok && latest.current === sent;
  }, [planId, router]);

  const edit = useCallback(
    (f: (c: Config) => Config, o: { now?: boolean } = {}) => {
      if (!editable) return;
      const next = f(latest.current);
      if (next === latest.current) return;
      latest.current = next;
      setConfig(next);
      setState({ kind: "dirty" });
      clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), o.now ? 0 : 600);
    },
    [editable, flush],
  );
  useEffect(() => () => clearTimeout(timer.current), []);
  return { config, state, edit, flush, busy: state.kind === "saving" || state.kind === "dirty" };
}
export type ConfigEditor = ReturnType<typeof useConfigEditor>;
