import { describe, expect, it } from "vitest";
import { CATALOG } from "../signals/catalog";
import {
  ConfigError, canonicalize, configSha256, contentRequirementEnabled, accountRequirementEnabled, deriveItems, emptyConfig, incompleteAbilities, invalidationOf, parseConfig, requiredSignals, validateConfig,
  type Config, type ConfigLimits,
} from "./config";

const LIMITS: ConfigLimits = { maxItems: 50, maxKeywordLength: 64 };
const signalsOf = (platform: string): ReadonlySet<string> => new Set(CATALOG.filter((e) => (e.platforms as readonly string[]).includes(platform)).map((e) => e.key));
const base = { window: { from: "2026-11-01", to: "2026-11-30" }, kinds: ["video"] };
const cfg = (over: Record<string, unknown> = {}): Config => parseConfig({ ...base, ...over });
const ab = (o: Record<string, unknown>) => ({ abilityId: "a1", kind: "whole_image", target: "cover", threshold: "6.5", ...o });
const codes = (c: Config, platform = "douyin", complete = true) => validateConfig(c, platform, signalsOf(platform), LIMITS, { complete }).map((i) => i.code);
const failing = (raw: unknown): ConfigError => {
  try {
    parseConfig(raw);
  } catch (e) {
    return e as ConfigError;
  }
  throw new Error("期望 parseConfig 抛错");
};

describe("parseConfig（zod strict）", () => {
  it("空模板合法：只带时间窗与形态，不预置任何能力", () => {
    const c = emptyConfig({ from: "2026-11-01" });
    expect(c.layer1).toEqual({ text: [], hashtags: [] });
    expect(c.layer2.abilities).toEqual([]);
  });
  it("缺窗口起点 / 形态为空 / 日期不存在 / n=0 / bp=10001 / 阈值 10.01 / 关键词空 / standardText 超长，各被拒并指出字段路径", () => {
    expect(failing({ kinds: ["video"] }).issues.map((i) => i.path)).toContain("window");
    expect(failing({ ...base, kinds: [] }).issues[0]!.path).toBe("kinds");
    expect(failing({ ...base, window: { from: "2026-02-30" } }).issues[0]!.path).toBe("window.from");
    expect(failing({ ...base, layer1: { text: [{ fields: ["title"], mode: "any", keywords: ["a"] }], quantity: { n: 0 } } }).issues[0]!.path).toBe("layer1.quantity.n");
    expect(failing({ ...base, layer1: { quantity: { n: 1001 } } }).issues[0]!.path).toBe("layer1.quantity.n");
    expect(failing({ ...base, commentRequirement: { mode: "any", keywords: ["a"], method: { type: "ratio", bp: 10001 } } }).issues[0]!.path).toContain("commentRequirement.method");
    expect(failing({ ...base, layer2: { abilities: [ab({ threshold: "10.01" })] } }).issues[0]!.path).toBe("layer2.abilities.0.threshold");
    expect(failing({ ...base, layer1: { text: [{ fields: ["title"], mode: "any", keywords: [] }] } }).issues[0]!.path).toBe("layer1.text.0.keywords");
    expect(failing({ ...base, contentRequirement: { layer3: { standardText: "x".repeat(2001) } } }).issues[0]!.path).toBe("contentRequirement.layer3.standardText");
    expect(failing({ ...base, layer1: { text: [{ alias: "x".repeat(201), fields: ["title"], mode: "any", keywords: ["a"] }] } }).issues[0]!.path).toBe("layer1.text.0.alias");
  });
  it("没有 regex / 否定 / 播放量 / 发布时段 / 作者为指定账号的字段（strict）", () => {
    for (const extra of [{ regex: "x" }, { negate: true }, { layer1: { playCount: { min: 1 } } }, { layer1: { publishHours: [1, 2] } }, { commentRequirement: { mode: "any", keywords: ["a"], method: { type: "all" }, authorIsAccount: true } }])
      expect(() => parseConfig({ ...base, ...extra }), JSON.stringify(extra)).toThrow(ConfigError);
  });
  it("kind=image_text / OCR → 专门的 2.0 提示（code capability_2_0），不是普通枚举错误", () => {
    const e = failing({ ...base, layer2: { abilities: [ab({ kind: "image_text", target: "cover" })] } });
    expect(e.issues[0]).toMatchObject({ code: "capability_2_0", path: "layer2.abilities.0.kind" });
    expect(e.message).toContain("2.0");
    expect(failing({ ...base, layer2: { abilities: [ab({ kind: "video_understanding" })] } }).issues[0]!.code).toBe("ability_kind_invalid");
  });
  it("ASR 的 layer3.alias 可保存；别名 1–200 字", () => {
    expect(cfg({ contentRequirement: { layer3: { alias: "口播", standardText: "提到海信" } } }).contentRequirement?.layer3?.alias).toBe("口播");
  });
});

