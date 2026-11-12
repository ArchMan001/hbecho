// 文本归一化 text.normalize（design §7.1）。库内文本与 D 的关键词必须走**同一个**函数，否则大小写、全半角必然漂移。
// 实现按版本保留：升级只新增、不删除旧实现，使 stale 的旧文本能用写入时的版本去归一化关键词（SG-D17）。
import { versionOf } from "../catalog";
import { SignalError } from "../errors";

// 不可见字符：U+200B–U+200F、U+202A–U+202E、U+2060–U+206F、U+FEFF，以及除 \t \n \r 外的 C0/C1 控制字符
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

function normalizeV1(s: string): string {
  // 不可见字符必须在 NFKC 之前删：删在后面会让原本被零宽字符隔开的字符与组合符号相邻，
  // 第二次归一化时才组合（"I\u200B\u0308" 第一次得到 i + U+0308，第二次得到 ï），破坏幂等
  return s
    .replace(INVISIBLE, "")
    .normalize("NFKC") // 全角→半角，兼容字符折叠（Ⅱ → II）
    .toLowerCase()
    .replace(/。/g, ".") // NFKC 不处理的两个 CJK 标点；其余 CJK 标点保持原样
    .replace(/、/g, ",")
    .replace(/\s+/g, " ")
    .trim();
}

export const NORMALIZERS: Readonly<Record<number, (s: string) => string>> = { 1: normalizeV1 };

/** 目录里 text.normalize 的当前版本，即文本类信号信封里 nv 的当前值。 */
export const currentNormalizerVersion = (): number => versionOf("text.normalize");

export function normalizeKeyword(raw: string, version: number = currentNormalizerVersion()): string {
  const f = Object.hasOwn(NORMALIZERS, version) ? NORMALIZERS[version] : undefined;
  if (!f) throw new SignalError("input", "normalizer_unknown", `没有 text.normalize 的第 ${version} 版实现`);
  return f(raw);
}

/** 与 normalizeKeyword 是同一个函数（design §7.1）。 */
export const normalizeText = (s: string, version?: number): string => normalizeKeyword(s, version);
