export type PayloadRole = "request_body" | "response_body" | "transport_error";

/** 私有 ODS 对象键：ASCII；含角色与内容摘要，便于 orphan sweeper 与排障；uniq 保证并发上传不互相覆盖。 */
export function odsKey(now: Date, role: PayloadRole, sha256Hex: string, uniq: string): string {
  const day = now.toISOString().slice(0, 10).replaceAll("-", "");
  return `ods/${day}/${role}/${sha256Hex}-${uniq}`;
}

export const ODS_PREFIX = "ods/";
