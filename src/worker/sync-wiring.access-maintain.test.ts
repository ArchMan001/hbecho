// 访问控制维护在常驻循环里被调度，且不依赖 OSS 维护（任务 7：无 OSS 配置的装配里 accessMaintain 仍被调度）。
import { describe, expect, it, vi } from "vitest";
import { runForever, type SyncApp } from "./sync-wiring";
import type { SyncWorkerConfig } from "./sync-config";

function harness() {
  let endRun!: () => void;
  const signals = new Map<string, () => void>();
  const errors: unknown[] = [];
  const app = {
    scheduler: { tick: async () => {} },
    worker: {
      run: () => new Promise((r) => { endRun = () => r({}); }),
      stop: async () => { endRun(); return { abandoned: 0 }; },
    },
    logger: { info: () => {}, warn: () => {}, error: (o: unknown) => void errors.push(o) },
  } as unknown as SyncApp;
  const sig = { on: (s: "SIGTERM" | "SIGINT", f: () => void) => void signals.set(s, f) };
  return { app, sig, signals, errors };
}
const cfg = { graceMs: 10 } as SyncWorkerConfig;

describe("runForever 的访问控制维护", () => {
  it("只传 accessMaintain（没有 OSS 维护）也会被调用", async () => {
    const h = harness();
    const accessMaintain = vi.fn(async () => {});
    const done = runForever(h.app, cfg, h.sig, { accessMaintain });
    await vi.waitFor(() => expect(accessMaintain).toHaveBeenCalled());
    h.signals.get("SIGTERM")!();
    await done;
  });

  it("accessMaintain 抛错只记日志，不拖垮循环，也不影响 ODS 维护", async () => {
    const h = harness();
    const maintain = vi.fn(async () => {});
    const accessMaintain = vi.fn(async () => { throw new Error("boom"); });
    const done = runForever(h.app, cfg, h.sig, { maintain, accessMaintain });
    await vi.waitFor(() => expect(accessMaintain).toHaveBeenCalled());
    expect(maintain).toHaveBeenCalled();
    expect(h.errors.length).toBeGreaterThan(0);
    h.signals.get("SIGTERM")!();
    await done;
  });
});
