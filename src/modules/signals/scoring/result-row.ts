// 结果行的构造（评分 runner 与语音 runner 共用）：复用键 = 信号键 + 能力标识 + 能力版本 + 素材指纹 + 参数指纹；
// 血缘（计划 ID / 版本 / 请求人）只记在 lineage，不进复用键。成功保留一年，失败保留三个月。
import type { signalResults } from "../../../db/schema";
import { requireSignal, versionOf } from "../catalog";
import { failureExpiry, successExpiry } from "../ttl";

export interface TaskParamsBase {
  signal_key: string;
  material_sha256: string;
  param_sha256: string;
  source: { media_asset_id: string };
  segment_image_id?: string;
  lineage: { plan_id: string; version: number; requested_by: string };
  caller?: { actor: string; scope_fingerprint?: string };
}

export type ResultBody = { state: "valid"; score?: number; value?: unknown; evidence: unknown } | { state: "failed"; code: string; evidence: unknown };

export function buildResultRow(p: TaskParamsBase, now: Date, body: ResultBody): typeof signalResults.$inferInsert {
  const entry = requireSignal(p.signal_key);
  const valid = body.state === "valid";
  return {
    signalKey: p.signal_key,
    materialSha256: Buffer.from(p.material_sha256, "hex"),
    paramSha256: Buffer.from(p.param_sha256, "hex"),
    capabilityId: entry.capability,
    capabilityVersion: versionOf(entry.capability),
    state: body.state,
    score: valid && body.score !== undefined ? body.score.toFixed(2) : null,
    value: valid && body.value !== undefined ? body.value : null,
    evidence: body.evidence,
    failureCode: valid ? null : body.code,
    lineage: { plan_id: p.lineage.plan_id, version: p.lineage.version, requested_by: p.lineage.requested_by },
    producedAt: now,
    expiresAt: valid ? successExpiry(now) : failureExpiry(now),
    createdAt: now,
  };
}
