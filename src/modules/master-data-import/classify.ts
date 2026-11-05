// 行分类（design §7.3）：固定优先级、命中即停。纯逻辑：库内事实经 RefReader 读取，预检用内存快照，确认用事务内实时查询。
import { HEADER } from "./file-parser";
import { mapMainBusiness, SECTOR_NAMES, type SectorKey } from "./mappings.v1";

export type PrecheckClass = "new" | "update" | "unchanged" | "error" | "needs_superadmin";
export type ImportMode = "import" | "structure";
export type BrandScope = ReadonlySet<string> | "all";

export interface FileRow {
  rowNo: number;
  /** 原文单元格（不去空白），写入 raw_row。 */
  raw: string[];
  storeName: string;
  withdrawn: string;
  digital: string;
  storeCode: string;
  dealerName: string;
  dealerCode: string;
  branchName: string;
  branchCode: string;
  mainCode: string;
  tier: string;
}

/** 单元格去首尾空白后参与判断；原文另存。 */
export function toFileRow(rowNo: number, cells: readonly string[]): FileRow {
  const c = (i: number): string => (cells[i] ?? "").trim();
  return {
    rowNo,
    raw: [...cells],
    storeName: c(0),
    withdrawn: c(1),
    digital: c(2),
    storeCode: c(3),
    dealerName: c(4),
    dealerCode: c(5),
    branchName: c(6),
    branchCode: c(7),
    mainCode: c(9),
    tier: c(10),
  };
}

export interface BrandRef {
  id: bigint;
  status: string;
}
export interface BranchRef extends BrandRef {
  name: string;
}
export interface DealerRef extends BrandRef {
  name: string;
}
export interface StoreRef {
  id: bigint;
  brandId: bigint;
  code: string;
  name: string;
  tier: string | null;
  dealerId: bigint;
  sectorId: bigint;
  status: string;
  sourceBatchId: bigint | null;
}
export interface RefReader {
  brand(code: string): Promise<BrandRef | undefined>;
  branch(code: string): Promise<BranchRef | undefined>;
  sector(branchId: bigint, name: string): Promise<BrandRef | undefined>;
  dealer(code: string): Promise<DealerRef | undefined>;
  store(brandId: bigint, code: string): Promise<StoreRef | undefined>;
}

export interface RowPlan {
  brandId: bigint;
  sectorId: bigint;
  storeCode: string;
  storeName: string;
  storeTier: string | null;
  dealer: { id?: bigint; code: string; name: string; create?: boolean; activate?: boolean; rename?: boolean };
  store: { kind: "insert" | "update" | "none"; storeId?: bigint; reactivate?: boolean; relationChange?: boolean; fieldsChanged?: boolean };
}

export interface Classified {
  cls: PrecheckClass;
  reason: string | null;
  detail: string | null;
  /** 命中的既有门店（new 时为空）。 */
  storeId?: bigint;
  /** 仅 new / update / unchanged 有。 */
  plan?: RowPlan;
}

const err = (reason: string, detail: string | null = null): Classified => ({ cls: "error", reason, detail });
const nsa = (reason: string, detail: string | null = null): Classified => ({ cls: "needs_superadmin", reason, detail });

const REQUIRED: Array<[number, string]> = HEADER.map((h, i): [number, string] => [i, h]).filter(([i]) => i !== 10);
const SENTINELS = new Set(["--", "#N/A"]);

export interface Early {
  fail?: Classified;
  brandCode?: string;
  sector?: SectorKey;
}

/** 第 1–6 步：不查库，只用文件内容、映射与操作者范围。 */
export function earlyCheck(row: FileRow, mode: ImportMode, scope: BrandScope): Early {
  // 主营业务名称（第 9 列）不参与映射，但它是必填列，所以按原始单元格检查
  const missing = REQUIRED.filter(([i]) => (row.raw[i] ?? "").trim() === "").map(([, h]) => h);
  if (missing.length > 0) return { fail: err("missing_required_field", missing.join("、")) };
  if (row.withdrawn !== "无撤销") return { fail: err("row_withdrawn", `撤店情况=${row.withdrawn}`) };
  if (row.digital !== "否") return { fail: err("row_digital_store", `是否数字门店=${row.digital}`) };
  if (SENTINELS.has(row.dealerCode)) return { fail: err("dealer_code_missing", `门店所属商家渠道编码=${row.dealerCode}`) };
  const m = mapMainBusiness(row.mainCode);
  if (!m) return { fail: err("main_business_code_unmapped", `主营业务编码=${row.mainCode}`) };
  // 只用映射出的品牌编码判断授权，先于任何库内查询：范围外操作者看不到其他品牌的库内状态
  if (mode === "import" && scope !== "all" && !scope.has(m.brand)) return { fail: err("brand_not_authorized", m.brand) };
  return { brandCode: m.brand, sector: m.sector };
}

