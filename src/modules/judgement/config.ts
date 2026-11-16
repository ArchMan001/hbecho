// 判定段配置（requirements JP-2 / JP-2a、design §6.3 / §7.1）：zod strict schema、语义校验、规范化与哈希、推导 C 监控段的 items。
// 没有任何「默认值」类的数值：关键词个数 / 长度上限由调用方（环境变量，JP-19）传入。
import { z } from "zod";
import { jcsSha256, type JcsValue } from "../canonical-json";
import { bjtDayStartUtc } from "./engine/pure/window";
import { thresholdToCents, centsToText } from "./engine/pure/conditions";

export const CONFIG_SCHEMA_VERSION = 1;
export const QUANTITY_MIN = 1;
export const QUANTITY_MAX = 1000;
const ALIAS_MAX = 200;
const STANDARD_TEXT_MAX = 2000;
const ELEMENT_KEY_RE = /^[A-Za-z0-9_.-]{1,64}$/;

const dayText = z.string().refine((s) => {
  try {
    bjtDayStartUtc(s);
    return true;
  } catch {
    return false;
  }
}, "日期必须是真实存在的 YYYY-MM-DD");
const alias = z.string().trim().min(1).max(ALIAS_MAX).optional();
const mode = z.enum(["all", "any"]);
const nonEmptyText = z.string().trim().min(1);
const thresholdText = z.string().refine((s) => {
  try {
    thresholdToCents(s);
    return true;
  } catch {
    return false;
  }
}, "阈值必须是 0.00–10.00，最多两位小数");

export const methodSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("at_least_n"), n: z.number().int().min(1) }),
  z.strictObject({ type: z.literal("all") }),
  z.strictObject({ type: z.literal("any") }),
  z.strictObject({ type: z.literal("ratio"), bp: z.number().int().min(1).max(10000) }),
]);

const textItem = z.strictObject({ alias, fields: z.array(z.enum(["title", "body"])).min(1), mode, keywords: z.array(nonEmptyText).min(1) });
const hashtagItem = z.strictObject({ alias, mode, values: z.array(nonEmptyText).min(1) });
const durationItem = z.strictObject({ alias, minSeconds: z.number().int().min(0).optional(), maxSeconds: z.number().int().min(0).optional() }).refine(
  (d) => d.minSeconds !== undefined || d.maxSeconds !== undefined,
  "时长至少给最短或最长",
);
const ability = z.strictObject({
  abilityId: z.string().min(1).max(64),
  alias,
  // 图片文字对比（OCR）是 2.0：不是枚举外的普通错误，要给出专门提示（见 parseConfig 的 issue 映射）
  kind: z.string().superRefine((k, ctx) => {
    if (k === "image_text") ctx.addIssue({ code: "custom", message: "图片文字对比（OCR）是 2.0 能力，1.0 不启用", params: { code: "capability_2_0" } });
    else if (k !== "whole_image" && k !== "image_element") ctx.addIssue({ code: "custom", message: "能力类型只有整张图片对比或图片元素对比", params: { code: "ability_kind_invalid" } });
  }),
  target: z.enum(["avatar", "cover", "background"]),
  threshold: thresholdText,
  // 上传元素图时由 D 写入（字节 SHA-256 十六进制）；草稿里可暂缺，发布前必须有
  elementKey: z.string().regex(ELEMENT_KEY_RE).refine((v) => v !== "." && v !== "..").optional(),
});

export const configSchema = z.strictObject({
  window: z.strictObject({ from: dayText, to: dayText.optional() }),
  kinds: z.array(z.enum(["video", "image"])).min(1),
  layer1: z
    .strictObject({
      text: z.array(textItem).default([]),
      hashtags: z.array(hashtagItem).default([]),
      duration: durationItem.optional(),
      quantity: z.strictObject({ n: z.number().int().min(QUANTITY_MIN).max(QUANTITY_MAX) }).optional(),
    })
    .default({ text: [], hashtags: [] }),
  layer2: z.strictObject({ abilities: z.array(ability).default([]) }).default({ abilities: [] }),
  contentRequirement: z.strictObject({ layer3: z.strictObject({ alias, standardText: z.string().trim().min(1).max(STANDARD_TEXT_MAX) }).optional() }).optional(),
  commentRequirement: z.strictObject({ alias, mode, keywords: z.array(nonEmptyText).min(1), method: methodSchema }).optional(),
});
export type Config = z.infer<typeof configSchema>;
export type Ability = Config["layer2"]["abilities"][number];

