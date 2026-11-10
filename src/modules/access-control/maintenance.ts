// 访问控制每日维护的装配（给 worker 进程用）：持久审计 + 组织目录 + 联动。调用方不需要知道这些部件，也不需要 OSS。
import type { Logger } from "pino";
import type { Db } from "../../db/client";
import type { Clock } from "../raw-capture/ports";
import { createAuditWriter } from "./audit";
import { createStaffLinkage, type StaffLinkage } from "./linkage";
import { createOrgDirectory } from "./scope";

export function createAccessMaintenance(d: { db: Db; clock: Clock; logger?: Logger }): Pick<StaffLinkage, "runNow" | "runDaily"> {
  const audit = createAuditWriter({ db: d.db, clock: d.clock, ...(d.logger ? { logger: d.logger } : {}) });
  const link = createStaffLinkage({
    db: d.db,
    clock: d.clock,
    audit,
    dir: createOrgDirectory(d.db),
    ...(d.logger ? { log: (e: Record<string, unknown>, m: string) => d.logger!.info(e, m) } : {}),
  });
  return { runNow: link.runNow, runDaily: link.runDaily };
}