/** 第 7、8 步：文件内重复。只在通过第 1–6 步的行之间形成组；组内所有行都记 error。 */
export function findGroupErrors(rows: readonly FileRow[], mode: ImportMode, scope: BrandScope): Map<number, Classified> {
  const out = new Map<number, Classified>();
  const passed = rows.map((r) => ({ r, e: earlyCheck(r, mode, scope) })).filter((x) => x.e.fail === undefined);
  const byStore = new Map<string, number[]>();
  for (const { r, e } of passed) {
    const k = `${e.brandCode}\u0000${r.storeCode}`;
    byStore.set(k, [...(byStore.get(k) ?? []), r.rowNo]);
  }
  for (const nos of byStore.values()) {
    if (nos.length < 2) continue;
    for (const n of nos) out.set(n, err("duplicate_store_code_in_file", `同一品牌、同一门店编码出现在第 ${nos.join("、")} 行`));
  }
  const byDealer = new Map<string, { names: Set<string>; nos: number[] }>();
  for (const { r } of passed) {
    if (out.has(r.rowNo)) continue;
    const g = byDealer.get(r.dealerCode) ?? { names: new Set<string>(), nos: [] };
    g.names.add(r.dealerName);
    g.nos.push(r.rowNo);
    byDealer.set(r.dealerCode, g);
  }
  for (const g of byDealer.values()) {
    if (g.names.size < 2) continue;
    for (const n of g.nos) out.set(n, err("dealer_name_conflict_in_file", `同一商家渠道编码在文件内对应 ${g.names.size} 个不同的商家名称`));
  }
  return out;
}

export interface ClassifyContext {
  mode: ImportMode;
  scope: BrandScope;
  refs: RefReader;
  /** 预检时传入 findGroupErrors 的结果；确认时不传（这些行不会走到确认）。 */
  groupErrors?: ReadonlyMap<number, Classified>;
}

export async function classifyRow(row: FileRow, ctx: ClassifyContext): Promise<Classified> {
  const early = earlyCheck(row, ctx.mode, ctx.scope);
  if (early.fail) return early.fail;
  const grouped = ctx.groupErrors?.get(row.rowNo);
  if (grouped) return grouped;
  const structure = ctx.mode === "structure";
  const notes: string[] = [];

  const brand = await ctx.refs.brand(early.brandCode!);
  if (!brand) return nsa("brand_not_found", early.brandCode!);
  if (brand.status !== "active") return nsa("brand_inactive", early.brandCode!);
  const branch = await ctx.refs.branch(row.branchCode);
  if (!branch) return nsa("branch_not_found", `分公司编码=${row.branchCode}`);
  if (branch.status !== "active") return nsa("branch_inactive", `分公司编码=${row.branchCode}`);
  if (branch.name !== row.branchName) notes.push("branch_name_differs");
  const sector = await ctx.refs.sector(branch.id, SECTOR_NAMES[early.sector!]);
  if (!sector) return nsa("sector_not_found", `${row.branchCode} ${SECTOR_NAMES[early.sector!]}`);
  if (sector.status !== "active") return nsa("sector_inactive", `${row.branchCode} ${SECTOR_NAMES[early.sector!]}`);

  const dealer = await ctx.refs.dealer(row.dealerCode);
  const dealerPlan: RowPlan["dealer"] = { code: row.dealerCode, name: row.dealerName };
  if (!dealer) {
    if (!structure) return nsa("dealer_not_found", `门店所属商家渠道编码=${row.dealerCode}`);
    dealerPlan.create = true;
  } else {
    dealerPlan.id = dealer.id;
    if (dealer.status !== "active") {
      if (!structure) return nsa("dealer_inactive", `门店所属商家渠道编码=${row.dealerCode}`);
      dealerPlan.activate = true;
    }
    if (dealer.name !== row.dealerName) {
      if (!structure) return nsa("dealer_name_mismatch", `门店所属商家渠道编码=${row.dealerCode}`);
      dealerPlan.rename = true;
    }
  }

  const store = await ctx.refs.store(brand.id, row.storeCode);
  const tier = row.tier === "" ? null : row.tier;
  const reasons: string[] = [];
  const plan: RowPlan = {
    brandId: brand.id,
    sectorId: sector.id,
    storeCode: row.storeCode,
    storeName: row.storeName,
    storeTier: tier,
    dealer: dealerPlan,
    store: { kind: "none" },
  };
  let cls: PrecheckClass;
  if (!store) {
    cls = "new";
    plan.store = { kind: "insert" };
  } else {
    const relationChange = dealerPlan.id === undefined || store.dealerId !== dealerPlan.id || store.sectorId !== sector.id;
    if (relationChange && !structure) return nsa("store_relation_change", `门店编码=${row.storeCode}`);
    const reactivate = store.status === "closed";
    const fieldsChanged = store.name !== row.storeName || store.tier !== tier;
    if (relationChange) reasons.push("change_store_relation");
    if (reactivate) reasons.push("reactivate_store");
    if (fieldsChanged) reasons.push("store_fields_changed");
    plan.store = { kind: relationChange || reactivate || fieldsChanged ? "update" : "none", storeId: store.id, reactivate, relationChange, fieldsChanged };
    cls = "unchanged"; // 下面按结构动作再升级
  }
  if (dealerPlan.create) reasons.push("create_dealer");
  if (dealerPlan.activate) reasons.push("activate_dealer");
  if (dealerPlan.rename) reasons.push("update_dealer_name");
  if (cls !== "new" && reasons.length > 0) cls = "update";
  const detail = [...reasons.slice(1), ...notes].join(",") || null;
  return { cls, reason: reasons[0] ?? null, detail, ...(store ? { storeId: store.id } : {}), plan };
}
