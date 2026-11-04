// 响应「调用元数据」提取：只在响应字节已可靠落 ODS 之后，为 ods_provider_calls 的 response_action / provider_code /
// provider_task_id 等列取值。它不是业务解释（那是版本化 Adapter 的事）；不可解析时全部为 null，绝不抛异常。
import { JsonNumber, isJsonObject, parseJson, type JsonValue } from "./lossless-json";

export interface ResponseMeta {
  parseable: boolean;
  /** 顶层 code：成功信封是数字 0（原文 "0"），错误体是字符串。 */
  topLevelCode: string | null;
  action: string | null;
  taskStatus: string | null;
  providerTaskId: string | null;
  providerRequestId: string | null;
  /** 顶层字符串 code（HTTP 400/500 的错误体），否则 data.error.code。 */
  errorCode: string | null;
  /** 任务已成功但 result 为 null / 缺失（间歇性 result:null）。 */
  resultIsNull: boolean;
}

const EMPTY: ResponseMeta = Object.freeze({
  parseable: false,
  topLevelCode: null,
  action: null,
  taskStatus: null,
  providerTaskId: null,
  providerRequestId: null,
  errorCode: null,
  resultIsNull: false,
});

// 字符串或整数 token（原文）；其余一律 null。限长，避免把任意载荷搬进调用表。
function scalar(v: JsonValue | undefined, max: number): string | null {
  if (typeof v === "string") return v.slice(0, max);
  if (v instanceof JsonNumber && /^-?\d+$/.test(v.source)) return v.source.slice(0, max);
  return null;
}

export function peekResponseMeta(bytes: Uint8Array): ResponseMeta {
  let root: JsonValue;
  try {
    root = parseJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return { ...EMPTY };
  }
  if (!isJsonObject(root)) return { ...EMPTY };

  const data = isJsonObject(root.data) ? root.data : null;
  const dataError = data && isJsonObject(data.error) ? data.error : null;
  const topCode = scalar(root.code, 128);
  const taskStatus = data ? scalar(data.status, 64) : null;
  const topIsString = typeof root.code === "string";

  return {
    parseable: true,
    topLevelCode: topCode,
    action: data ? scalar(data.action, 64) : null,
    taskStatus,
    providerTaskId: data ? scalar(data.task_id, 512) : null,
    providerRequestId: scalar(root.request_id, 512),
    errorCode: topIsString ? topCode : dataError ? scalar(dataError.code, 128) : null,
    resultIsNull: data !== null && taskStatus === "succeeded" && (!Object.hasOwn(data, "result") || data.result === null),
  };
}
