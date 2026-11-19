// 账号级「每能力一个结果」（D-D23、requirements JP-22、e-metrics-lite EL-6）。纯函数，没有 IO。
// 规则复用 D 现有的 at_least_n 与零内容规则，不改任何判定结果；第四态 skipped 只用于展示，不进判定枚举。
import type { ConditionDesc } from "../../config";
import { contentOutcome, type ZeroContext } from "./aggregate";
import { evaluateMethod } from "./tri";
import type { Outcome, Tri } from "./types";

export type AbilityOutcome = Outcome | "skipped";
export interface AbilityResult {
  key: string;
  result: AbilityOutcome;
  reason?: string;
}
/** 一条参与内容行里本函数用到的部分（evidence 是 run_contents.evidence 原样）。 */
export interface AbilityRow {
  final: Tri | "skipped" | null;
  evidence: unknown;
}
/** run_participants.account_detail 的形状（runner 的 scores 阶段写入）。 */
export interface AccountDetailLite {
  result?: string;
  reason?: string;
  abilities?: Array<{ id: string; state?: string; reason?: string }>;
}
const TRI_OUTCOME: Record<string, Outcome> = { pass: "success", fail: "not_met", unobtained: "unobtained" };

interface L1Entry { idx: number; state?: Tri }
interface L2Entry { id: string; state?: Tri }
const evOf = (row: AbilityRow) => (row.evidence ?? {}) as { l1?: L1Entry[]; l2?: { abilities?: L2Entry[] }; l3?: { state?: Tri } };

/** 取某内容行里该条件的状态；没有证据（没评估到）返回 undefined。 */
export function stateOf(c: ConditionDesc, row: AbilityRow): Tri | undefined {
  const ev = evOf(row);
  if (c.layer === 1) return ev.l1?.find((e) => e.idx === Number(c.key.slice(3)))?.state;
  if (c.layer === 2) return ev.l2?.abilities?.find((e) => `l2.${e.id}` === c.key)?.state;
  if (c.layer === 3) return ev.l3?.state;
  return undefined;
}

export interface AbilityInput {
  conditions: readonly ConditionDesc[];
  rows: readonly AbilityRow[];
  /** 内容要求的 N（quantity ?? 1） */
  n: number;
  zero: ZeroContext;
  accountDetail: AccountDetailLite | null;
  /** 评论要求的结果；没配评论要求为 null */
  commentResult: Outcome | null;
}

export function abilityOutcomes(input: AbilityInput): AbilityResult[] {
  const out: AbilityResult[] = [];
  for (const c of input.conditions) {
    if (c.subject === "account") {
      const d = input.accountDetail;
      if (!d) continue; // 账号要求没启用或还没算：不写
      const id = c.key.slice(3);
      const hit = d.abilities?.find((a) => a.id === id);
      if (hit?.state && TRI_OUTCOME[hit.state]) out.push({ key: c.key, result: TRI_OUTCOME[hit.state]!, ...(hit.reason ? { reason: hit.reason } : {}) });
      else {
        // 没有逐能力的结果（如没有主页快照时整体未获取成功）：沿用账号要求的整体结果与原因
        const r = d.result === "pass" ? "success" : d.result === "fail" ? "not_met" : "unobtained";
        out.push({ key: c.key, result: r, ...(d.reason ? { reason: d.reason } : {}) });
      }
      continue;
    }
    if (c.layer === "comment") {
      if (input.commentResult !== null) out.push({ key: c.key, result: input.commentResult });
      continue;
    }
    let p = 0, u = 0, f = 0;
    for (const row of input.rows) {
      const s = stateOf(c, row);
      if (s === "pass") p++;
      else if (s === "fail") f++;
      else if (s === "unobtained") u++;
      else if (s === undefined && row.final === "unobtained") u++; // 没评估到、但最终未获取成功：它可能通过，与内容聚合一致
    }
    if (c.layer === 1) {
      // 第 1 层条件的评估集是全部行（含被数量要求截掉的行，它们保留着第 1 层证据）；零内容 = 没有任何参与内容行
      const j = contentOutcome({ p, u, f, skipped: 0, rows: input.rows.length }, input.n, input.zero);
      out.push({ key: c.key, result: j.result, ...(j.reason ? { reason: j.reason } : {}) });
    } else if (p + u + f === 0) {
      out.push({ key: c.key, result: "skipped" }); // 没有内容走到这一层：前置条件未满足
    } else {
      const r = evaluateMethod({ type: "at_least_n", n: input.n }, { p, u, f });
      out.push({ key: c.key, result: r === "zero" ? "not_met" : r });
    }
  }
  return out;
}
