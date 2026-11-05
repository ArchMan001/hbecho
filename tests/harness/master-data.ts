// 主数据导入测试挂具：CSV 造数、服务身份、内存审计、装配好的 Module。夹具全部脱敏造数，不放真实商家名。
import type { TestDb } from "./db";
import { createMasterData, CAP_IMPORT, CAP_STRUCTURE, HEADER, loadSeed, type ActorContext, type AuditEvent, type MasterDataOptions } from "../../src/modules/master-data-import";
import { FakeClock } from "./fake-clock";

export const T0 = new Date("2026-11-05T08:00:00.000000Z");

export interface RowSpec {
  name?: string;
  withdrawn?: string;
  digital?: string;
  storeCode: string;
  dealerName?: string;
  dealerCode?: string;
  branchName?: string;
  branchCode?: string;
  mainName?: string;
  mainCode?: string;
  tier?: string;
}

/** 默认是：上海分公司 110（种子里存在）、日立家装 13。 */
export function row(s: RowSpec): string[] {
  return [
    s.name ?? `门店-${s.storeCode}`,
    s.withdrawn ?? "无撤销",
    s.digital ?? "否",
    s.storeCode,
    s.dealerName ?? "商家甲",
    s.dealerCode ?? "9000001",
    s.branchName ?? "上海分公司",
    s.branchCode ?? "110",
    s.mainName ?? "日立家装",
    s.mainCode ?? "13",
    s.tier ?? "二级经销商A级店",
  ];
}

const q = (v: string): string => (/[",\r\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
export function csv(rows: ReadonlyArray<RowSpec | string[]>): Uint8Array {
  const lines = [HEADER.join(","), ...rows.map((r) => (Array.isArray(r) ? r : row(r)).map(q).join(","))];
  return new TextEncoder().encode(`${lines.join("\n")}\n`);
}

export const importActor = (brands: string[] = ["hitachi", "hisense", "york_vrf"], actor = "service:test-import"): ActorContext => ({
  actor,
  capabilities: new Set([CAP_IMPORT]),
  brandScope: new Set(brands),
});
export const adminActor = (actor = "service:test-admin"): ActorContext => ({
  actor,
  capabilities: new Set([CAP_IMPORT, CAP_STRUCTURE]),
  brandScope: "all",
});

export class MemoryAudit {
  readonly events: AuditEvent[] = [];
  readonly sink = (e: AuditEvent): void => void this.events.push(e);
  of(type: AuditEvent["event_type"]): AuditEvent[] {
    return this.events.filter((e) => e.event_type === type);
  }
}

export function mdEnv(t: TestDb, opts: MasterDataOptions = {}) {
  const clock = new FakeClock(T0);
  const audit = new MemoryAudit();
  const md = createMasterData(t.db, clock, audit.sink, opts);
  return { md, clock, audit, admin: adminActor(), importer: importActor() };
}

export type MdEnv = ReturnType<typeof mdEnv>;

/** 空库 + bootstrap（3 品牌、4 大区、42 分公司、84 板块）。 */
export async function bootstrapped(t: TestDb, opts: MasterDataOptions = {}): Promise<MdEnv> {
  const env = mdEnv(t, opts);
  await env.md.structure.bootstrap(loadSeed(), env.admin);
  return env;
}

/** 用 structure 模式把一份文件灌进库（造经销商与门店）。返回批次 ID。 */
export async function seedStores(env: MdEnv, rows: Array<RowSpec | string[]>): Promise<string> {
  const p = await env.md.imports.precheck({ fileName: "seed.csv", bytes: csv(rows), mode: "structure" }, env.admin);
  await env.md.imports.confirm(p.batchId, {}, env.admin);
  return p.batchId;
}
