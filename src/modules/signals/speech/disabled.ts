// 默认网关：禁用（SG-D09）。H1（h-ai-min）落地并通过 smoke 之前，第 3 层不会发出任何付费调用：
// activeModel 一律返回 null → 不建任务、读作 capability_disabled、executability 列出阻塞项。
import type { AiGatewayPort } from "./ports";

export class DisabledAiGateway implements AiGatewayPort {
  async activeModel(): Promise<null> {
    return null;
  }
  async transcribe(): Promise<never> {
    throw new Error("DisabledAiGateway：不应被调用（activeModel 为 null 时不建任务）");
  }
  async judge(): Promise<never> {
    throw new Error("DisabledAiGateway：不应被调用（activeModel 为 null 时不建任务）");
  }
}
