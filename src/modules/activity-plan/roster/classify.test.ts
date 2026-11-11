// design §7.1：每个 reason_code 一个用例，加优先级冲突组合、文件内重复三种、入口命中分支。
import { describe, expect, it } from "vitest";
import { classifyRows, isPossiblyNew, type ClassifyCtx, type LocalAccountRef, type RosterRefs, type RosterRow, type StaffRef, type StoreRef } from "./classify";

const BJ = 1n;
const SH = 2n;
const OK_STORE: StoreRef = { storeId: 10n, status: "active", sectorKey: "water", branchId: BJ };
const URL_A = "https://www.douyin.com/user/AAA";
const row = (cells: string[], rowNo = 1): RosterRow => ({ rowNo, cells });
const good = (over: Partial<Record<0 | 1 | 2 | 3, string>> = {}): string[] => [over[0] ?? "S1", over[1] ?? "新人", over[2] ?? "13800000001", over[3] ?? URL_A];

interface World {
  stores?: Record<string, StoreRef>;
  other?: Record<string, string[]>;
  participation?: Record<string, "joined" | "exited">;
  staff?: Record<string, StaffRef[]>;
  accounts?: Record<string, LocalAccountRef>;
  roster?: Record<string, { state: "in_roster" | "removed"; staffId: bigint }>;
}
function refs(w: World = {}): RosterRefs {
  const stores = w.stores ?? { S1: OK_STORE };
  const participation = w.participation ?? { [BJ.toString()]: "joined" };
  return {
    store: (c) => stores[c],
    otherBrandCodes: (c) => w.other?.[c] ?? [],
    participation: (b) => participation[b.toString()],
    staffByPhone: (p) => w.staff?.[p] ?? [],
    matchAccount: (o, c) => w.accounts?.[o] ?? w.accounts?.[c],
    rosterEntry: (a) => w.roster?.[a.toString()],
  };
}
const ctx = (w: World = {}, over: Partial<ClassifyCtx> = {}): ClassifyCtx => ({
  plan: { platform: "douyin", sectors: new Set(["water", "home"]) },
  actor: { brandScope: new Set(["HITACHI", "HISENSE"]), branchScope: "all" },
  refs: refs(w),
  ...over,
});
const one = (cells: string[], w: World = {}, over: Partial<ClassifyCtx> = {}) => classifyRows([row(cells)], ctx(w, over))[0]!;
const staffAt = (storeId: bigint, over: Partial<StaffRef> = {}): StaffRef => ({ staffId: 100n, storeId, name: "新人", status: "active", ...over });

describe("步骤 1–2：必填、手机号、长度", () => {
  it("必填缺失，detail 指明缺哪列", () => {
    const r = one(["S1", " ", "13800000001", ""]);
    expect(r).toMatchObject({ cls: "error", reason: "required_missing" });
    expect(r.detail).toBe("缺少：专员姓名、主页链接");
  });
  it.each([
    ["科学计数法", "1.38E+10", false],
    ["10 位", "1380000000", false],
    ["非 1[3-9] 开头", "12800000001", false],
    ["+86 前缀合法", "+8613800000001", true],
    ["分隔符合法", "138-0000-0001", true],
  ])("手机号 %s", (_n, phone, ok) => {
    expect(one(good({ 2: phone })).reason === "phone_invalid").toBe(!ok);
  });
  it("姓名与链接过长", () => {
    expect(one(good({ 1: "名".repeat(101) })).reason).toBe("name_too_long");
    expect(one(good({ 3: `https://www.douyin.com/user/${"a".repeat(2100)}` })).reason).toBe("locator_too_long");
    expect(one(good({ 1: "名".repeat(100) })).reason).not.toBe("name_too_long");
  });
});

