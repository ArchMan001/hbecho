// 测试用小工具：把 DecodeOutcome 收窄为 decoded 并取出 data；构造合成响应字节。
import type { DecodeOutcome } from "../../src/modules/provider-adapter";

export function decodedData<T>(outcome: DecodeOutcome<T>): T {
  if (outcome.outcome !== "decoded") {
    throw new Error(`期望 decoded，实际 ${JSON.stringify(outcome)}`);
  }
  return outcome.data;
}

const enc = new TextEncoder();

/** 把任意 JSON 文本当作响应字节（不经 stringify，便于写大整数等无损场景）。 */
export function bytesOf(text: string): Uint8Array {
  return enc.encode(text);
}

/** 构造一份成功的 AI Master 响应信封（result 为 JSON 文本，原样嵌入）。 */
export function envelope(action: string, resultJson: string, extra: { status?: string; taskId?: string } = {}): Uint8Array {
  const status = extra.status ?? "succeeded";
  const taskId = extra.taskId ?? "task-1";
  return bytesOf(
    `{"code":0,"data":{"task_id":"${taskId}","action":"${action}","status":"${status}","result":${resultJson},"error":null},"request_id":"${taskId}"}`,
  );
}
