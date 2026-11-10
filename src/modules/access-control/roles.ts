// 角色、Capability 注册表与角色矩阵（design §7.1、AX-6）。
// 注册表是**唯一**的 Capability 清单：29 项，与 B PRD §7.3 逐行一致，由 tests/fixtures/access/capability-matrix.v1.json
// （从 PRD 转写）逐行对照。别的 spec 要新增 Capability，改这里并走 B 的评审；业务代码出现注册表以外的字符串，静态测试失败。
// 这里是 `access-control` 里唯一允许出现四个角色字面量的地方之一（静态护栏的例外目录）。

// 单一来源：数据库 CHECK 用的同一份常量（src/db/schema/access.ts），不在这里再抄一遍
import { ROLE_CODES } from "../../db/schema/access";
export { ROLE_CODES };
export type RoleCode = (typeof ROLE_CODES)[number];

/** 严格下级判断用的等级（design §7.6）。 */
export const ROLE_RANK: Readonly<Record<RoleCode, number>> = { platform_admin: 4, hq_manager: 3, branch_manager: 2, store_staff: 1 };

/** 人员级别（B-D23）：由角色映射，不建职级字段。 */
export const ROLE_LEVEL: Readonly<Record<RoleCode, 1 | 2 | 3>> = { platform_admin: 3, hq_manager: 3, branch_manager: 2, store_staff: 1 };

export const isRoleCode = (v: unknown): v is RoleCode => typeof v === "string" && (ROLE_CODES as readonly string[]).includes(v);

// 顺序与 PRD §7.3 一致。
export const CAPABILITIES = [
  "data.account.read",
  "data.account.manage",
  "data.monitoring.manage",
  "data.content.read",
  "data.media.read",
  "data.sync.trigger",
  "data.raw_payload.read",
  "data.master_data.import",
  "data.master_data.correct",
  "data.master_data.structure",
  "monitor.external.manage",
  "activity_plan.create",
  "activity_plan.join",
  "data.export",
  "report.read",
  "report.export",
  "rule.definition.read",
  "rule.definition.manage",
  "rule.run.execute",
  "metric.catalog.read",
  "metric.catalog.manage",
  "learning.read",
  "learning.manage",
  "learning.report.read",
  "learning.tag.manage",
  "ai.content.assist",
  "user.manage",
  "audit.read",
  "config.manage",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

const CAPABILITY_SET: ReadonlySet<string> = new Set(CAPABILITIES);
export const isCapability = (v: unknown): v is Capability => typeof v === "string" && CAPABILITY_SET.has(v);

// 授予矩阵：每个 Capability 授予哪几类角色。范围维度（授权品牌 / 本分公司 / 本人）不在这里，由 DataScope 与资源策略表达。
const ADMIN_ONLY: readonly RoleCode[] = ["platform_admin"];
const ADMIN_HQ: readonly RoleCode[] = ["platform_admin", "hq_manager"];
const ADMIN_HQ_BRANCH: readonly RoleCode[] = ["platform_admin", "hq_manager", "branch_manager"];
const EVERYONE: readonly RoleCode[] = ROLE_CODES;

const GRANTS: Readonly<Record<Capability, readonly RoleCode[]>> = {
  "data.account.read": EVERYONE,
  "data.account.manage": ADMIN_HQ_BRANCH,
  "data.monitoring.manage": ADMIN_HQ_BRANCH,
  "data.content.read": EVERYONE,
  "data.media.read": EVERYONE,
  "data.sync.trigger": ADMIN_HQ_BRANCH,
  "data.raw_payload.read": ADMIN_ONLY,
  "data.master_data.import": ADMIN_HQ,
  "data.master_data.correct": ADMIN_HQ,
  "data.master_data.structure": ADMIN_ONLY,
  "monitor.external.manage": ADMIN_ONLY,
  "activity_plan.create": ADMIN_HQ,
  "activity_plan.join": ADMIN_HQ_BRANCH,
  "data.export": ADMIN_HQ_BRANCH,
  "report.read": EVERYONE,
  "report.export": ADMIN_HQ_BRANCH,
  "rule.definition.read": ADMIN_HQ_BRANCH,
  "rule.definition.manage": ADMIN_HQ,
  "rule.run.execute": ADMIN_HQ,
  "metric.catalog.read": ADMIN_HQ_BRANCH,
  "metric.catalog.manage": ADMIN_HQ,
  "learning.read": EVERYONE,
  "learning.manage": ADMIN_HQ,
  "learning.report.read": ADMIN_HQ,
  "learning.tag.manage": ADMIN_ONLY,
  "ai.content.assist": ADMIN_HQ,
  "user.manage": ADMIN_HQ_BRANCH,
  "audit.read": ADMIN_ONLY,
  "config.manage": ADMIN_ONLY,
};

const grantedTo = (r: RoleCode): ReadonlySet<Capability> => new Set(CAPABILITIES.filter((c) => GRANTS[c].includes(r)));

export const ROLE_CAPABILITIES: Readonly<Record<RoleCode, ReadonlySet<Capability>>> = {
  platform_admin: grantedTo("platform_admin"),
  hq_manager: grantedTo("hq_manager"),
  branch_manager: grantedTo("branch_manager"),
  store_staff: grantedTo("store_staff"),
};

export const capabilitiesOf = (role: RoleCode): ReadonlySet<Capability> => ROLE_CAPABILITIES[role];
