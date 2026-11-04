import { createHash } from "node:crypto";

/** 文本的 UTF-8 字节的 SHA-256（BINARY(32) 摘要列）。不做任何归一化。 */
export const sha256Utf8 = (text: string): Buffer => createHash("sha256").update(text, "utf8").digest();
