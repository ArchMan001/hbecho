// 认证侧的唯一装配点：审计、登录锁定、短信服务、AuthFlow、认证实例。
// Web 运行时（runtime.ts）和测试挂具（tests/harness/access.ts）都经这里，所以测试证明的就是生产接线——
// 不会出现「测试里有锁定、生产入口没接」。
import type { Logger } from "pino";
import type { Db } from "../../db/client";
import type { Clock } from "../raw-capture/ports";
import { createAuditWriter, type PersistentAuditWriter } from "./audit";
import { createAuthFlow, createCodeDelivery } from "./auth-flow";
import { createAuth, type AccessAuth, type AuthFlow } from "./auth-instance";
import type { AccessConfig } from "./config";
import { createLoginGuard, type LoginGuard } from "./login-guard";
import { createSmsService, type AccessAlert, type SmsSender, type SmsService } from "./sms";

export interface AssembleDeps {
  db: Db;
  config: AccessConfig;
  clock: Clock;
  sender: SmsSender;
  logger?: Logger;
  alert?: (a: AccessAlert) => void;
  /** 仅测试：替换流程（缺省 = 真实 AuthFlow；false = 不接流程，只有库自己）。 */
  flow?: AuthFlow | false;
}

export interface AccessAssembly {
  auth: AccessAuth;
  audit: PersistentAuditWriter;
  guard: LoginGuard;
  sms: SmsService;
}

export function assembleAccess(d: AssembleDeps): AccessAssembly {
  const audit = createAuditWriter({ db: d.db, clock: d.clock, ...(d.logger ? { logger: d.logger } : {}) });
  const guard = createLoginGuard({ db: d.db, clock: d.clock });
  const sms = createSmsService({ db: d.db, clock: d.clock, sender: d.sender, dailyCap: d.config.smsDailyCap, audit, ...(d.alert ? { alert: d.alert } : {}) });
  const flow = d.flow === false ? undefined : (d.flow ?? createAuthFlow({ db: d.db, clock: d.clock, guard, sms, audit }));
  const auth = createAuth({ db: d.db, config: d.config, delivery: createCodeDelivery(sms), ...(flow ? { flow } : {}) });
  return { auth, audit, guard, sms };
}
