// activity-plan 的装配入口（design §4）：CLI、worker、将来的页面都从这里取 Module，不各自拼依赖。
import type { Db } from "../../db/client";
import type { MonitoringResolver } from "../monitoring";
import type { Clock } from "../raw-capture";
import type { TracerConfig, TracerCommands } from "../tracer-command";
import type { PlanAuditSink } from "./audit";
import { noDownstream, type PlanDownstream } from "./downstream";
import { createPlanMaintenance } from "./maintenance";
import { createOwners } from "./owners";
import { createParticipation } from "./participation";
import { createPlans } from "./plans";
import { createPlanQuery } from "./query";
import { createPlanReader } from "./reader";
import { confirm, type ConfirmDeps } from "./roster/confirm";
import { createRosterFinalizer, type SupplementPort } from "./roster/finalize";
import { createRosterMaintenance } from "./roster/maintain";
import { precheck, type PrecheckInput } from "./roster/precheck";
import { createRosterResolver, type RunRoot } from "./roster/resolver";
import type { PlanActor } from "./authz";

export interface ActivityPlanDeps {
  db: Db;
  clock: Clock;
  audit: PlanAuditSink;
  monitoring: MonitoringResolver;
  tracer: Pick<TracerCommands, "submitRoster">;
  tracerConfig?: TracerConfig;
  downstream?: PlanDownstream;
  /** 名单解析驱动 / 批次完成补抓；缺省时 resolver / finalize 不可用（CLI 的 resolve 命令报「未装配」） */
  runRoot?: RunRoot;
  supplement?: SupplementPort;
}
export function createActivityPlan(deps: ActivityPlanDeps) {
  const { db, clock, audit } = deps;
  const downstream = deps.downstream ?? noDownstream;
  const base = { db, clock, audit };
  const finalize = deps.supplement ? createRosterFinalizer({ db, clock, supplement: deps.supplement }) : undefined;
  const confirmDeps: ConfirmDeps = { ...base, tracer: deps.tracer, ...(deps.tracerConfig ? { tracerConfig: deps.tracerConfig } : {}), ...(finalize ? { onCompleted: finalize } : {}) };
  return {
    plans: createPlans({ ...base, downstream }),
    participation: createParticipation(base),
    owners: createOwners(base),
    roster: {
      precheck: (input: PrecheckInput, actor: PlanActor) => precheck(base, input, actor),
      confirm: (batchId: string, actor: PlanActor) => confirm(confirmDeps, batchId, actor),
      maintenance: createRosterMaintenance(base),
      resolver: deps.runRoot && finalize ? createRosterResolver({ ...base, runRoot: deps.runRoot, finalize, ...(deps.tracerConfig ? { tracerConfig: deps.tracerConfig } : {}) }) : undefined,
    },
    query: createPlanQuery({ ...base, resolver: deps.monitoring }),
    reader: createPlanReader({ db, resolver: deps.monitoring }),
    maintenance: createPlanMaintenance({ ...base, downstream }),
  };
}
export type ActivityPlan = ReturnType<typeof createActivityPlan>;