describe("内容要求启用规则（D-D21）", () => {
  const text = { text: [{ fields: ["title"], mode: "any", keywords: ["海信"] }] };
  const en = (over: Record<string, unknown>) => contentRequirementEnabled(cfg(over));
  it("只配话题 / 文本 / 时长 / 封面能力 / ASR → 启用", () => {
    expect(en({ layer1: { hashtags: [{ mode: "any", values: ["618"] }] } })).toBe(true);
    expect(en({ layer1: text })).toBe(true);
    expect(en({ layer1: { duration: { minSeconds: 10 } } })).toBe(true);
    expect(en({ layer2: { abilities: [ab({})] } })).toBe(true);
    expect(en({ contentRequirement: { layer3: { standardText: "x" } } })).toBe(true);
  });
  it("只配评论 / 只配头像或背景 / 什么都没配 → 内容要求不启用", () => {
    expect(en({ commentRequirement: { mode: "any", keywords: ["a"], method: { type: "any" } } })).toBe(false);
    expect(en({ layer2: { abilities: [ab({ target: "avatar" })] } })).toBe(false);
    expect(en({ layer2: { abilities: [ab({ target: "background", kind: "image_element", elementKey: "k1" })] } })).toBe(false);
    expect(en({})).toBe(false);
    expect(accountRequirementEnabled(cfg({ layer2: { abilities: [ab({ target: "avatar" })] } }))).toBe(true);
  });
});

describe("validateConfig", () => {
  const text = { text: [{ fields: ["title"], mode: "any", keywords: ["海信"] }] };
  it("什么要求都没有：草稿允许，圈定 / 发布前（complete）被拒", () => {
    expect(codes(cfg({}), "douyin", false)).toEqual([]);
    expect(codes(cfg({}))).toContain("no_requirement");
    expect(codes(cfg({ layer1: text }))).toEqual([]);
  });
  it("quantity 只能与文本 / 话题一起设置（D-D22）；只配时长 + N 被拒；删掉最后一个文本 / 话题项后 N 必须一并去掉", () => {
    expect(codes(cfg({ layer1: { ...text, quantity: { n: 3 } } }))).toEqual([]);
    expect(codes(cfg({ layer1: { duration: { minSeconds: 1 }, quantity: { n: 3 } } }))).toContain("quantity_needs_text_or_hashtag");
    expect(codes(cfg({ layer1: { quantity: { n: 3 } } }), "douyin", false)).toContain("quantity_needs_text_or_hashtag");
  });
  it("时长只在内容形态只选视频时可用；窗口倒置；最短大于最长", () => {
    expect(codes(cfg({ kinds: ["video", "image"], layer1: { ...text, duration: { minSeconds: 1 } } }))).toContain("duration_needs_video");
    expect(codes(cfg({ layer1: { ...text, duration: { minSeconds: 100, maxSeconds: 10 } } }))).toContain("duration_inverted");
    expect(codes(cfg({ window: { from: "2026-11-10", to: "2026-11-01" }, layer1: text }))).toContain("window_inverted");
  });
  it("关键词 / 话题个数与长度上限由调用方给（无代码默认值）", () => {
    const many = { text: [{ fields: ["title"], mode: "any", keywords: Array.from({ length: 51 }, (_, i) => `词${i}`) }] };
    expect(codes(cfg({ layer1: many }))).toContain("too_many_items");
    expect(codes(cfg({ layer1: { text: [{ fields: ["title"], mode: "any", keywords: ["x".repeat(65)] }] } }))).toContain("item_too_long");
    expect(validateConfig(cfg({ layer1: many }), "douyin", signalsOf("douyin"), { maxItems: 100, maxKeywordLength: 64 }, { complete: true })).toEqual([]);
  });
  it("能力唯一性：同 target 两个 whole_image、同 target+elementKey 重复、abilityId 重复；整张图对比不带元素键", () => {
    expect(codes(cfg({ layer2: { abilities: [ab({}), ab({ abilityId: "a2" })] } }))).toContain("whole_image_duplicate");
    const el = (id: string, key: string) => ab({ abilityId: id, kind: "image_element", elementKey: key });
    expect(codes(cfg({ layer2: { abilities: [el("a1", "k1"), el("a2", "k1")] } }))).toContain("element_duplicate");
    expect(codes(cfg({ layer2: { abilities: [el("a1", "k1"), el("a2", "k2")] } }))).toEqual([]);
    expect(codes(cfg({ layer2: { abilities: [ab({}), ab({ target: "avatar" })] } }))).toContain("ability_id_duplicate");
    expect(codes(cfg({ layer2: { abilities: [ab({ elementKey: "k" })] } }))).toContain("element_key_unexpected");
  });
  it("平台可得性（C 的信号目录是唯一真相）：快手不能评论；小红书 / 快手不能账号头像 / 背景；抖音都可以", () => {
    const comment = { commentRequirement: { mode: "any", keywords: ["a"], method: { type: "any" } } };
    expect(codes(cfg(comment), "kuaishou")).toContain("signal_not_available_on_platform");
    expect(codes(cfg(comment), "douyin")).toEqual([]);
    expect(codes(cfg(comment), "xiaohongshu")).toEqual([]);
    for (const platform of ["xiaohongshu", "kuaishou"]) {
      expect(codes(cfg({ layer2: { abilities: [ab({ target: "avatar" })] } }), platform)).toContain("signal_not_available_on_platform");
      expect(codes(cfg({ layer2: { abilities: [ab({ target: "background", kind: "image_element", elementKey: "k" })] } }), platform)).toContain("signal_not_available_on_platform");
    }
    expect(codes(cfg({ layer2: { abilities: [ab({ target: "avatar" })] } }), "douyin")).toEqual([]);
    expect(codes(cfg({ layer2: { abilities: [ab({})] } }), "kuaishou")).toEqual([]); // 封面三平台都可得
  });
});

