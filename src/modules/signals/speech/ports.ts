// AI 网关端口（requirements SG-9、design SG-D09）。H1（h-ai-min）尚未落地，C 先定义端口；默认实现是禁用（任务 9）。
// 所有模型调用只经这个端口；C 自己不直连任何模型供应商。每次调用带 callKey（= 任务幂等键的十六进制），
// 网关对相同 callKey 返回同一结果且不重复计费（H PRD §4.6）。
export type ModelPurpose = "asr" | "judge";

export interface TranscribeRequest {
  callKey: string;
  /** 短期签名 URL；不得进日志、审计或结果证据。 */
  audioUrl: string;
}
export interface TranscribeResult {
  text: string;
  language: string;
  durationMs: number | null;
  model: string;
}
export interface JudgeRequest {
  callKey: string;
  transcript: string;
  standardText: string;
  promptVersion: number;
}
export interface JudgeResult {
  verdict: "meets" | "not_meets";
  reason: string;
  model: string;
}

export interface AiGatewayPort {
  /**
   * 当前已验证可用的模型版本；没有则 null（此时不建任务、不发调用）。
   * 返回 Promise：H1 可能要查配置，同步实现也可以直接 async；调用方在算参数指纹**之前**取一次（SG-D18）。
   */
  activeModel(purpose: ModelPurpose): Promise<string | null>;
  transcribe(req: TranscribeRequest): Promise<TranscribeResult>;
  judge(req: JudgeRequest): Promise<JudgeResult>;
}
