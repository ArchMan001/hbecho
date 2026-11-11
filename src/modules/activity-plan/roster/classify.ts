// 行分类（design §7.1）：固定优先级、首个命中即停。纯逻辑：库内事实经 RosterRefs 读取，
// 预检用整批预加载的内存快照，确认写入用事务内的实时读取，二者走同一个函数，结果不一致就是「预检之后数据变了」。
// 外部 ID 与入口按原文比较（哈希只是索引，命中后复核原文在 refs 里做）。
import { classifyLocator, checkLocatorPlatform, detectLocatorPlatform, type Platform } from "../../provider-adapter";
import { normalizePhone } from "../../phone";
import { brandInScope, branchInScope, type PlanActor } from "../authz";

export type RosterPrecheckClass = "new" | "new_staff" | "update" | "unchanged" | "error";
export interface RosterRow {
  rowNo: number;
  /** 4 列原文：门店编码、专员姓名、手机号、主页链接 */
  cells: readonly string[];
}
export interface StoreRef {
  storeId: bigint;
  status: string;
  /** 板块种类；板块编码不是 {分公司}-{water|home} 形态时为 undefined */
  sectorKey: "water" | "home" | undefined;
  /** 门店所属分公司（经板块） */
  branchId: bigint;
}
export interface StaffRef {
  staffId: bigint;
  storeId: bigint;
  name: string;
  status: string;
}
export interface LocalAccountRef {
  accountId: bigint;
  /** 当前归属的专员；外部监控账号为 null */
  ownerStaffId: bigint | null;
}
export interface RosterRefs {
  /** 计划品牌下的门店 */
  store(code: string): StoreRef | undefined;
  /** 同编码但属于其他品牌的门店：返回它们的品牌编码 */
  otherBrandCodes(code: string): string[];
  participation(branchId: bigint): "joined" | "exited" | undefined;
  staffByPhone(phone: string): StaffRef[];
  /** 入口文本命中已有归属（哈希命中后已复核原文） */
  matchAccount(original: string, cleaned: string): LocalAccountRef | undefined;
  rosterEntry(accountId: bigint): { state: "in_roster" | "removed"; staffId: bigint } | undefined;
}
export interface ClassifyCtx {
  plan: { platform: Platform; sectors: ReadonlySet<string> };
  actor: Pick<PlanActor, "brandScope" | "branchScope">;
  refs: RosterRefs;
}
export interface Classified {
  cls: RosterPrecheckClass;
  reason?: string;
  detail?: string;
  storeId?: bigint;
  staffId?: bigint;
  branchId?: bigint;
  accountId?: bigint;
}

export const NAME_MAX = 100;
export const LOCATOR_MAX = 2048;
/** 提示性原因：不改变预检类，确认后落为归属冲突或引用。 */
export const KNOWN_ACCOUNT_REASONS = ["known_account_same_owner", "known_account_other_owner"] as const;
export const isKnownAccountHint = (reason: string | undefined): boolean => reason !== undefined && (KNOWN_ACCOUNT_REASONS as readonly string[]).includes(reason);

const err = (reason: string, detail?: string, extra: Partial<Classified> = {}): Classified => ({ cls: "error", reason, ...(detail ? { detail } : {}), ...extra });

interface Stage1Ok {
  ok: true;
  name: string;
  phone: string;
  store: StoreRef;
  storeCode: string;
  staff: StaffRef | undefined;
  original: string;
  cleaned: string;
}
type Stage1 = Stage1Ok | { ok: false; result: Classified };

/** 步骤 1–11：逐行独立可判断的检查。 */
function stage1(row: RosterRow, ctx: ClassifyCtx): Stage1 {
  const [storeCodeRaw = "", nameRaw = "", phoneRaw = "", locatorRaw = ""] = row.cells;
  const storeCode = storeCodeRaw.trim();
  const name = nameRaw.trim();
  const original = locatorRaw.trim();
  const fail = (reason: string, detail?: string, extra: Partial<Classified> = {}): Stage1 => ({ ok: false, result: err(reason, detail, extra) });
  // 1. 四列均非空
  const missing = (["门店编码", "专员姓名", "手机号", "主页链接"] as const).filter((_, i) => (row.cells[i] ?? "").trim() === "");
  if (missing.length > 0) return fail("required_missing", `缺少：${missing.join("、")}`);
  // 2. 手机号规范化、长度
  const phone = normalizePhone(phoneRaw);
  if (phone === null) return fail("phone_invalid", "手机号须为 11 位大陆手机号（Excel 把手机号当数字时会变成科学计数法，请先把整列设为文本）");
  if ([...name].length > NAME_MAX) return fail("name_too_long", `专员姓名超过 ${NAME_MAX} 字`);
  if (original.length > LOCATOR_MAX) return fail("locator_too_long", `主页链接超过 ${LOCATOR_MAX} 字符`);
  // 3. 门店（计划品牌下精确匹配）
  const store = ctx.refs.store(storeCode);
  if (!store) {
    // 只有在操作者品牌范围内的其他品牌才提示「品牌不符」；范围外一律按不存在，不泄露
    const others = ctx.refs.otherBrandCodes(storeCode).filter((b) => brandInScope(ctx.actor, b));
    return others.length > 0 ? fail("store_brand_mismatch", "该门店编码属于其他品牌，不属于本计划的品牌") : fail("store_not_found", "门店编码在系统中不存在，请联系管理员");
  }
  // 4. 门店在营
  if (store.status !== "active") return fail("store_closed", "该门店已撤店", { storeId: store.storeId, branchId: store.branchId });
  const where = { storeId: store.storeId, branchId: store.branchId };
  // 5. 板块种类 ∈ 计划板块
  if (!store.sectorKey || !ctx.plan.sectors.has(store.sectorKey)) return fail("store_sector_not_in_plan", "门店所属板块不在本计划的板块范围内", where);
  // 6. 门店所属分公司在操作者范围
  if (!branchInScope(ctx.actor, store.branchId)) return fail("store_branch_not_authorized", "门店不属于你的分公司，请联系管理员", where);
  // 7. 分公司已加入计划
  if (ctx.refs.participation(store.branchId) !== "joined") return fail("branch_not_joined", "该门店所属分公司还没有加入本计划", where);
  // 8–9. 手机号对应的专员
  const staffRows = ctx.refs.staffByPhone(phone);
  const active = staffRows.find((s) => s.status === "active");
  if (active && active.storeId !== store.storeId) return fail("phone_belongs_to_other_store", "该手机号属于其他门店的有效专员，请联系超管", where);
  if (!active && staffRows.some((s) => s.status === "inactive" && s.storeId === store.storeId)) {
    return fail("staff_inactive_restore_needed", "该门店有同手机号的已停用专员，请联系总部或超管恢复原专员", where);
  }
  // 10. 视频 / 笔记链接
  const decision = classifyLocator(original);
  if (decision.action === "reject") return fail("non_home_locator", "这是视频或笔记链接，不是主页链接", where);
  // 11. 链接平台：另一平台 → 错配（不默认成抖音）；含 URL 但域名不属于任何支持平台 → 无法识别；纯口令放行
  const check = checkLocatorPlatform(ctx.plan.platform, original);
  if (!check.ok) return fail("platform_mismatch", `链接属于 ${check.detected}，与计划平台 ${ctx.plan.platform} 不一致`, where);
  if (detectLocatorPlatform(original) === null) return fail("platform_unrecognized", "链接域名无法识别为任何支持的平台", where);
  return { ok: true, name, phone, store, storeCode, staff: active, original, cleaned: decision.cleaned };
}

