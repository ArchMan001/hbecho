// 装配：把 judgement 模块接到 B 的授权与审计、A 的名单读取、C 的端口。页面进程、worker 与 CLI 共用这一份，
// 所以测试证明的就是生产接线。数值配置来自 parseJudgementEnv（没有代码默认值）。
import type { Db } from "../../db/client";
import type { AccessRegistry, AuditWriter, Authorizer, ContextResolver } from "../access-control";
import type { PlanReader } from "../activity-plan/reader";
import type { Clock } from "../raw-capture/ports";
import { createJudgementAudit } from "./audit";
import { createJudgementAuthz, registerJudgementAuthz } from "./authz";
import { createClaim } from "./engine/claim";
import { createRunner } from "./engine/runner";
import type { JudgementConfig } from "./env";
import { createFacts } from "./facts";
import { createOutcomes } from "./outcomes";
import { createPlans } from "./plans";
import type { DemandPort, SignalsPort } from "./ports";
import { createRunOps } from "./run-ops";
import { createRuns } from "./runs";
import { createVersions } from "./versions";
import { createViews } from "./views";

export interface JudgementAssembly {
  db: Db;
  clock: Clock;
  reader: Pick<PlanReader, "rosterSnapshot">;
  signals: SignalsPort;
  demand: DemandPort;
  resolver: Pick<ContextResolver, "contextForUser">;
  authorizer: Authorizer;
  /** 授权器用的注册表：这里先查再注册 judgement_plan 与 plan_creator（重复装配不抛）。 */
  registry: AccessRegistry;
  auditWriter: AuditWriter;
  config: JudgementConfig;
}
export function createJudgement(a: JudgementAssembly) {
  registerJudgementAuthz(a.registry);
  const facts = createFacts({ db: a.db, reader: a.reader });
  const authz = createJudgementAuthz({ authorizer: a.authorizer, resolver: a.resolver, facts });
  const audit = createJudgementAudit(a.auditWriter);
  const limits = { maxItems: a.config.maxItems, maxKeywordLength: a.config.maxKeywordLength };
  const deps = { db: a.db, clock: a.clock, facts, authz, audit, signals: a.signals, demand: a.demand, limits };
  const claim = createClaim({ db: a.db, clock: a.clock, leaseSeconds: a.config.leaseSeconds });
  const ops = createRunOps(a.db);
  const plans = createPlans(deps);
  const versions = createVersions(deps);
  const runner = createRunner({ ...deps, claim, ops, config: a.config });
  const runs = createRuns({ ...deps, claim, runner, versions, config: a.config, ops });
  const outcomes = createOutcomes({ ...deps, config: a.config, ops });
  const views = createViews({ ...deps, plans });
  return { facts, authz, audit, plans, versions, runs, outcomes, views, claim, runner, ops, config: a.config };
}
export type Judgement = ReturnType<typeof createJudgement>;
