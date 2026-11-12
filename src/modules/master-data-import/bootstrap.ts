// bootstrap（design §7.7）：3 品牌、4 大区、42 分公司、84 板块。一个事务；自然键幂等；只新增，字段不同记 conflict 不覆盖。
// 新增分公司 = 在种子 CSV 补一行后重跑。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { branches, brands, regions, sectors } from "../../db/schema";
import type { Clock } from "../raw-capture/ports";
import type { AuditSink } from "./audit";
import { assertStructure, type ActorContext } from "./authorization";
import { MasterDataError } from "./errors";
import { BRANDS, SECTOR_NAMES, sectorCodeOf, type SectorKey } from "./mappings.v1";

// 相对仓库根（CLI 与测试都从仓库根运行）。不用 new URL(…, import.meta.url)：Next 打包页面时会把它当静态资源去解析，
// 而应用镜像的构建上下文里没有设计文档目录（.dockerignore），构建会失败（2026-11-12 CI image job 实测）。
// 应用镜像由 Dockerfile 单独 COPY 这一个 CSV 到相同路径，所以在镜像里跑 `master-data bootstrap` 不必传 --seed。
export const DEFAULT_SEED = join(process.cwd(), "HBECHO设计方案/domains/data-foundation/seed/分公司-大区对照.csv");

export interface SeedRow {
  regionCode: string;
  regionName: string;
  branchCode: string;
  branchName: string;
}

/** 种子 CSV：大区编码,大区,分公司编码,分公司；读时去掉 UTF-8 BOM。种子损坏（重复分公司、一个分公司两个大区、一个大区两个名字）整批失败。 */
export function parseSeed(text: string): SeedRow[] {
  const lines = text.replace(/^\uFEFF/, "").trim().split(/\r?\n/);
  const header = lines.shift()?.split(",");
  if (!header || header.join(",") !== "大区编码,大区,分公司编码,分公司") {
    throw new MasterDataError("configuration", "seed_header", "种子 CSV 表头必须是：大区编码,大区,分公司编码,分公司");
  }
  const rows = lines.map((l, i) => {
    const c = l.split(",").map((x) => x.trim());
    if (c.length !== 4 || c.some((x) => x === "")) throw new MasterDataError("configuration", "seed_row", `种子 CSV 第 ${i + 2} 行不是 4 个非空字段`);
    return { regionCode: c[0]!, regionName: c[1]!, branchCode: c[2]!, branchName: c[3]! };
  });
  const regionName = new Map<string, string>();
  const branchRegion = new Map<string, string>();
  for (const r of rows) {
    if (regionName.get(r.regionCode) !== undefined && regionName.get(r.regionCode) !== r.regionName) {
      throw new MasterDataError("configuration", "seed_conflict", `大区 ${r.regionCode} 对应多个名称`);
    }
    regionName.set(r.regionCode, r.regionName);
    if (branchRegion.has(r.branchCode)) {
      throw new MasterDataError("configuration", "seed_conflict", `分公司 ${r.branchCode} 在种子中重复或对应多个大区`);
    }
    branchRegion.set(r.branchCode, r.regionCode);
  }
  return rows;
}

export function loadSeed(path: URL | string = DEFAULT_SEED): SeedRow[] {
  return parseSeed(readFileSync(path, "utf8"));
}

export interface BootstrapCounts {
  created: number;
  unchanged: number;
  conflict: number;
}
export interface BootstrapResult {
  brands: BootstrapCounts;
  regions: BootstrapCounts;
  branches: BootstrapCounts;
  sectors: BootstrapCounts;
}

const zero = (): BootstrapCounts => ({ created: 0, unchanged: 0, conflict: 0 });

export async function bootstrap(deps: { db: Db; clock: Clock; audit: AuditSink }, seed: readonly SeedRow[], actor: ActorContext): Promise<BootstrapResult> {
  assertStructure(actor);
  const now = deps.clock.now();
  const stamps = { createdAt: now, updatedAt: now };
  const out: BootstrapResult = { brands: zero(), regions: zero(), branches: zero(), sectors: zero() };
  await deps.db.transaction(async (tx) => {
    for (const b of BRANDS) {
      const [ex] = await tx.select().from(brands).where(eq(brands.brandCode, b.code));
      if (!ex) {
        await tx.insert(brands).values({ brandCode: b.code, brandName: b.name, status: "active", ...stamps });
        out.brands.created++;
      } else if (ex.brandName === b.name && ex.status === "active") out.brands.unchanged++;
      else out.brands.conflict++;
    }
    const regionIds = new Map<string, bigint>();
    for (const r of seed) {
      if (regionIds.has(r.regionCode)) continue;
      const [ex] = await tx.select().from(regions).where(eq(regions.regionCode, r.regionCode));
      if (!ex) {
        const [ins] = await tx.insert(regions).values({ regionCode: r.regionCode, regionName: r.regionName, status: "active", ...stamps });
        regionIds.set(r.regionCode, BigInt(ins.insertId));
        out.regions.created++;
      } else {
        regionIds.set(r.regionCode, ex.regionId);
        if (ex.regionName === r.regionName && ex.status === "active") out.regions.unchanged++;
        else out.regions.conflict++;
      }
    }
    for (const r of seed) {
      const regionId = regionIds.get(r.regionCode)!;
      let branchId: bigint;
      const [ex] = await tx.select().from(branches).where(eq(branches.branchCode, r.branchCode));
      if (!ex) {
        const [ins] = await tx.insert(branches).values({ regionId, branchCode: r.branchCode, branchName: r.branchName, status: "active", ...stamps });
        branchId = BigInt(ins.insertId);
        out.branches.created++;
      } else {
        branchId = ex.branchId;
        if (ex.branchName === r.branchName && ex.regionId === regionId && ex.status === "active") out.branches.unchanged++;
        else out.branches.conflict++;
      }
      for (const key of ["water", "home"] as SectorKey[]) {
        // 先按 (branch_id, sector_name) 查，存在就复用；不存在才用 {branch_code}-water|home 新建
        const [s] = await tx.select().from(sectors).where(and(eq(sectors.branchId, branchId), eq(sectors.sectorName, SECTOR_NAMES[key])));
        if (s) {
          out.sectors.unchanged++;
          continue;
        }
        await tx.insert(sectors).values({ branchId, sectorCode: sectorCodeOf(r.branchCode, key), sectorName: SECTOR_NAMES[key], status: "active", ...stamps });
        out.sectors.created++;
      }
    }
  });
  deps.audit({ event_type: "bootstrap_completed", actor: actor.actor, occurred_at: now.toISOString(), counts: { ...out } });
  return out;
}