/** 步骤 13：本地账号命中与名单项状态。 */
function stage3(s: Stage1Ok, ctx: ClassifyCtx): Classified {
  const base = { storeId: s.store.storeId, branchId: s.store.branchId, ...(s.staff ? { staffId: s.staff.staffId } : {}) };
  const nameDiffers = s.staff && s.staff.name !== s.name ? `staff_name_differs：库中姓名「${s.staff.name}」` : undefined;
  const fresh = (): Classified => ({ cls: s.staff ? "new" : "new_staff", ...base, ...(nameDiffers ? { detail: nameDiffers } : {}) });
  const hit = ctx.refs.matchAccount(s.original, s.cleaned);
  if (!hit) return fresh();
  const entry = ctx.refs.rosterEntry(hit.accountId);
  const sameOwner = s.staff !== undefined && hit.ownerStaffId === s.staff.staffId;
  if (sameOwner && entry?.state === "in_roster") return { cls: "unchanged", reason: "already_in_roster", ...base, accountId: hit.accountId };
  if (sameOwner && entry?.state === "removed") return { cls: "update", reason: "restore_roster_entry", ...base, accountId: hit.accountId };
  if (sameOwner) return { ...fresh(), reason: "known_account_same_owner", accountId: hit.accountId };
  // 账号已归属他人（或专员尚不存在 / 外部监控账号）：预检类不变，提示确认后将成为归属冲突
  return { ...fresh(), reason: "known_account_other_owner", detail: "该主页已归属于其他专员，确认后将记为归属冲突", accountId: hit.accountId };
}

/**
 * 对全部数据行分类。步骤 12（文件内重复）只对通过 1–11 的行成组判断：
 *   同手机号不同姓名 → phone_name_conflict_in_file（优先）；同手机号 → duplicate_phone_in_file；同一清洗后入口 → duplicate_locator_in_file。
 * 重复组整组报错，不留一行（F-D14，单平台计划里每位专员最多一行）。
 */
export function classifyRows(rows: readonly RosterRow[], ctx: ClassifyCtx): Classified[] {
  const s1 = rows.map((r) => stage1(r, ctx));
  const passing = s1.filter((x): x is Stage1Ok => x.ok);
  const byPhone = new Map<string, Stage1Ok[]>();
  const byLocator = new Map<string, Stage1Ok[]>();
  for (const p of passing) {
    byPhone.set(p.phone, [...(byPhone.get(p.phone) ?? []), p]);
    byLocator.set(p.cleaned, [...(byLocator.get(p.cleaned) ?? []), p]);
  }
  return s1.map((x) => {
    if (!x.ok) return x.result;
    const base = { storeId: x.store.storeId, branchId: x.store.branchId };
    const samePhone = byPhone.get(x.phone)!;
    if (samePhone.length > 1) {
      const names = new Set(samePhone.map((p) => p.name));
      return names.size > 1
        ? err("phone_name_conflict_in_file", "同一手机号在文件里对应了不同姓名", base)
        : err("duplicate_phone_in_file", "同一手机号在文件里出现了多次，每位专员只填一行", base);
    }
    if (byLocator.get(x.cleaned)!.length > 1) return err("duplicate_locator_in_file", "同一主页链接在文件里出现了多次", base);
    return stage3(x, ctx);
  });
}

/** 可能新增账号的行（名额占用口径，design §7.4）：new / new_staff 且没有本地命中提示。 */
export const isPossiblyNew = (c: Pick<Classified, "cls" | "reason">): boolean => (c.cls === "new" || c.cls === "new_staff") && !isKnownAccountHint(c.reason);
