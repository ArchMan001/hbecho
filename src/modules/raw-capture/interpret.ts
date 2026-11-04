// 先捕获、后解析：decoder 只接受 CapturedProviderResult 的字节；解释的 lineage 与 ODS 证据分开记录。
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../../db/client";
import { odsPayloads } from "../../db/schema";
import type { DecodeOutcome } from "../provider-adapter";
import type { CapturedProviderResult } from "./captured";
import type { CallSpec, ExecuteOutcome, RawCaptureGateway } from "./gateway";

/** 一次解释的出处：哪次调用、哪条 payload、哪段字节（SHA-256）、哪个 Adapter 版本。投影时写进快照的 lineage 列。 */
export interface Lineage {
  providerCallId: bigint;
  payloadId: bigint;
  responseSha256: string;
  adapterVersion: string;
}

export interface Interpreted<T> {
  outcome: DecodeOutcome<T>;
  lineage: Lineage;
}

function parseErrorOf(o: DecodeOutcome<unknown>): string | null {
  if (o.outcome === "schema_drift") return `schema_drift:${o.issues.join(",")}`.slice(0, 200);
  if (o.outcome === "invalid_response") return `invalid_response:${o.reason}`;
  return null;
}

/**
 * 解析已捕获的字节。payload 行记录**首次**解释（parse_status / adapter_version / parse_error，只写一次）；
 * 之后用新 Adapter 版本重放，得到新的 lineage 对象，但不改写 payload 行，也不动 ODS 对象——历史解释不被覆盖。
 */
export async function interpretCaptured<T>(
  db: Db,
  captured: CapturedProviderResult,
  decode: (bytes: Uint8Array) => DecodeOutcome<T>,
): Promise<Interpreted<T>> {
  const outcome = decode(captured.responseBody);
  const parseError = parseErrorOf(outcome);
  await db
    .update(odsPayloads)
    .set({ parseStatus: parseError ? "invalid" : "parsed", adapterVersion: outcome.adapterVersion, parseError })
    .where(and(eq(odsPayloads.payloadId, captured.payloadId), isNull(odsPayloads.adapterVersion)));
  return {
    outcome,
    lineage: {
      providerCallId: captured.providerCallId,
      payloadId: captured.payloadId,
      responseSha256: captured.responseSha256,
      adapterVersion: outcome.adapterVersion,
    },
  };
}

/**
 * 一次完整调用的标准流程：执行 → 解释 → 投影。
 * decode 只在拿到 captured 结果时运行；project 只在解码成功且 fence 仍有效时运行（陈旧 worker 不发布）。
 */
export async function callAndInterpret<T>(
  gateway: RawCaptureGateway,
  spec: CallSpec,
  decode: (bytes: Uint8Array) => DecodeOutcome<T>,
  project?: (interpreted: Interpreted<T>, captured: CapturedProviderResult) => Promise<void>,
): Promise<{ exec: ExecuteOutcome; interpreted?: Interpreted<T> }> {
  const exec = await gateway.execute(spec);
  if (exec.kind !== "captured") return { exec };
  const interpreted = await interpretCaptured(gateway.db, exec.captured, decode);
  if (project && exec.fenceValid && interpreted.outcome.outcome === "decoded") await project(interpreted, exec.captured);
  return { exec, interpreted };
}
