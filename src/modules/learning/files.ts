// 上传文件的类型白名单、对象 key 形态与魔数（requirements G-5、design D13）。
// 只信扩展名会被改名文件绕过，所以直传之后读对象头几个字节再判一次。
import { randomUUID } from "node:crypto";

export type UploadSlot = "doc" | "cover";

interface FileType {
  ext: string;
  /** 文件头魔数。 */
  magic: readonly number[];
}
const TYPES: Readonly<Record<string, FileType>> = {
  "application/pdf": { ext: "pdf", magic: [0x25, 0x50, 0x44, 0x46, 0x2d] }, // %PDF-
  "image/jpeg": { ext: "jpg", magic: [0xff, 0xd8, 0xff] },
  "image/png": { ext: "png", magic: [0x89, 0x50, 0x4e, 0x47] },
};
const ALLOWED: Record<UploadSlot, readonly string[]> = {
  doc: ["application/pdf", "image/jpeg", "image/png"],
  cover: ["image/jpeg", "image/png"],
};
export const MAGIC_BYTES_NEEDED = 8;

export const mimeAllowed = (slot: UploadSlot, mime: string): boolean => ALLOWED[slot].includes(mime);
export const extOf = (mime: string): string | undefined => TYPES[mime]?.ext;
export function hasMagic(mime: string, head: Uint8Array): boolean {
  const t = TYPES[mime];
  return t !== undefined && head.length >= t.magic.length && t.magic.every((b, i) => head[i] === b);
}

/** 对象 key 由服务端生成（不含用户输入），ASCII。 */
export const newKey = (slot: UploadSlot, mime: string): string => `${slot}/${randomUUID()}.${extOf(mime)}`;

const KEY_RE: Record<UploadSlot, RegExp> = {
  doc: /^doc\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(pdf|jpg|png)$/,
  cover: /^cover\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png)$/,
};
/** 客户端回传的 key 必须是本服务签发过的形态，不能指向桶里的任意对象。 */
export const keyMatches = (slot: UploadSlot, key: string): boolean => KEY_RE[slot].test(key);
export const keyExt = (key: string): string => key.slice(key.lastIndexOf(".") + 1);

/** 下载文件名：去掉路径与控制字符，保证不为空。 */
export function downloadFileName(title: string, ext: string): string {
  const base = title.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, "_").trim().slice(0, 100) || "course";
  return `${base}.${ext}`;
}
