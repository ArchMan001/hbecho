// 向导里的配置编辑：纯函数，浏览器与服务端都能用（只 import 类型，不带 node 依赖）。
// 这里只做「把界面操作变成新的配置对象」；结构与语义校验在服务端 setConfig 里做，页面把它的拒绝原样显示。
import type { Ability, Config } from "../../modules/judgement/config";

export type TextItem = Config["layer1"]["text"][number];
export type HashtagItem = Config["layer1"]["hashtags"][number];
export type Duration = NonNullable<Config["layer1"]["duration"]>;
export type CommentReq = NonNullable<Config["commentRequirement"]>;
export type Method = CommentReq["method"];

/** 阈值文字：0–10，最多两位小数（与服务端 thresholdToCents 同一口径的前置检查，只用于不发明显错误的请求）。 */
export const isThresholdText = (s: string): boolean => /^(10(\.0{1,2})?|[0-9](\.\d{1,2})?)$/.test(s);
export const thresholdText = (n: number): string => (Math.min(10, Math.max(0, Math.round(n * 100) / 100))).toFixed(2);

/** 别名：空白 = 不设；不能把 undefined 写进可选字段（exactOptionalPropertyTypes）。 */
function withAlias<T extends { alias?: string | undefined }>(item: T, v: string): T {
  const { alias: _drop, ...rest } = item;
  const a = v.trim();
  return (a ? { ...rest, alias: a } : rest) as T;
}
const replaceAt = <T>(xs: readonly T[], i: number, f: (x: T) => T): T[] => xs.map((x, k) => (k === i ? f(x) : x));

// ---- 窗口与形态 ----
export const setWindow = (c: Config, bound: "from" | "to", v: string): Config => {
  if (bound === "from") return { ...c, window: { ...c.window, from: v } };
  const { to: _to, ...rest } = c.window;
  return { ...c, window: v ? { ...rest, to: v } : rest };
};
export const toggleKind = (c: Config, kind: "video" | "image", on: boolean): Config => {
  const has = c.kinds.includes(kind);
  if (on === has) return c;
  const kinds = on ? [...c.kinds, kind] : c.kinds.filter((k) => k !== kind);
  return kinds.length === 0 ? c : { ...c, kinds };
};

// ---- 第 1 层 ----
/** D-D22：数量要求只依附文本 / 话题卡片；删掉最后一张时同一次保存里清掉，不弹提示。 */
function normalizeQuantity(c: Config): Config {
  if (c.layer1.text.length + c.layer1.hashtags.length > 0 || c.layer1.quantity === undefined) return c;
  const { quantity: _q, ...rest } = c.layer1;
  return { ...c, layer1: rest };
}
export const addText = (c: Config): Config => ({ ...c, layer1: { ...c.layer1, text: [...c.layer1.text, { fields: ["title", "body"], mode: "any", keywords: [] }] } });
export const addHashtag = (c: Config): Config => ({ ...c, layer1: { ...c.layer1, hashtags: [...c.layer1.hashtags, { mode: "any", values: [] }] } });
export const addDuration = (c: Config): Config => (c.layer1.duration ? c : { ...c, layer1: { ...c.layer1, duration: { minSeconds: 15 } } });
export const removeText = (c: Config, i: number): Config => normalizeQuantity({ ...c, layer1: { ...c.layer1, text: c.layer1.text.filter((_, k) => k !== i) } });
export const removeHashtag = (c: Config, i: number): Config => normalizeQuantity({ ...c, layer1: { ...c.layer1, hashtags: c.layer1.hashtags.filter((_, k) => k !== i) } });
export const removeDuration = (c: Config): Config => {
  const { duration: _d, ...rest } = c.layer1;
  return { ...c, layer1: rest };
};
export const patchText = (c: Config, i: number, f: (t: TextItem) => TextItem): Config => ({ ...c, layer1: { ...c.layer1, text: replaceAt(c.layer1.text, i, f) } });
export const patchHashtag = (c: Config, i: number, f: (t: HashtagItem) => HashtagItem): Config => ({ ...c, layer1: { ...c.layer1, hashtags: replaceAt(c.layer1.hashtags, i, f) } });
export const patchDuration = (c: Config, f: (d: Duration) => Duration): Config => (c.layer1.duration ? { ...c, layer1: { ...c.layer1, duration: f(c.layer1.duration) } } : c);
export const setQuantity = (c: Config, n: number | undefined): Config => {
  const { quantity: _q, ...rest } = c.layer1;
  return { ...c, layer1: n === undefined ? rest : { ...rest, quantity: { n } } };
};
export const setDurationBound = (d: Duration, bound: "minSeconds" | "maxSeconds", v: string): Duration => {
  const { [bound]: _b, ...rest } = d;
  const n = v.trim() === "" ? undefined : Math.max(0, Math.floor(Number(v)));
  return (n === undefined || !Number.isFinite(n) ? rest : { ...rest, [bound]: n }) as Duration;
};
export const aliasOf = withAlias;
export const addKeyword = (words: readonly string[], v: string): string[] => {
  const w = v.trim();
  return w && !words.includes(w) ? [...words, w] : [...words];
};

// ---- 第 2 层 ----
let seq = 0;
const newAbilityId = (): string => `a-${typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}${(seq++).toString(36)}`}`;
export const addAbility = (c: Config, kind: "whole_image" | "image_element"): Config => ({ ...c, layer2: { abilities: [...c.layer2.abilities, { abilityId: newAbilityId(), kind, target: "cover", threshold: "6.50" }] } });
export const removeAbility = (c: Config, id: string): Config => ({ ...c, layer2: { abilities: c.layer2.abilities.filter((a) => a.abilityId !== id) } });
export const patchAbility = (c: Config, id: string, f: (a: Ability) => Ability): Config => ({ ...c, layer2: { abilities: c.layer2.abilities.map((a) => (a.abilityId === id ? f(a) : a)) } });
export const setTarget = (a: Ability, target: Ability["target"]): Ability => {
  const { elementKey: _k, ...rest } = a; // 换对比元素后素材要重新上传（服务端也会清掉）
  return { ...rest, target };
};

// ---- 第 3 层 ----
export const addAsr = (c: Config): Config => ({ ...c, contentRequirement: { layer3: { standardText: "" } } });
export const removeAsr = (c: Config): Config => {
  const { contentRequirement: _c, ...rest } = c;
  return rest;
};
export const setAsrText = (c: Config, text: string): Config => (c.contentRequirement?.layer3 ? { ...c, contentRequirement: { layer3: { ...c.contentRequirement.layer3, standardText: text } } } : c);
export const setAsrAlias = (c: Config, v: string): Config => (c.contentRequirement?.layer3 ? { ...c, contentRequirement: { layer3: withAlias(c.contentRequirement.layer3, v) } } : c);
export const addComment = (c: Config): Config => ({ ...c, commentRequirement: { mode: "any", keywords: [], method: { type: "at_least_n", n: 2 } } });
export const removeComment = (c: Config): Config => {
  const { commentRequirement: _c, ...rest } = c;
  return rest;
};
export const patchComment = (c: Config, f: (r: CommentReq) => CommentReq): Config => (c.commentRequirement ? { ...c, commentRequirement: f(c.commentRequirement) } : c);
/** 切换达标方式时带上合理的初值（至少 N 条默认 2；比例默认 50%）。 */
export const methodOf = (type: Method["type"], prev: Method): Method =>
  type === "at_least_n" ? { type, n: prev.type === "at_least_n" ? prev.n : 2 } : type === "ratio" ? { type, bp: prev.type === "ratio" ? prev.bp : 5000 } : { type };