export interface ConfigIssue {
  path: string;
  code: string;
  message: string;
}
export class ConfigError extends Error {
  constructor(readonly issues: readonly ConfigIssue[]) {
    super(issues.map((i) => `${i.path || "(root)"}: ${i.message}`).join("；"));
  }
}

/** 结构校验（zod strict）。不认识的字段（regex、否定、播放量、发布时段、作者为指定账号）一律被拒。 */
export function parseConfig(raw: unknown): Config {
  const r = configSchema.safeParse(raw);
  if (r.success) return r.data;
  throw new ConfigError(
    r.error.issues.map((i) => {
      const params = (i as { params?: { code?: string } }).params;
      return { path: i.path.join("."), code: params?.code ?? i.code, message: i.message };
    }),
  );
}

// ---- 要求是否启用 --------------------------------------------------------------------------------------------

/** 内容要求启用规则（D-D21）：任一成立即启用。唯一判定入口，圈定 / 试跑 / 执行 / 页面共用。 */
export function contentRequirementEnabled(cfg: Config): boolean {
  return (
    cfg.layer1.text.length > 0 ||
    cfg.layer1.hashtags.length > 0 ||
    cfg.layer1.duration !== undefined ||
    cfg.layer1.quantity !== undefined ||
    cfg.layer2.abilities.some((a) => a.target === "cover") ||
    cfg.contentRequirement?.layer3 !== undefined
  );
}
export const commentRequirementEnabled = (cfg: Config): boolean => cfg.commentRequirement !== undefined;
/** 账号要求 = 头像 / 主页背景能力。 */
export const accountAbilities = (cfg: Config): Ability[] => cfg.layer2.abilities.filter((a) => a.target === "avatar" || a.target === "background");
export const contentAbilities = (cfg: Config): Ability[] => cfg.layer2.abilities.filter((a) => a.target === "cover");
export const accountRequirementEnabled = (cfg: Config): boolean => accountAbilities(cfg).length > 0;
/** 内容达标门槛：at_least_n，N = quantity ?? 1。 */
export const contentThresholdN = (cfg: Config): number => cfg.layer1.quantity?.n ?? 1;

// ---- 推导 C 监控段的信号集合 ---------------------------------------------------------------------------------

export interface SegmentItem {
  signal: string;
  element_key?: string;
  standard_text?: string;
}
const SCORE_SIGNAL: Record<Ability["kind"] & string, Record<Ability["target"], string>> = {
  whole_image: { cover: "content.cover_template_score", avatar: "account.avatar_template_score", background: "account.bg_template_score" },
  image_element: { cover: "content.cover_element_score", avatar: "account.avatar_element_score", background: "account.bg_element_score" },
};
const scoreSignalOf = (a: Ability): string => SCORE_SIGNAL[a.kind]![a.target];

/** 配置用到的信号键（不含 element_key；用于平台可得性校验）。 */
export function requiredSignals(cfg: Config): Set<string> {
  const out = new Set<string>();
  for (const t of cfg.layer1.text) for (const f of t.fields) out.add(f === "title" ? "text.title_normalized" : "text.body_normalized");
  if (cfg.layer1.hashtags.length > 0) out.add("text.hashtags");
  for (const a of cfg.layer2.abilities) out.add(scoreSignalOf(a));
  if (cfg.commentRequirement) out.add("comment.text_normalized");
  if (cfg.contentRequirement?.layer3) out.add("content.asr_judgement");
  return out;
}

