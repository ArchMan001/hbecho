// signals 的装配入口（design §4）：CLI、worker、将来的 D 都从这里取 Module，不各自拼依赖。
// 任务 2 只有骨架；读取口、监控段、评分、重算等随各自任务加进返回值，依赖（网关、匹配器、两个对象存储）也在用到时才进 SignalsDeps。
import type { Db } from "../../db/client";
import type { Clock } from "../raw-capture";
import type { SignalAuditSink } from "./audit";
import type { SignalsConfig } from "./config";
import { createFacts } from "./facts";

export interface SignalsDeps {
  db: Db;
  clock: Clock;
  audit: SignalAuditSink;
  config: SignalsConfig;
}

export function createSignals(deps: SignalsDeps) {
  return { facts: createFacts(deps.db), config: deps.config };
}
export type Signals = ReturnType<typeof createSignals>;
