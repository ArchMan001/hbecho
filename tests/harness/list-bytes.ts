// 合成的 user_video_list 响应字节：用于任务 6 的页契约测试（重复条目、空列表、游标变体）。
// 结构与 raw3 一致；游标按原文写入，所以可以构造整数 / 字符串 / null / 缺失 / 超长。
import { envelope } from "./decode-helpers";

export interface SyntheticEntry {
  postId: string | null;
  userId?: string;
  createdMs?: number | null;
  like?: number | null | "absent";
  title?: string | null;
  video?: boolean;
  cover?: string[] | string;
}

export function entryJson(e: SyntheticEntry): string {
  const parts: string[] = [];
  if (e.postId !== null) parts.push(`"post_id":${JSON.stringify(e.postId)}`);
  parts.push(`"user_id":${JSON.stringify(e.userId ?? "HITACHI1")}`);
  if (e.createdMs !== null) parts.push(`"created":${e.createdMs ?? 1788169004000}`);
  if (e.title !== null) parts.push(`"title":${JSON.stringify(e.title ?? "标题")}`);
  const stats: string[] = [];
  if (e.like !== "absent") stats.push(`"like_count":${e.like === null || e.like === undefined ? (e.like === null ? "null" : "1") : e.like}`);
  parts.push(`"stats":{${stats.join(",")}}`);
  parts.push(`"video":${e.video === false ? '{"url":"","duration":0}' : '{"url":"https://v.example/x.mp4","duration":1.5}'}`);
  parts.push(`"images":[]`);
  parts.push(`"cover":${JSON.stringify(e.cover ?? ["https://c.example/1", "https://c.example/2", "https://c.example/3"])}`);
  return `{${parts.join(",")}}`;
}

/** cursorJson 是 max_cursor 的 JSON 原文（例如 "0"、"\"abc\""、"null"）；undefined 表示不带该字段。 */
export function listBytes(entries: SyntheticEntry[], o: { hasMore?: boolean; cursorJson?: string | undefined } = {}): Uint8Array {
  const cursor = o.cursorJson === undefined ? "" : `,"max_cursor":${o.cursorJson}`;
  return envelope("user_video_list", `{"result":[${entries.map(entryJson).join(",")}],"has_more":${o.hasMore ?? false}${cursor}}`);
}