/** 推导 C 的 items：业务不直接填信号键。元素图能力缺 elementKey（草稿未上传）时不产出该条目。 */
export function deriveItems(cfg: Config): SegmentItem[] {
  const items: SegmentItem[] = [];
  const seen = new Set<string>();
  const push = (it: SegmentItem) => {
    const k = `${it.signal}|${it.element_key ?? ""}`;
    if (!seen.has(k)) {
      seen.add(k);
      items.push(it);
    }
  };
  for (const s of requiredSignals(cfg)) {
    if (s.startsWith("text.") || s.startsWith("comment.")) push({ signal: s });
  }
  for (const a of cfg.layer2.abilities) {
    if (a.kind === "image_element") {
      if (a.elementKey !== undefined) push({ signal: scoreSignalOf(a), element_key: a.elementKey });
    } else push({ signal: scoreSignalOf(a) });
  }
  if (cfg.contentRequirement?.layer3) push({ signal: "content.asr_judgement", standard_text: cfg.contentRequirement.layer3.standardText });
  return items;
}

/** 草稿里还没上传元素图的能力（发布前必须为空）。 */
export const incompleteAbilities = (cfg: Config): Ability[] => cfg.layer2.abilities.filter((a) => a.kind === "image_element" && a.elementKey === undefined);

// ---- 语义校验 ------------------------------------------------------------------------------------------------

export interface ConfigLimits {
  maxItems: number;
  maxKeywordLength: number;
}
export type Platform = "douyin" | "xiaohongshu" | "kuaishou";

/** 语义校验（zod 之外）：返回全部问题，不在第一条就停。`complete` = 即将圈定 / 试跑 / 发布。 */
export function validateConfig(cfg: Config, platform: string, platformSignals: ReadonlySet<string>, limits: ConfigLimits, opts: { complete: boolean } = { complete: false }): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const bad = (path: string, code: string, message: string) => issues.push({ path, code, message });

  if (new Set(cfg.kinds).size !== cfg.kinds.length) bad("kinds", "kinds_duplicate", "内容形态不能重复");
  if (cfg.window.to !== undefined && cfg.window.to < cfg.window.from) bad("window.to", "window_inverted", "结束日期不能早于开始日期");
  const videoOnly = cfg.kinds.length === 1 && cfg.kinds[0] === "video";
  if (cfg.layer1.duration && !videoOnly) bad("layer1.duration", "duration_needs_video", "视频时长条件只在内容形态只选视频时可用");
  const d = cfg.layer1.duration;
  if (d && d.minSeconds !== undefined && d.maxSeconds !== undefined && d.minSeconds > d.maxSeconds) bad("layer1.duration", "duration_inverted", "最短时长不能大于最长时长");

  // 数量要求只依附文本 / 话题能力（D-D22）
  if (cfg.layer1.quantity && cfg.layer1.text.length === 0 && cfg.layer1.hashtags.length === 0) bad("layer1.quantity", "quantity_needs_text_or_hashtag", "数量要求只能与文本或话题能力一起设置");

  const lists: Array<[string, readonly string[]]> = [
    ...cfg.layer1.text.map((t, i): [string, readonly string[]] => [`layer1.text.${i}.keywords`, t.keywords]),
    ...cfg.layer1.hashtags.map((t, i): [string, readonly string[]] => [`layer1.hashtags.${i}.values`, t.values]),
    ...(cfg.commentRequirement ? ([["commentRequirement.keywords", cfg.commentRequirement.keywords]] as Array<[string, readonly string[]]>) : []),
  ];
  for (const [path, xs] of lists) {
    if (xs.length > limits.maxItems) bad(path, "too_many_items", `最多 ${limits.maxItems} 个`);
    xs.forEach((x, i) => {
      if ([...x].length > limits.maxKeywordLength) bad(`${path}.${i}`, "item_too_long", `单个最多 ${limits.maxKeywordLength} 个字符`);
    });
  }

  // 能力唯一性
  const wholeSeen = new Set<string>();
  const elemSeen = new Set<string>();
  const idSeen = new Set<string>();
  cfg.layer2.abilities.forEach((a, i) => {
    const p = `layer2.abilities.${i}`;
    if (idSeen.has(a.abilityId)) bad(`${p}.abilityId`, "ability_id_duplicate", "abilityId 重复");
    idSeen.add(a.abilityId);
    if (a.kind === "whole_image") {
      if (a.elementKey !== undefined) bad(`${p}.elementKey`, "element_key_unexpected", "整张图片对比不带元素键");
      if (wholeSeen.has(a.target)) bad(p, "whole_image_duplicate", "同一对比元素只能有一个整张图片对比");
      wholeSeen.add(a.target);
    } else if (a.elementKey !== undefined) {
      const k = `${a.target}|${a.elementKey}`;
      if (elemSeen.has(k)) bad(`${p}.elementKey`, "element_duplicate", "这张图已经作为元素上传");
      elemSeen.add(k);
    }
  });

  // 至少启用一类要求：草稿编辑中途（刚建好、刚删掉最后一个能力）允许为空，圈定 / 试跑 / 发布前（complete）必须满足
  if (opts.complete && !contentRequirementEnabled(cfg) && !commentRequirementEnabled(cfg) && !accountRequirementEnabled(cfg)) bad("", "no_requirement", "至少要配置内容、评论或账号中的一类要求");

  // 平台可得性：信号目录（C）是唯一真相，D 不写平台常量
  for (const s of [...requiredSignals(cfg)].sort()) if (!platformSignals.has(s)) bad("", "signal_not_available_on_platform", `${platform} 上不可用：${s}`);
  return issues;
}

