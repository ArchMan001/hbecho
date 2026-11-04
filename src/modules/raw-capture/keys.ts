export type PayloadRole = "request_body" | "response_body" | "transport_error";

/**
 * 私有 ODS 对象键：ASCII；含角色与内容摘要，便于 orphan sweeper 与排障；uniq 保证并发上传不互相覆盖。
 * `prefix` 由调用方决定（例如 smoke 用 `smoke/` 把证据与正式数据分开）；键里带什么前缀就写在数据库里什么前缀，
 * 存储实现不再做隐式改写——否则 `oss_objects.object_key` 会指不到真实对象。
 */
export function odsKey(now: Date, role: PayloadRole, sha256Hex: string, uniq: string, prefix = ""): string {
  const day = now.toISOString().slice(0, 10).replaceAll("-", "");
  return `${prefix}ods/${day}/${role}/${sha256Hex}-${uniq}`;
}

export const ODS_PREFIX = "ods/";
