// 任务 12：`signals run` 循环。真实 MySQL + 假依赖；睡眠由测试控制，停止信号由 AbortController 给出。
import { count } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { signalResults } from "../db/schema";
import { useTestDb } from "../../tests/harness/db";
import { insertAccount } from "../../tests/harness/factories";
import { SIGNALS_T0 as T0, seedContent } from "../../tests/harness/signals";
import { actor, content, createWorld, makeSubject } from "../../tests/harness/signals-world";
import { runSignalsLoop, type SignalsLoopDeps } from "./signals-loop";

const t = useTestDb();

function harness(w: Awaited<ReturnType<typeof createWorld>>, o: { signals?: SignalsLoopDeps["signals"]; stopAfterSleeps: number }) {
  const stop = new AbortController();
  const logs: Array<{ event: Record<string, unknown>; message: string }> = [];
  let ms = 1_000_000;
  let sleeps = 0;
  const deps: SignalsLoopDeps = {
    signals: o.signals ?? w.signals,
    nowMs: () => ms,
    log: (event, message) => void logs.push({ event, message }),
    sleep: async (d) => {
      ms += d;
      if (++sleeps >= o.stopAfterSleeps) stop.abort();
    },
  };
  return { stop, deps, logs, sleeps: () => sleeps };
}

describe("signals run", () => {
  it("入库 → 扫描 → 读到；任务被领取并写出结果行；首轮跑一次清理；空闲时睡眠，收到停止信号后退出", async () => {
    const w = await createWorld(t);
    const acct = await insertAccount(t.db, "douyin", T0);
    const c = await seedContent(t.db, { accountId: acct, pcid: "loop", title: "循环标题" });
    const s = await makeSubject(t, "archived");
    await w.signals.requestScores(actor, w.plan, [content(s.id)]);

    const h = harness(w, { stopAfterSleeps: 1 });
    await runSignalsLoop(h.deps, h.stop.signal);

    expect(await w.signals.reader.read(actor, content(c.contentId), "text.title_normalized")).toMatchObject({ state: "valid", value: "循环标题" });
    expect((await t.db.select({ n: count() }).from(signalResults))[0]!.n).toBe(1); // 评分任务已执行
    expect(h.logs.filter((l) => l.message === "signals.retention")).toHaveLength(1);
    expect(h.sleeps()).toBe(1); // 先有活干（不睡），领不到任务才睡
  });

  it("没有到间隔不重复扫描；到了间隔再扫；清理一天一次", async () => {
    const w = await createWorld(t); // scanIntervalMs = 1000，睡眠每次推进 1000
    let scans = 0;
    const signals = { ...w.signals, scanner: { ...w.signals.scanner, contents: async () => (scans++, w.signals.scanner.contents()) } };
    const h = harness(w, { signals, stopAfterSleeps: 3 });
    await runSignalsLoop(h.deps, h.stop.signal);
    expect(scans).toBe(3); // 每次睡醒都已过一个扫描间隔
    expect(h.logs.filter((l) => l.message === "signals.retention")).toHaveLength(1); // 3 秒内不到一天
  });

  it("某一步抛错只记日志，循环继续、其余步骤照常", async () => {
    const w = await createWorld(t);
    const acct = await insertAccount(t.db, "douyin", T0);
    const c = await seedContent(t.db, { accountId: acct, pcid: "boom", title: "仍然入库" });
    const signals = { ...w.signals, scanner: { ...w.signals.scanner, contents: async () => { throw new Error("boom"); } } };
    const h = harness(w, { signals, stopAfterSleeps: 2 });
    await runSignalsLoop(h.deps, h.stop.signal);
    expect(h.logs.filter((l) => l.message === "signals.step_failed" && l.event.step === "scan_contents")).toHaveLength(2);
    // 扫描内容坏了，对账仍然把存量补上
    expect(await w.signals.reader.read(actor, content(c.contentId), "text.title_normalized")).toMatchObject({ state: "valid", value: "仍然入库" });
  });

  it("停止信号已发出时不执行任何一步", async () => {
    const w = await createWorld(t);
    const h = harness(w, { stopAfterSleeps: 1 });
    h.stop.abort();
    await runSignalsLoop(h.deps, h.stop.signal);
    expect(h.logs).toEqual([]);
    expect(h.sleeps()).toBe(0);
  });
});