// ---- 规范化与哈希 --------------------------------------------------------------------------------------------

/**
 * 规范化：阈值统一两位小数；能力别名与 abilityId 剔除（D-D20：别名只影响显示，不参与判定配置哈希）。
 * 数组保持保存时的顺序，所以重排关键词会被当作配置变化。
 */
export function canonicalize(cfg: Config): JcsValue {
  const dropAlias = <T extends { alias?: string | undefined }>(o: T): Omit<T, "alias"> => {
    const { alias: _a, ...rest } = o;
    return rest;
  };
  const out = {
    window: cfg.window,
    kinds: cfg.kinds,
    layer1: {
      text: cfg.layer1.text.map(dropAlias),
      hashtags: cfg.layer1.hashtags.map(dropAlias),
      ...(cfg.layer1.duration ? { duration: dropAlias(cfg.layer1.duration) } : {}),
      ...(cfg.layer1.quantity ? { quantity: cfg.layer1.quantity } : {}),
    },
    layer2: {
      abilities: cfg.layer2.abilities.map((a) => {
        const { alias: _a, abilityId: _id, ...rest } = a;
        return { ...rest, threshold: centsToText(thresholdToCents(a.threshold)) };
      }),
    },
    ...(cfg.contentRequirement ? { contentRequirement: { ...(cfg.contentRequirement.layer3 ? { layer3: dropAlias(cfg.contentRequirement.layer3) } : {}) } } : {}),
    ...(cfg.commentRequirement ? { commentRequirement: dropAlias(cfg.commentRequirement) } : {}),
  };
  // JSON 往返：去掉 undefined 键，保证与 jcs 的取值域一致
  return JSON.parse(JSON.stringify(out)) as JcsValue;
}
export const configSha256 = (cfg: Config): Buffer => jcsSha256(canonicalize(cfg));

/** 空模板：新建判定计划时只带必选的时间窗与内容形态，不预置任何可选能力。 */
export function emptyConfig(window: { from: string; to?: string }): Config {
  return parseConfig({ window, kinds: ["video", "image"] });
}

// ---- 失效矩阵（design §7.9）---------------------------------------------------------------------------------

export type Invalidation = "none" | "trial" | "circle_and_trial";
/** 草稿上改配置时：圈定 / 试跑结果哪些要删。别名、阈值、评论达标方式、评论要求、ASR 不使任何结果失效。 */
export function invalidationOf(before: Config, after: Config): Invalidation {
  const j = (x: unknown) => JSON.stringify(x);
  const circleKey = (c: Config) => j({ w: c.window, k: c.kinds, l1: (canonicalize(c) as { layer1: unknown }).layer1 });
  if (circleKey(before) !== circleKey(after)) return "circle_and_trial";
  // 第 2 层结构：增删能力、改 kind / target / elementKey（不含阈值、别名、abilityId）
  const shape = (c: Config) => j(c.layer2.abilities.map((a) => [a.kind, a.target, a.elementKey ?? null]));
  return shape(before) !== shape(after) ? "trial" : "none";
}