describe("步骤 3–7：门店与分公司", () => {
  it("门店不存在；同编码属于范围内另一品牌 → 品牌不符；属于范围外品牌 → 仍报不存在（不泄露）", () => {
    expect(one(good({ 0: "NOPE" }))).toMatchObject({ reason: "store_not_found" });
    expect(one(good({ 0: "X1" }), { other: { X1: ["HISENSE"] } })).toMatchObject({ reason: "store_brand_mismatch" });
    expect(one(good({ 0: "X1" }), { other: { X1: ["OUTSIDE"] } })).toMatchObject({ reason: "store_not_found" });
  });
  it("门店已撤；板块不在计划；板块编码不是约定形态", () => {
    expect(one(good(), { stores: { S1: { ...OK_STORE, status: "closed" } } }).reason).toBe("store_closed");
    expect(one(good(), {}, { plan: { platform: "douyin", sectors: new Set(["home"]) } }).reason).toBe("store_sector_not_in_plan");
    expect(one(good(), { stores: { S1: { ...OK_STORE, sectorKey: undefined } } }).reason).toBe("store_sector_not_in_plan");
  });
  it("门店分公司不在操作者范围；总部不受此限", () => {
    const w = { stores: { S1: { ...OK_STORE, branchId: SH } }, participation: { "2": "joined" as const } };
    expect(one(good(), w, { actor: { brandScope: "all", branchScope: new Set([BJ]) } }).reason).toBe("store_branch_not_authorized");
    expect(one(good(), w).cls).not.toBe("error");
  });
  it("分公司未加入或已退出", () => {
    expect(one(good(), { participation: {} }).reason).toBe("branch_not_joined");
    expect(one(good(), { participation: { "1": "exited" } }).reason).toBe("branch_not_joined");
  });
});

describe("步骤 8–11：专员与链接", () => {
  it("手机号属于另一门店的有效专员", () => {
    expect(one(good(), { staff: { "13800000001": [staffAt(99n)] } }).reason).toBe("phone_belongs_to_other_store");
  });
  it("同门店同号已停用专员 → 提示恢复，不新建；停用专员在其他门店不阻塞", () => {
    expect(one(good(), { staff: { "13800000001": [staffAt(10n, { status: "inactive" })] } }).reason).toBe("staff_inactive_restore_needed");
    expect(one(good(), { staff: { "13800000001": [staffAt(99n, { status: "inactive" })] } }).cls).toBe("new_staff");
  });
  it("有效专员优先于同号停用记录（停用记录是历史）", () => {
    const r = one(good(), { staff: { "13800000001": [staffAt(10n, { staffId: 1n, status: "inactive" }), staffAt(10n, { staffId: 2n })] } });
    expect(r).toMatchObject({ cls: "new", staffId: 2n });
  });
  it.each(["https://www.douyin.com/video/123", "https://www.douyin.com/note/9", "https://www.xiaohongshu.com/explore/abc"])("视频 / 笔记链接 %s", (u) => {
    const plat = u.includes("xiaohongshu") ? ({ platform: "xiaohongshu", sectors: new Set(["water"]) } as const) : undefined;
    expect(one(good({ 3: u }), {}, plat ? { plan: plat } : {}).reason).toBe("non_home_locator");
  });
  it("另一平台的链接 → 平台不一致，不默认成抖音", () => {
    expect(one(good({ 3: "https://www.xiaohongshu.com/user/profile/1" })).reason).toBe("platform_mismatch");
    expect(one(good({ 3: "https://v.kuaishou.com/abc" })).reason).toBe("platform_mismatch");
  });
  it("含 URL 但域名不属于任何平台 → platform_unrecognized；纯口令放行；短链域名可识别", () => {
    expect(one(good({ 3: "https://example.com/user/1" })).reason).toBe("platform_unrecognized");
    expect(one(good({ 3: "9.99 复制打开抖音 aB1:/ 12345" })).cls).toBe("new_staff");
    expect(one(good({ 3: "https://v.douyin.com/MPOAlEqWpec/" })).cls).toBe("new_staff");
    expect(one(good({ 3: "https://xhslink.com/abc" }), {}, { plan: { platform: "xiaohongshu", sectors: new Set(["water"]) } }).cls).toBe("new_staff");
  });
  it("没有「链接格式错误」这个原因码（A §11.2.2 第三层本地不实现）", () => {
    expect(one(good({ 3: "乱七八糟的文字" })).cls).toBe("new_staff");
  });
});

