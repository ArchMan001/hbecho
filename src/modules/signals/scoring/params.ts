// 参数指纹与监控段解析（design §7.5）：requestScores 与读取口共用，保证「请求时算的键」与「读取时查的键」是同一个。
//   模板 / 元素匹配 = 标准图 / 元素图字节的 SHA-256；asr_text = 32 个零字节；
//   asr_judgement = jcsSha256({standard_text(规范化), prompt_version, model_version})，**先取模型版本再算指纹**（SG-D18）。
import { and, eq } from "drizzle-orm";
import type { Db } from "../../../db/client";
import { monitoringSegments, segmentImages } from "../../../db/schema";
import { jcsSha256 } from "../../canonical-json";
import type { CatalogEntry } from "../catalog";
import { SignalError } from "../errors";
import { JUDGE_PROMPT_ID, JUDGE_PROMPT_VERSION } from "../speech/prompt";
import type { AiGatewayPort } from "../speech/ports";
import { normalizeText } from "../text/normalize";
import { imageSlotOf, type SegmentItem } from "../segments/items";

export const ZERO_PARAM = Buffer.alloc(32);
export type SegmentRef = { planId: bigint; version: number };
export type Param = { segment: SegmentRef; elementKey?: string };

export type ResolvedParam =
  | { available: true; paramSha: Buffer; segmentImageId?: bigint; standardText?: string; modelVersion?: string }
  /** 没有可用的参数：判定模型不可用（不能算参数指纹），不建任务、读作 capability_disabled。 */
  | { available: false; reason: "capability_disabled" };

const notFound = (code: string, message: string): never => {
  throw new SignalError("not_found", code, message);
};

export async function loadSegmentRow(db: Db, ref: SegmentRef) {
  const [seg] = await db.select().from(monitoringSegments).where(and(eq(monitoringSegments.planId, ref.planId), eq(monitoringSegments.version, ref.version)));
  return seg ?? notFound("segment_not_found", "监控段不存在");
}

/** 解出一个信号在监控段里的参数；参数化信号的图片 / 判定项不存在 → 抛错（executability 已把它列为阻塞项）。 */
export async function resolveParam(db: Db, gateway: Pick<AiGatewayPort, "activeModel"> | undefined, entry: CatalogEntry, param: Param | undefined): Promise<ResolvedParam> {
  if (entry.scope === "global") return { available: true, paramSha: ZERO_PARAM };
  if (!param) throw new SignalError("input", "param_required", `信号 ${entry.key} 是参数化信号，必须给 param`);
  const seg = await loadSegmentRow(db, param.segment);
  if (entry.key === "content.asr_judgement") {
    const item = (seg.items as SegmentItem[]).find((i) => i.signal === entry.key);
    if (!item?.standard_text) return notFound("judgement_item_not_found", "监控段里没有判定项");
    const model = gateway ? await gateway.activeModel("judge") : null; // 先取模型版本，再算参数指纹
    if (model === null) return { available: false, reason: "capability_disabled" };
    const standardText = normalizeText(item.standard_text);
    return { available: true, paramSha: jcsSha256({ standard_text: standardText, prompt_id: JUDGE_PROMPT_ID, prompt_version: JUDGE_PROMPT_VERSION, model_version: model }), standardText, modelVersion: model };
  }
  const slot = imageSlotOf(entry.key)!;
  const elementKey = slot.kind === "element" ? (param.elementKey ?? "") : "";
  if (slot.kind === "element" && elementKey === "") throw new SignalError("input", "param_required", `元素匹配信号 ${entry.key} 需要 param.elementKey`);
  const [img] = await db
    .select({ id: segmentImages.imageId, sha: segmentImages.sha256 })
    .from(segmentImages)
    .where(and(eq(segmentImages.planId, param.segment.planId), eq(segmentImages.version, param.segment.version), eq(segmentImages.kind, slot.kind), eq(segmentImages.target, slot.target), eq(segmentImages.elementKey, elementKey)));
  if (!img) return notFound("segment_image_not_found", `监控段里没有 ${slot.target} 的${slot.kind === "template" ? "模板图" : `元素图 ${elementKey}`}`);
  return { available: true, paramSha: img.sha, segmentImageId: img.id };
}

// ───────────── 复用键与任务种类（请求时、读取时、runner 写结果时用同一套）─────────────
import { versionOf } from "../catalog";
import type { TaskKind } from "../tasks/queue";

export function taskKindOf(signalKey: string): TaskKind {
  if (signalKey === "content.asr_text") return "asr_text";
  if (signalKey === "content.asr_judgement") return "asr_judgement";
  return imageSlotOf(signalKey)!.kind === "template" ? "score_template" : "score_element";
}

/** 复用键 = 信号键 + 能力标识 + 能力版本 + 素材指纹 + 参数指纹（PRD C §3.6）；任务幂等键由它派生。 */
export const reuseKeyOf = (entry: CatalogEntry, materialSha: Buffer, paramSha: Buffer) => ({
  signal_key: entry.key,
  capability_id: entry.capability,
  capability_version: versionOf(entry.capability),
  material_sha256: materialSha.toString("hex"),
  param_sha256: paramSha.toString("hex"),
});
