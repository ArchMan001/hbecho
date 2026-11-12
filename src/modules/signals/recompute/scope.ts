// 重算范围（requirements SG-11，design §7.10）：校验、规范化、品牌范围约束。
// 范围种类：contentIds / accountIds / brandCode（经账号**当前**归属展开）/ publishedFrom–To；至少一项。
// segmentRef 只是附加键（结果类信号重算必须带它），不能单独作为范围。「活动」由 D 展开成 accountIds 传入，C 不认识活动。
import { jcsSha256, type JcsValue } from "../../canonical-json";
import { brandInScope, type SignalActor } from "../authz";
import { SignalError } from "../errors";
import { createFacts, type SubjectScope } from "../facts";
import type { Db } from "../../../db/client";

export interface RecomputeScopeInput {
  contentIds?: ReadonlyArray<bigint | string>;
  accountIds?: ReadonlyArray<bigint | string>;
  brandCode?: string;
  publishedFrom?: Date | string;
  publishedTo?: Date | string;
  segmentRef?: { planId: bigint | string; version: number };
}

/** 持久化在 signal_recompute_runs.scope 里的规范形态：chunk 任务据此展开，不需要操作者在场。 */
export interface CanonicalScope {
  content_ids?: string[];
  account_ids?: string[];
  brand_id?: string;
  published_from?: string;
  published_to?: string;
  segment_ref?: { plan_id: string; version: number };
  /** 操作者的品牌范围（内部品牌 ID）；null = 全部品牌。范围外的对象不在展开结果里。 */
  restrict_brand_ids: string[] | null;
}

const bad = (code: string, message: string): never => {
  throw new SignalError("input", code, message);
};
const idString = (v: bigint | string, what: string): string => (typeof v === "bigint" ? (v > 0n ? v.toString() : bad("scope_invalid", `${what} 必须是正整数`)) : /^[1-9]\d*$/.test(v) ? v : bad("scope_invalid", `${what} 必须是不带前导零的正十进制整数`));
const idList = (xs: ReadonlyArray<bigint | string>, what: string): string[] => [...new Set(xs.map((x) => idString(x, what)))].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
const when = (v: Date | string, what: string): string => {
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? bad("scope_invalid", `${what} 不是合法时间`) : d.toISOString();
};

export async function canonicalizeScope(db: Db, actor: SignalActor, input: RecomputeScopeInput): Promise<CanonicalScope> {
  const facts = createFacts(db);
  const out: CanonicalScope = { restrict_brand_ids: null };
  if (input.contentIds !== undefined) out.content_ids = idList(input.contentIds, "contentIds");
  if (input.accountIds !== undefined) out.account_ids = idList(input.accountIds, "accountIds");
  if (input.publishedFrom !== undefined) out.published_from = when(input.publishedFrom, "publishedFrom");
  if (input.publishedTo !== undefined) out.published_to = when(input.publishedTo, "publishedTo");
  if (input.brandCode !== undefined) {
    if (!brandInScope(actor, input.brandCode)) throw new SignalError("authorization", "brand_out_of_scope", "品牌不在你的授权范围内");
    const id = (await facts.brandIdsOf([input.brandCode])).get(input.brandCode);
    if (id === undefined) throw new SignalError("not_found", "brand_not_found", `品牌 ${input.brandCode} 不存在`);
    out.brand_id = id.toString();
  }
  if (out.content_ids === undefined && out.account_ids === undefined && out.brand_id === undefined && out.published_from === undefined && out.published_to === undefined) {
    bad("scope_required", "重算必须给出范围：contentIds / accountIds / brandCode / publishedFrom–To 至少一项（不提供「重算全部」）");
  }
  if (input.segmentRef !== undefined) {
    if (!Number.isInteger(input.segmentRef.version) || input.segmentRef.version < 1) bad("scope_invalid", "segmentRef.version 必须是正整数");
    out.segment_ref = { plan_id: idString(input.segmentRef.planId, "segmentRef.planId"), version: input.segmentRef.version };
  }
  if (actor.brandScope !== "all") {
    const ids = await facts.brandIdsOf([...actor.brandScope]);
    out.restrict_brand_ids = [...ids.values()].map(String).sort();
  }
  return out;
}

export const scopeSha = (s: CanonicalScope): Buffer => jcsSha256(s as unknown as JcsValue);

/** 规范形态 → facts 的展开参数。 */
export function toSubjectScope(s: CanonicalScope): SubjectScope {
  return {
    ...(s.content_ids ? { contentIds: s.content_ids.map(BigInt) } : {}),
    ...(s.account_ids ? { accountIds: s.account_ids.map(BigInt) } : {}),
    ...(s.brand_id ? { brandId: BigInt(s.brand_id) } : {}),
    ...(s.published_from ? { publishedFrom: new Date(s.published_from) } : {}),
    ...(s.published_to ? { publishedTo: new Date(s.published_to) } : {}),
    ...(s.restrict_brand_ids ? { restrictBrandIds: s.restrict_brand_ids.map(BigInt) } : {}),
  };
}
