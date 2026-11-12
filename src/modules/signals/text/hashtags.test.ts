import { describe, expect, it } from "vitest";
import { HASHTAG_PARSERS, MAX_TAGS, extractHashtags, parseTopics, type HashtagParser } from "./hashtags";
import { normalizeText } from "./normalize";

const tags = (title: string | null, body: string | null = null, tagText: string | null = null, platform = "douyin"): string[] => {
  const r = extractHashtags(platform, { title, body, tagText });
  if (!r.ok) throw new Error("解析失败");
  return r.tags;
};

describe("话题解析：design §7.2 样本表", () => {
  it("空格分隔的三个话题（Ⅱ 被 NFKC 折叠，查询侧走同一函数）", () => {
    expect(tags(null, null, "#日立中央空调 #全效Ⅱ三管制 #全屋全感3")).toEqual(["日立中央空调", "全效ii三管制", "全屋全感3"]);
  });
  it("# 相连的两个话题", () => {
    expect(tags("#一键节能更省心#金秋焕新首选")).toEqual(["一键节能更省心", "金秋焕新首选"]);
  });
  it("#xxx[话题]# 写法", () => {
    expect(tags("#来拍照了[话题]#")).toEqual(["来拍照了"]);
    expect(tags("#来拍照了[话题]# #另一个[话题]#")).toEqual(["来拍照了", "另一个"]);
    expect(tags("#来拍照了[话题]#下一个")).toEqual(["来拍照了"]); // 收尾的 # 属于 [话题]，后面不带 # 的文字不是话题
  });
  it("话题到空白为止", () => {
    expect(tags("#日立智墅全感水系统 构建集空调")).toEqual(["日立智墅全感水系统"]);
  });
});

describe("话题解析：等价写法与边界", () => {
  it("＃６１８、#618 、#618[话题]# 抽出同一个值", () => {
    for (const s of ["#618", "＃６１８", "#618 ", "#618[话题]#"]) expect(tags(s), s).toEqual(["618"]);
  });
  it("无空格连写：#日立中央空调品牌月#日立中央空调 抽出两个", () => {
    expect(tags("#日立中央空调品牌月#日立中央空调")).toEqual(["日立中央空调品牌月", "日立中央空调"]);
  });
  it("三段合并后按首次出现顺序去重；NULL 与空串的段跳过", () => {
    expect(tags("#a #b", "正文 #b #c", "#a #d")).toEqual(["a", "b", "c", "d"]);
    expect(tags(null, "", "")).toEqual([]);
  });
  it("大小写与全角在归一化后合并", () => {
    expect(tags("#HITACHI #ｈｉｔａｃｈｉ")).toEqual(["hitachi"]);
  });
  it("空令牌、纯标点令牌被丢弃，首尾标点被去掉", () => {
    expect(tags("# #!!! #。。 #(618)")).toEqual(["618"]);
    expect(tags("#618!")).toEqual(["618"]);
  });
  it("超过 64 字符的令牌丢弃，恰好 64 保留；按字符而不是 UTF-16 单元计", () => {
    expect(tags(`#${"a".repeat(64)} #${"b".repeat(65)}`)).toEqual(["a".repeat(64)]);
    expect(tags(`#${"😀".repeat(64)}`)).toHaveLength(1);
    expect(tags(`#${"😀".repeat(65)}`)).toEqual([]);
  });
  it("每个内容至多 50 个，保留最先出现的", () => {
    const body = Array.from({ length: 80 }, (_, i) => `#t${i}`).join(" ");
    const out = tags(body);
    expect(out).toHaveLength(MAX_TAGS);
    expect(out[0]).toBe("t0");
    expect(out[49]).toBe("t49");
  });
  it("三个平台各有解析器，1.0 行为相同", () => {
    expect(Object.keys(HASHTAG_PARSERS).sort()).toEqual(["douyin", "kuaishou", "xiaohongshu"]);
    for (const p of Object.keys(HASHTAG_PARSERS)) expect(tags("#a #b", null, null, p)).toEqual(["a", "b"]);
  });
  it("parseTopics 幂等于归一化：先归一化再解析与整体结果一致", () => {
    const raw = "＃ＡＢＣ　＃１２３";
    expect(parseTopics(normalizeText(raw))).toEqual(["abc", "123"]);
  });
});

describe("解析器抛错", () => {
  const boom: HashtagParser = () => {
    throw new Error("炸了");
  };
  it("返回结构化失败：片段前 200 字符的 SHA-256 前缀与整段长度，不含原文", () => {
    const secret = "#内部活动名称" + "x".repeat(300);
    const r = extractHashtags("douyin", { title: secret, body: null, tagText: null }, { douyin: boom });
    expect(r).toEqual({ ok: false, code: "text_parse_error", detail: { sha256Prefix: expect.stringMatching(/^[0-9a-f]{16}$/), length: secret.length } });
    expect(JSON.stringify(r)).not.toContain("内部活动名称");
  });
  it("同样的片段得到同样的前缀；前 200 字符之后的差异不影响前缀", () => {
    const a = "a".repeat(200) + "1";
    const b = "a".repeat(200) + "2";
    const p = (t: string) => (extractHashtags("douyin", { title: t, body: null, tagText: null }, { douyin: boom }) as { detail: { sha256Prefix: string } }).detail.sha256Prefix;
    expect(p(a)).toBe(p(b));
  });
  it("没有该平台的解析器也是结构化失败，而不是抛出", () => {
    expect(extractHashtags("weibo", { title: "#a", body: null, tagText: null }).ok).toBe(false);
  });
  it("没有可解析的片段时，坏解析器不会被调用", () => {
    expect(extractHashtags("douyin", { title: null, body: "", tagText: null }, { douyin: boom })).toEqual({ ok: true, tags: [] });
  });
});
