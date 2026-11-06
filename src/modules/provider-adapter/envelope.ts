// AI Master 响应信封的共同解码：UTF-8 → 无损 JSON → action 核对 → 任务状态 → result 对象。
import {
  ADAPTER_VERSION,
  type ActionExchange,
  type AiMasterAction,
  type DecodeOutcome,
  type Platform,
} from "./contract";
import { isJsonObject, parseJson, type JsonObject } from "./lossless-json";
import { readText, type ValueState } from "./value-state";

/** 请求 action 与期望的响应 action。只有详情不同：请求 media_stats_number，响应 media_stats（requested / expected / actual 分列）。 */
export const EXPECTED_RESPONSE_ACTION: Record<AiMasterAction, string> = {
  media_user_info: "media_user_info",
  user_video_list: "user_video_list",
  media_stats_number: "media_stats",
  post_comments_list: "post_comments_list",
};

type Opened =
  | { ok: true; result: JsonObject; exchange: ActionExchange; taskId: ValueState<string> }
  | { ok: false; outcome: DecodeOutcome<never> };

export function openEnvelope(platform: Platform, requested: AiMasterAction, bytes: Uint8Array): Opened {
  const base = { adapterVersion: ADAPTER_VERSION, platform };
  const drift = (...issues: string[]): Opened => ({
    ok: false,
    outcome: { outcome: "schema_drift", ...base, issues },
  });

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return drift("invalid_utf8");
  }
  let root;
  try {
    root = parseJson(text);
  } catch {
    return drift("invalid_json");
  }
  if (!isJsonObject(root)) return drift("root_not_object");
  const data = root.data;
  if (!isJsonObject(data)) return drift("missing_data");

  const exchange: ActionExchange = {
    requested,
    expectedResponse: EXPECTED_RESPONSE_ACTION[requested],
    actualResponse: readText(data, "action"),
  };
  if (exchange.actualResponse.state !== "value" || exchange.actualResponse.value !== exchange.expectedResponse) {
    return { ok: false, outcome: { outcome: "invalid_response", reason: "action_mismatch", ...base, exchange } };
  }

  const status = readText(data, "status");
  if (status.state !== "value") return drift("missing_status");
  if (status.value !== "succeeded") {
    const err = data.error;
    const error = isJsonObject(err)
      ? {
          code: (() => {
            const c = readText(err, "code");
            return c.state === "value" ? c.value : null;
          })(),
          message: (() => {
            const m = readText(err, "message");
            return m.state === "value" ? m.value : null;
          })(),
        }
      : null;
    return { ok: false, outcome: { outcome: "not_succeeded", ...base, exchange, taskStatus: status.value, error } };
  }

  const result = data.result;
  if (!isJsonObject(result)) return drift("result_not_object");
  return { ok: true, result, exchange, taskId: readText(data, "task_id") };
}
