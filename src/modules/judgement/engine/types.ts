// 阶段机共用的类型（runner 与各阶段文件共享）。
import type { Db } from "../../../db/client";
import type { AuthContext } from "../../access-control";
import type { Clock } from "../../raw-capture/ports";
import type { JudgementAudit } from "../audit";
import type { JudgementAuthz } from "../authz";
import type { Config } from "../config";
import type { JudgementConfig } from "../env";
import type { ActivityPlanFact, Facts } from "../facts";
import type { DemandPort, SignalActor, SignalsPort } from "../ports";
import type { RunOps } from "../run-ops";
import type { Claim, RunRow } from "./claim";

export interface RunnerDeps {
  db: Db;
  clock: Clock;
  facts: Facts;
  authz: JudgementAuthz;
  audit: JudgementAudit;
  signals: SignalsPort;
  demand: DemandPort;
  claim: Claim;
  ops: RunOps;
  config: JudgementConfig;
}
export interface Frozen {
  frozenAt: string;
  window: { from: string; to?: string; fromUtc: string; toUtc: string };
  platform: string;
  startsOn: string;
  endsOn: string | null;
  configSha256: string;
  segment: { planId: string; version: number };
  rosterSha256: string;
  freezeDone: boolean;
}
export interface Env {
  run: RunRow;
  cfg: Config;
  ctx: AuthContext;
  actor: SignalActor;
  activity: ActivityPlanFact;
  frozen: Frozen;
  startedMs: number;
}
export type Out =
  | { kind: "advance"; phase: string }
  | { kind: "more"; cursor?: bigint | null }
  | { kind: "wait"; on?: "signals" | "demand" | "collection"; detail?: Record<string, unknown> }
  | { kind: "done" }
  | { kind: "fail"; code: string; detail?: unknown };