describe("deriveItems 与 C 目录", () => {
  const rich = cfg({
    layer1: { text: [{ fields: ["title", "body"], mode: "any", keywords: ["a"] }], hashtags: [{ mode: "any", values: ["618"] }, { mode: "all", values: ["海信"] }] },
    layer2: {
      abilities: [
        ab({ abilityId: "a1" }),
        ab({ abilityId: "a2", kind: "image_element", elementKey: "k1" }),
        ab({ abilityId: "a3", kind: "image_element", elementKey: "k2" }),
        ab({ abilityId: "a4", target: "avatar" }),
        ab({ abilityId: "a5", target: "background", kind: "image_element", elementKey: "k3" }),
      ],
    },
    commentRequirement: { mode: "any", keywords: ["安装"], method: { type: "any" } },
    contentRequirement: { layer3: { standardText: "口播提到海信" } },
  });
  it("配置里的每一项都映射成信号；去重；元素图带 element_key；ASR 带标准文本", () => {
    expect(deriveItems(rich)).toEqual([
      { signal: "text.title_normalized" },
      { signal: "text.body_normalized" },
      { signal: "text.hashtags" },
      { signal: "comment.text_normalized" },
      { signal: "content.cover_template_score" },
      { signal: "content.cover_element_score", element_key: "k1" },
      { signal: "content.cover_element_score", element_key: "k2" },
      { signal: "account.avatar_template_score" },
      { signal: "account.bg_element_score", element_key: "k3" },
      { signal: "content.asr_judgement", standard_text: "口播提到海信" },
    ]);
  });
  it("推导出的信号都在目录的平台可得集合里（抖音全集）", () => {
    const set = signalsOf("douyin");
    for (const it of deriveItems(rich)) expect(set.has(it.signal), it.signal).toBe(true);
    for (const s of requiredSignals(rich)) expect(set.has(s), s).toBe(true);
  });
  it("元素图能力还没上传（缺 elementKey）→ 不产出条目，并列入未完成清单", () => {
    const c = cfg({ layer2: { abilities: [ab({ kind: "image_element" })] } });
    expect(deriveItems(c)).toEqual([]);
    expect(incompleteAbilities(c)).toHaveLength(1);
    expect(requiredSignals(c).has("content.cover_element_score")).toBe(true);
  });
});

