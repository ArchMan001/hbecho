// D 对 C、A 的端口（design §4.1）。类型直接取自 C、A 的真实实现（只 import type），避免两边悄悄分叉；
// 真实封装只是把 AuthContext 译成各自的 Actor 后转调，fake 供离线测试。对 C、A 的调用不得出现在数据库事务回调里（护栏守）。
import type { Executability, ImageKey, RequestResult, SegmentKey, SegmentRef, SignalActor, SignalValue, Subject, createSegments } from "../signals";
import type { DemandView, SubmitDemand, SubmitResult } from "../demand";
import type { ActorContext } from "../tracer-command";

export type { Executability, ImageKey, RequestResult, SegmentKey, SegmentRef, SignalActor, SignalValue, Subject, DemandView, SubmitDemand, SubmitResult, ActorContext };

type Segments = ReturnType<typeof createSegments>;
export interface SignalsPort {
  /** 该平台上可得的信号键（C 的目录是唯一真相，D 不写平台常量）。 */
  platformSignals(platform: string): ReadonlySet<string>;
  /** `only`：只检查这些信号，其它信号的缺口不算（C 的 `segments.executability(actor, ref, { only })`）。 */
  executability(actor: SignalActor, ref: SegmentRef, o?: { only?: readonly string[] }): Promise<Executability>;
  segments: Pick<Segments, "create" | "setItems" | "putImage" | "removeImage" | "show" | "publish" | "newDraft" | "purge">;
  /** `only` 必传：本次只补算这些信号键，`not_executable` 也只看它们；不传会为 C1 连带建第 3 层（付费）任务。 */
  requestScores(actor: SignalActor, ref: SegmentRef, subjects: readonly Subject[], ctx: { caller?: string; scopeFingerprint?: string; only: readonly string[] }): Promise<RequestResult>;
  /** 键是主体 ID（同一次调用的主体种类相同）。 */
  readMany(actor: SignalActor, subjects: readonly Subject[], signalKey: string, o?: { param?: { segment: SegmentRef; elementKey?: string } }): Promise<Map<bigint, SignalValue>>;
  normalizeKeyword(raw: string, version?: number): string;
  retainUntil(actor: SignalActor, resultIds: readonly bigint[], until: Date): Promise<{ matched: number }>;
}
export interface DemandPort {
  submit(actor: ActorContext, input: SubmitDemand): Promise<SubmitResult>;
  get(actor: ActorContext, batchId: string): Promise<DemandView>;
}
