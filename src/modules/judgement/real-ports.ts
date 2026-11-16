// D 的两个端口的真实封装：只转调，不加逻辑。D 与 C / A 的所有交互都经这两个端口，离线测试用 fakes.ts 里的 fake。
// 真实 C 是否满足端口约定由 tests/contracts/signals-port.contract.ts 验证（同一份契约跑 fake 与真实）。
import type { DemandModule } from "../demand";
import { normalizeKeyword, platformSignals, type Signals } from "../signals";
import type { DemandPort, SignalsPort } from "./ports";

export function realSignalsPort(signals: Pick<Signals, "segments" | "reader" | "requestScores" | "retention">): SignalsPort {
  return {
    platformSignals: (platform) => new Set(platformSignals(platform)),
    executability: (actor, ref, o) => signals.segments.executability(actor, ref, o),
    segments: signals.segments,
    requestScores: (actor, ref, subjects, ctx) => signals.requestScores(actor, ref, subjects, ctx),
    readMany: (actor, subjects, key, o) => signals.reader.readMany(actor, subjects, key, o),
    normalizeKeyword: (raw, version) => normalizeKeyword(raw, version),
    retainUntil: (actor, ids, until) => signals.retention.retainUntil(actor, ids, until),
  };
}

/** A 的 `submit(raw, actor)` / `get(batchId, actor)` 参数顺序与端口相反，这里翻过来。 */
export function realDemandPort(demand: Pick<DemandModule, "submit" | "get">): DemandPort {
  return { submit: (actor, input) => demand.submit(input, actor), get: (actor, batchId) => demand.get(batchId, actor) };
}