describe("规范化与 config_sha256", () => {
  const raw = (over: Record<string, unknown> = {}) => ({ ...base, layer1: { text: [{ fields: ["title"], mode: "any", keywords: ["海信"] }], quantity: { n: 3 } }, ...over });
  it("键序不同的两次序列化哈希相同；阈值 \"8\" 与 \"8.00\" 相同", () => {
    const a = parseConfig({ window: { from: "2026-11-01", to: "2026-11-30" }, kinds: ["video"], layer2: { abilities: [ab({ threshold: "8" })] } });
    const b = parseConfig({ layer2: { abilities: [{ target: "cover", threshold: "8.00", kind: "whole_image", abilityId: "a1" }] }, kinds: ["video"], window: { to: "2026-11-30", from: "2026-11-01" } });
    expect(configSha256(a).equals(configSha256(b))).toBe(true);
  });
  it("只改能力别名（含 ASR）与 abilityId：哈希不变；改 N、改关键词、改阈值：哈希必变", () => {
    const h = (c: Config) => configSha256(c).toString("hex");
    const x = cfg({ ...raw(), layer2: { abilities: [ab({})] }, contentRequirement: { layer3: { standardText: "t" } } });
    const aliased = cfg({
      ...raw(), layer1: { text: [{ alias: "主推文本", fields: ["title"], mode: "any", keywords: ["海信"] }], quantity: { n: 3 } },
      layer2: { abilities: [ab({ alias: "封面", abilityId: "zzz" })] }, contentRequirement: { layer3: { alias: "口播", standardText: "t" } },
    });
    expect(h(aliased)).toBe(h(x));
    expect(h(cfg({ ...raw({ layer1: { text: [{ fields: ["title"], mode: "any", keywords: ["海信"] }], quantity: { n: 4 } } }), layer2: { abilities: [ab({})] }, contentRequirement: { layer3: { standardText: "t" } } }))).not.toBe(h(x));
    expect(h(cfg({ ...raw(), layer2: { abilities: [ab({ threshold: "6.51" })] }, contentRequirement: { layer3: { standardText: "t" } } }))).not.toBe(h(x));
    expect(h(cfg({ ...raw({ layer1: { text: [{ fields: ["title"], mode: "any", keywords: ["海信", "x"] }], quantity: { n: 3 } } }), layer2: { abilities: [ab({})] }, contentRequirement: { layer3: { standardText: "t" } } }))).not.toBe(h(x));
  });
  it("关键词顺序敏感（重排被当作配置变化）；保存的是原文，不归一化", () => {
    const k = (kw: string[]) => configSha256(cfg({ layer1: { text: [{ fields: ["title"], mode: "any", keywords: kw }] } })).toString("hex");
    expect(k(["a", "b"])).not.toBe(k(["b", "a"]));
    expect(cfg({ layer1: { text: [{ fields: ["title"], mode: "any", keywords: ["Hi-SENSE"] }] } }).layer1.text[0]!.keywords).toEqual(["Hi-SENSE"]);
  });
  it("规范化结果里没有别名与 abilityId", () => {
    const s = JSON.stringify(canonicalize(cfg({ ...raw(), layer2: { abilities: [ab({ alias: "封面" })] } })));
    expect(s).not.toContain("封面");
    expect(s).not.toContain("abilityId");
  });
});

