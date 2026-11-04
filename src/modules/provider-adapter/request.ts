import type { ProviderRequest } from "../raw-capture";
import type { AiMasterAction, ExecutionMode, RequestCursor } from "./contract";

export interface BuildRequestInput {
  action: AiMasterAction;
  mode: ExecutionMode;
  /** 清洗后的入口文本，原样放进 url 字段。 */
  locator: string;
  /** 仅 user_video_list 使用；缺省为整数 0（raw3/raw4 的首页请求）。 */
  cursor?: RequestCursor | undefined;
}

function cursorLiteral(c: RequestCursor): string {
  if (c.kind === "string") return JSON.stringify(c.value);
  if (c.kind === "integer" && /^-?\d+$/.test(c.lexeme)) return c.lexeme; // 原文，不经 number
  throw new TypeError("请求游标只能是整数或字符串，且不互相转换");
}

/** 构造准确的请求字节。async 取自 mode（由 capability 决定），不写死；认证头不在这里。 */
export function buildRequest(input: BuildRequestInput): ProviderRequest {
  const url = JSON.stringify(input.locator);
  const body =
    input.action === "user_video_list"
      ? `{"url":${url},"max_cursor":${cursorLiteral(input.cursor ?? { kind: "integer", lexeme: "0" })}}`
      : `{"url":${url}}`;
  return {
    method: "POST",
    path: `/openapi/v1/${input.action}`,
    query: { async: input.mode === "asynchronous" ? "true" : "false" },
    body: new TextEncoder().encode(body),
  };
}
