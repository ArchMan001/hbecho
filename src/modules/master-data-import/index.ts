// Module 出口。调用方只经这里进入，不直接写 stores / import_batches / import_row_results。
import type { Db } from "../../db/client";
import type { Clock } from "../raw-capture/ports";
import type { AuditSink } from "./audit";
import { bootstrap, type SeedRow } from "./bootstrap";
import { confirm, type ConfirmCommand, type ConfirmDeps } from "./confirm";
import { precheck, type PrecheckInput } from "./precheck";
import { createQuery } from "./query";
import { changeStoreCode } from "./structure";
import type { ActorContext } from "./authorization";

export * from "./audit";
export * from "./authorization";
export * from "./errors";
export { loadSeed, parseSeed, type SeedRow } from "./bootstrap";
export { HEADER } from "./file-parser";
export type { ConfirmCommand, ImportBatchResult } from "./confirm";
export type { PrecheckAccepted, PrecheckInput, BatchSummary } from "./precheck";

export interface MasterDataOptions extends Pick<ConfirmDeps, "chunkSize" | "maxMs" | "staleMs" | "newToken" | "hooks"> {}

export function createMasterData(db: Db, clock: Clock, audit: AuditSink, opts: MasterDataOptions = {}) {
  const deps = { db, clock, audit };
  return {
    imports: {
      precheck: (input: PrecheckInput, actor: ActorContext) => precheck(deps, input, actor),
      confirm: (batchId: string, cmd: ConfirmCommand, actor: ActorContext) => confirm({ ...deps, ...opts }, batchId, cmd, actor),
    },
    structure: {
      bootstrap: (seed: readonly SeedRow[], actor: ActorContext) => bootstrap(deps, seed, actor),
      changeStoreCode: (storeId: string, newCode: string, actor: ActorContext) => changeStoreCode(deps, storeId, newCode, actor),
    },
    query: createQuery(db),
  };
}
export type MasterData = ReturnType<typeof createMasterData>;