describe("失效矩阵（design §7.9）", () => {
  const text = (kw: string[], n?: number) => ({ text: [{ fields: ["title"], mode: "any", keywords: kw }], ...(n ? { quantity: { n } } : {}) });
  const el = ab({ kind: "image_element", elementKey: "k1" });
  const c0 = cfg({ layer1: text(["a"], 3), layer2: { abilities: [ab({ threshold: "6.5" })] }, commentRequirement: { mode: "any", keywords: ["x"], method: { type: "any" } } });
  it("窗口 / 形态 / 第 1 层（含 N）→ 圈定与试跑都删", () => {
    expect(invalidationOf(c0, cfg({ layer1: text(["a", "b"], 3), layer2: c0.layer2, commentRequirement: c0.commentRequirement }))).toBe("circle_and_trial");
    expect(invalidationOf(c0, cfg({ layer1: text(["a"], 4), layer2: c0.layer2, commentRequirement: c0.commentRequirement }))).toBe("circle_and_trial");
    expect(invalidationOf(c0, cfg({ window: { from: "2026-11-02" }, layer1: text(["a"], 3), layer2: c0.layer2 }))).toBe("circle_and_trial");
    expect(invalidationOf(c0, cfg({ layer1: { text: [] }, layer2: c0.layer2 }))).toBe("circle_and_trial"); // 删掉最后一个文本项（连同 N）
  });
  it("第 2 层能力结构（增删、kind / target / elementKey）→ 只删试跑", () => {
    const l1 = { layer1: text(["a"], 3), commentRequirement: c0.commentRequirement };
    expect(invalidationOf(c0, cfg({ ...l1, layer2: { abilities: [ab({}), el] } }))).toBe("trial");
    expect(invalidationOf(c0, cfg({ ...l1, layer2: { abilities: [] } }))).toBe("trial");
    expect(invalidationOf(c0, cfg({ ...l1, layer2: { abilities: [ab({ target: "avatar" })] } }))).toBe("trial");
  });
  it("阈值、别名、abilityId、评论达标方式、评论要求、ASR → 不失效", () => {
    const keep = (over: Record<string, unknown>) => invalidationOf(c0, cfg({ layer1: text(["a"], 3), layer2: c0.layer2, commentRequirement: c0.commentRequirement, ...over }));
    expect(keep({ layer2: { abilities: [ab({ threshold: "9" })] } })).toBe("none");
    expect(keep({ layer2: { abilities: [ab({ alias: "新名", abilityId: "zz" })] } })).toBe("none");
    expect(keep({ commentRequirement: { mode: "all", keywords: ["y"], method: { type: "ratio", bp: 5000 } } })).toBe("none");
    expect(keep({ contentRequirement: { layer3: { standardText: "t" } } })).toBe("none");
  });
});

describe("conditionsOf：每个可展示条件的清单与稳定 key（e-metrics-lite JP-22）", () => {
  it("层序：第 1 层按「文本 → 话题 → 时长」展平编号，第 2 层按配置顺序（封面 / 头像 / 背景混排），再第 3 层、评论", async () => {
    const { conditionsOf, parseConfig } = await import("./config");
    const c = parseConfig({
      window: { from: "2026-11-01" }, kinds: ["video"],
      layer1: { text: [{ alias: "品牌词", fields: ["title"], mode: "any", keywords: ["a"] }, { fields: ["title"], mode: "any", keywords: ["b"] }], hashtags: [{ mode: "any", values: ["#x"] }], duration: { minSeconds: 5 } },
      layer2: { abilities: [
        { abilityId: "c1", alias: "封面模板", kind: "whole_image", target: "cover", threshold: "6" },
        { abilityId: "av", kind: "whole_image", target: "avatar", threshold: "6" },
        { abilityId: "c2", kind: "image_element", target: "cover", threshold: "6", elementKey: "k1" },
        { abilityId: "bg", kind: "image_element", target: "background", threshold: "6", elementKey: "k2" },
      ] },
      contentRequirement: { layer3: { alias: "语音", standardText: "t" } },
      commentRequirement: { mode: "any", keywords: ["k"], method: { type: "any" } },
    });
    expect(conditionsOf(c).map((x) => [x.key, x.subject, x.alias])).toEqual([
      ["l1.0", "content", "品牌词"], ["l1.1", "content", null], ["l1.2", "content", null], ["l1.3", "content", null],
      ["l2.c1", "content", "封面模板"], ["l2.av", "account", null], ["l2.c2", "content", null], ["l2.bg", "account", null],
      ["l3", "content", "语音"], ["comment", "content", null],
    ]);
    expect(conditionsOf(c).slice(0, 4).map((x) => x.kind)).toEqual(["text", "text", "hashtags", "duration"]);
  });
  it("空配置只有配置里有的条件；没有第 3 层 / 评论就没有对应项", async () => {
    const { conditionsOf, parseConfig } = await import("./config");
    expect(conditionsOf(parseConfig({ window: { from: "2026-11-01" }, kinds: ["video"] }))).toEqual([]);
  });
});
