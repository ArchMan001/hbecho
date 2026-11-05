import type { Db } from "../../db/client";
import type { Clock } from "../raw-capture";
import type { SyncAuditSink } from "../sync-schedule";
import { createDemandReader } from "./get";
import { createDemandSubmitter } from "./submit";
import type { DemandRuntime } from "./types";

export * from "./get";
export * from "./reuse";
export * from "./submit";
export * from "./tasks";
export * from "./types";

/** 规则域看到的两个入口：提交需求 / 查询结果。 */
export function createDemandModule(deps: { db: Db; clock: Clock; runtime: DemandRuntime; audit: SyncAuditSink }) {
  return { ...createDemandSubmitter(deps), ...createDemandReader(deps) };
}
export type DemandModule = ReturnType<typeof createDemandModule>;
