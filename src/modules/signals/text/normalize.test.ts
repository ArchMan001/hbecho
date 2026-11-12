import { describe, expect, it } from "vitest";
import { CAPABILITY_VERSIONS } from "../catalog";
import { NORMALIZERS, currentNormalizerVersion, normalizeKeyword, normalizeText } from "./normalize";

describe("normalizeText（text.normalize@1）", () => {
  it("全角转半角、英文转小写、全角空格折叠：ＨＩＴＡＣＨＩ　空调 → hitachi 空调", () => {
    expect(normalizeText("ＨＩＴＡＣＨＩ　空调")).toBe("hitachi 空调");
  });
  it("兼容字符折叠：Ⅱ → ii；＃６１８ → #618", () => {
    expect(normalizeText("全效Ⅱ三管制")).toBe("全效ii三管制");
    expect(normalizeText("＃６１８")).toBe("#618");
  });
  it("零宽字符与控制字符被删，emoji 保留", () => {
    expect(normalizeText("a\u200Bb\u200Fc\u202Ad\u2060e\uFEFFf\u0000g\u0085h\u007Fi")).toBe("abcdefghi");
    expect(normalizeText("好😀用👍")).toBe("好😀用👍");
  });
  it("两个 CJK 标点映射（。→ . 、→ ,），其余 CJK 标点保持原样", () => {
    expect(normalizeText("一。二、三，四！")).toBe("一.二,三,四!"); // ， ！ 由 NFKC 转 ASCII
    expect(normalizeText("「引号」《书名》")).toBe("「引号」《书名》");
  });
  it("连续空白（含换行、制表）折叠为一个空格并去首尾", () => {
    expect(normalizeText("  a \n\t b\r\n\r\n c  ")).toBe("a b c");
    expect(normalizeText("   ")).toBe("");
  });
  it("normalizeKeyword 与 normalizeText 是同一个函数", () => {
    for (const s of ["ＨＩＴＡＣＨＩ", "#６１８", "a　b"]) expect(normalizeKeyword(s)).toBe(normalizeText(s));
  });

  it("零宽字符隔开的组合符号：先删不可见字符再 NFKC，结果稳定", () => {
    expect(normalizeText("I\u200B\u0308")).toBe("ï");
    expect(normalizeText(normalizeText("I\u200B\u0308"))).toBe("ï");
  });
  it("幂等：f(f(x)) === f(x)（固定种子的随机串，覆盖会在删除后重新拼成组合序列的字符）", () => {
    const pool = ["A", "ｂ", "Ⅱ", " ", "　", "\u200B", "\u0301", "\u0308", "。", "、", "＃", "#", "\n", "\t", "😀", "İ", "ß", "ǅ", "\uFEFF", "\u0085", "[", "]", "话题", "1", "１", "ﬁ", "㎏", "e", "\u0000"];
    let seed = 20261112;
    const rand = () => ((seed = (seed + 0x6d2b79f5) | 0), (Math.imul(seed ^ (seed >>> 15), 1 | seed) ^ ((seed >>> 7) * 1)) >>> 0) / 2 ** 32;
    for (let i = 0; i < 5000; i++) {
      const s = Array.from({ length: 1 + Math.floor(rand() * 12) }, () => pool[Math.floor(rand() * pool.length)]!).join("");
      const once = normalizeText(s);
      expect(normalizeText(once), JSON.stringify(s)).toBe(once);
    }
  });
});

describe("按版本保留实现（SG-D17）", () => {
  it("每个已存储的 nv（1..当前版本）都在 NORMALIZERS 里：升级只新增、不删除", () => {
    const current = currentNormalizerVersion();
    expect(current).toBe(CAPABILITY_VERSIONS["text.normalize"]);
    for (let v = 1; v <= current; v++) expect(NORMALIZERS[v], `版本 ${v}`).toBeTypeOf("function");
  });
  it("normalizeKeyword(raw, 旧版本) 与按该版本写入的文本同口径；不存在的版本报错", () => {
    expect(normalizeKeyword("ＨＩＴＡＣＨＩ", 1)).toBe(NORMALIZERS[1]!("ＨＩＴＡＣＨＩ"));
    for (const v of [0, 99, -1]) expect(() => normalizeKeyword("x", v)).toThrowError(expect.objectContaining({ code: "normalizer_unknown" }));
  });
});