describe("步骤 12：文件内重复（整组报错）", () => {
  const rows = (...cells: string[][]) => classifyRows(cells.map((c, i) => row(c, i + 1)), ctx());
  it("同手机号同姓名 → duplicate_phone_in_file，两行都报", () => {
    expect(rows(good(), good({ 3: "https://www.douyin.com/user/BBB" })).map((r) => r.reason)).toEqual(["duplicate_phone_in_file", "duplicate_phone_in_file"]);
  });
  it("同手机号不同姓名 → phone_name_conflict_in_file（优先）", () => {
    expect(rows(good(), good({ 1: "别人", 3: "https://www.douyin.com/user/BBB" })).map((r) => r.reason)).toEqual(["phone_name_conflict_in_file", "phone_name_conflict_in_file"]);
  });
  it("同一清洗后入口 → duplicate_locator_in_file（清洗掉 URL 之后的垃圾再比较）", () => {
    const r = rows(good({ 2: "13800000001", 3: `${URL_A} 垃圾` }), good({ 2: "13800000002", 3: URL_A }));
    expect(r.map((x) => x.reason)).toEqual(["duplicate_locator_in_file", "duplicate_locator_in_file"]);
  });
  it("优先级：手机号无效且门店不存在 → 报手机号；重复组里已有更早错误的行保留该错误", () => {
    expect(one(good({ 0: "NOPE", 2: "bad" })).reason).toBe("phone_invalid");
    const r = rows(good({ 0: "NOPE" }), good(), good({ 3: "https://www.douyin.com/user/BBB" }));
    expect(r.map((x) => x.reason)).toEqual(["store_not_found", "duplicate_phone_in_file", "duplicate_phone_in_file"]);
  });
  it("不同手机号不同入口互不影响", () => {
    expect(rows(good(), good({ 2: "13800000002", 3: "https://www.douyin.com/user/BBB" })).map((r) => r.cls)).toEqual(["new_staff", "new_staff"]);
  });
});

describe("步骤 13：专员与入口命中", () => {
  const phone = "13800000001";
  const zhang = staffAt(10n, { staffId: 100n, name: "老张" });
  const hit = (ownerStaffId: bigint | null): World => ({ staff: { [phone]: [zhang] }, accounts: { [URL_A]: { accountId: 7n, ownerStaffId } } });
  it("专员不存在 → new_staff；专员存在 → new", () => {
    expect(one(good())).toMatchObject({ cls: "new_staff" });
    expect(one(good({ 1: "老张" }), { staff: { [phone]: [zhang] } })).toMatchObject({ cls: "new", staffId: 100n });
  });
  it("姓名与库中不同：不阻塞，detail 记 staff_name_differs", () => {
    const r = one(good({ 1: "张三" }), { staff: { [phone]: [zhang] } });
    expect(r.cls).toBe("new");
    expect(r.detail).toContain("staff_name_differs");
  });
  it("命中账号、同一专员、已在本计划名单 → unchanged", () => {
    expect(one(good({ 1: "老张" }), { ...hit(100n), roster: { "7": { state: "in_roster", staffId: 100n } } })).toMatchObject({ cls: "unchanged", reason: "already_in_roster", accountId: 7n });
  });
  it("命中账号、同一专员、名单里已移出 → update（恢复原行）", () => {
    expect(one(good({ 1: "老张" }), { ...hit(100n), roster: { "7": { state: "removed", staffId: 100n } } })).toMatchObject({ cls: "update", reason: "restore_roster_entry", accountId: 7n });
  });
  it("命中账号、同一专员、不在本计划 → new + known_account_same_owner（不算可能新增）", () => {
    const r = one(good({ 1: "老张" }), hit(100n));
    expect(r).toMatchObject({ cls: "new", reason: "known_account_same_owner" });
    expect(isPossiblyNew(r)).toBe(false);
  });
  it("命中账号但归属他人 / 外部监控账号 → 预检类不变，提示确认后归属冲突", () => {
    const r = one(good({ 1: "老张" }), hit(555n));
    expect(r).toMatchObject({ cls: "new", reason: "known_account_other_owner" });
    expect(one(good({ 1: "老张" }), hit(null)).reason).toBe("known_account_other_owner");
    expect(one(good(), { accounts: { [URL_A]: { accountId: 7n, ownerStaffId: 555n } } })).toMatchObject({ cls: "new_staff", reason: "known_account_other_owner" });
    expect(isPossiblyNew(r)).toBe(false);
  });
  it("没有命中的 new / new_staff 才是「可能新增」", () => {
    expect(isPossiblyNew(one(good()))).toBe(true);
    expect(isPossiblyNew({ cls: "unchanged" })).toBe(false);
  });
});

describe("纯函数：同一输入重复分类结果相同", () => {
  it("两次调用相等", () => {
    const rows = [row(good(), 1), row(good({ 0: "NOPE", 2: "13800000002" }), 2)];
    expect(classifyRows(rows, ctx())).toEqual(classifyRows(rows, ctx()));
  });
});
