import type { ProviderRequest } from "../raw-capture";
import type { AiMasterAction, ExecutionMode, RequestCursor } from "./contract";

export interface BuildRequestInput {
  action: AiMasterAction;
  mode: ExecutionMode;
  /** 入口文本（主页入口，或内容链接），原样放进 url 字段。 */
  locator: string;
  /** 仅 user_video_list / post_comments_list 使用；缺省为整数 0（raw3/raw4 的首页请求）。 */
  cursor?: RequestCursor | undefined;
}
/** 评论不取回复：-1（A §6.1；回复只在已保存样本中以扁平 parent_id 条目出现）。 */
const COMMENT_REPLY_PAGES = -1;
const PATH: Record<AiMasterAction, string> = {
  media_user_info: "/openapi/v1/media_user_info",
  user_video_list: "/openapi/v1/user_video_list",
  media_stats_number: "/openapi/v1/media_stats_number",
  post_comments_list: "/openapi/v1/media/comments/list",
};

function cursorLiteral(c: RequestCursor): string {
  if (c.kind === "string") return JSON.stringify(c.value);
  if (c.kind === "integer" && /^-?\d+$/.test(c.lexeme)) return c.lexeme; // 原文，不经 number
  throw new TypeError("请求游标只能是整数或字符串，且不互相转换");
}

/** 构造准确的请求字节。async 取自 mode（由 capability 决定），不写死；认证头不在这里。 */
export function buildRequest(input: BuildRequestInput): ProviderRequest {
  const url = JSON.stringify(input.locator);
  const cursor = () => cursorLiteral(input.cursor ?? { kind: "integer", lexeme: "0" });
  const body =
    input.action === "user_video_list"
      ? `{"url":${url},"max_cursor":${cursor()}}`
      : input.action === "post_comments_list"
        ? `{"url":${url},"max_cursor":${cursor()},"reply_pages":${COMMENT_REPLY_PAGES}}`
        : `{"url":${url}}`;
  return {
    method: "POST",
    path: PATH[input.action],
    query: { async: input.mode === "asynchronous" ? "true" : "false" },
    body: new TextEncoder().encode(body),
  };
}
