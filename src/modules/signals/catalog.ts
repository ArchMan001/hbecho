// 信号目录（requirements SG-1）：C 域唯一的信号清单。未注册的信号不可读、不可请求、不可写进监控段。
// 能力版本只在这里改；改版本号就是「能力升级」（SG-10）：旧值读作 stale，什么都不自动重算。
import { SEGMENT_PLATFORMS } from "../../db/schema/signals";
import { SignalError } from "./errors";

export type Platform = (typeof SEGMENT_PLATFORMS)[number];
export type SignalObject = "content" | "account" | "comment";
export type SignalScope = "global" | "parameterized";
export type SignalStorage = "feature_row" | "result";

export interface CatalogEntry {
  readonly key: string;
  readonly object: SignalObject;
  /** 能力标识；`perPlatform` 的信号实际标识是 `<capability>.<platform>`，见 capabilityOf。 */
  readonly capability: string;
  readonly perPlatform?: true;
  /** 成本档 0（纯函数，免费）～3（大模型）。 */
  readonly costTier: 0 | 1 | 2 | 3;
  readonly scope: SignalScope;
  readonly platforms: readonly Platform[];
  readonly storage: SignalStorage;
}

const ALL: readonly Platform[] = SEGMENT_PLATFORMS;
// 快手没有评论采集（comments/policy.ts）；账号背景 / 头像只有抖音（C-D18：小红书同理）
const DOUYIN_XHS: readonly Platform[] = ["douyin", "xiaohongshu"];
const DOUYIN: readonly Platform[] = ["douyin"];

const entry = (e: CatalogEntry): CatalogEntry => e;

export const CATALOG: readonly CatalogEntry[] = [
  // 文本类：title / body 的平台可得性按 PLATFORM_TEXT_FIELDS（任务 3 以 fixture 核对，design §14 第 6 项）；核对前三平台都按「有」处理
  entry({ key: "text.title_normalized", object: "content", capability: "text.normalize", costTier: 0, scope: "global", platforms: ALL, storage: "feature_row" }),
  entry({ key: "text.body_normalized", object: "content", capability: "text.normalize", costTier: 0, scope: "global", platforms: ALL, storage: "feature_row" }),
  // 话题解析按平台分变体：将来的平台差异不必升全平台版本（C-D12）
  entry({ key: "text.hashtags", object: "content", capability: "text.hashtags", perPlatform: true, costTier: 0, scope: "global", platforms: ALL, storage: "feature_row" }),
  entry({ key: "content.cover_template_score", object: "content", capability: "image.template", costTier: 1, scope: "parameterized", platforms: ALL, storage: "result" }),
  entry({ key: "content.cover_element_score", object: "content", capability: "image.element", costTier: 1, scope: "parameterized", platforms: ALL, storage: "result" }),
  entry({ key: "content.asr_text", object: "content", capability: "speech.asr", costTier: 2, scope: "global", platforms: ALL, storage: "result" }),
  entry({ key: "content.asr_judgement", object: "content", capability: "speech.judge", costTier: 3, scope: "parameterized", platforms: ALL, storage: "result" }),
  entry({ key: "account.bg_template_score", object: "account", capability: "image.template", costTier: 1, scope: "parameterized", platforms: DOUYIN, storage: "result" }),
  entry({ key: "account.bg_element_score", object: "account", capability: "image.element", costTier: 1, scope: "parameterized", platforms: DOUYIN, storage: "result" }),
  entry({ key: "account.avatar_template_score", object: "account", capability: "image.template", costTier: 1, scope: "parameterized", platforms: DOUYIN, storage: "result" }),
  entry({ key: "account.avatar_element_score", object: "account", capability: "image.element", costTier: 1, scope: "parameterized", platforms: DOUYIN, storage: "result" }),
  entry({ key: "comment.text_normalized", object: "comment", capability: "text.normalize", costTier: 0, scope: "global", platforms: DOUYIN_XHS, storage: "feature_row" }),
];

/** 全部能力标识的当前版本。升级只改这里；`text.normalize` 的版本同时是文本类信号的 nv（design §7.6）。 */
export const CAPABILITY_VERSIONS: Readonly<Record<string, number>> = {
  "text.normalize": 1,
  "text.hashtags.douyin": 1,
  "text.hashtags.xiaohongshu": 1,
  "text.hashtags.kuaishou": 1,
  "image.template": 1,
  "image.element": 1,
  "speech.asr": 1,
  "speech.judge": 1,
};

/** 缺省启用集：只有免费的纯函数文本类（SG-15）。 */
export const DEFAULT_ENABLED_CAPABILITIES: readonly string[] = ["text.normalize", "text.hashtags.douyin", "text.hashtags.xiaohongshu", "text.hashtags.kuaishou"];

const BY_KEY = new Map(CATALOG.map((e) => [e.key, e]));

/** 目录外的信号键一律以 signal_unregistered 拒绝。 */
export function requireSignal(key: string): CatalogEntry {
  const e = BY_KEY.get(key);
  if (!e) throw new SignalError("input", "signal_unregistered", `信号 ${key} 不在目录里`);
  return e;
}

export const capabilityOf = (e: CatalogEntry, platform: string): string => (e.perPlatform ? `${e.capability}.${platform}` : e.capability);

/** 某平台下可用的信号键，供 D 的规则配置过滤（PRD C §3.7）。 */
export const platformSignals = (platform: string): string[] => CATALOG.filter((e) => (e.platforms as readonly string[]).includes(platform)).map((e) => e.key);

/** 能力标识 → 当前版本；标识不在表里时抛错，避免把拼写错误当成「版本 undefined」。 */
export function versionOf(capabilityId: string): number {
  if (!Object.hasOwn(CAPABILITY_VERSIONS, capabilityId)) throw new SignalError("input", "capability_unregistered", `能力 ${capabilityId} 不在目录里`);
  return CAPABILITY_VERSIONS[capabilityId]!;
}

/**
 * 解析 HBECHO_SIGNALS_ENABLED（能力标识逗号分隔）。未设置或全空白 → 缺省启用集；含目录外标识 → 启动失败。
 * 显式写出的集合就是全集（不在缺省之上叠加）：要关掉文本类也可以。
 */
export function parseEnabledCapabilities(raw: string | undefined): ReadonlySet<string> {
  if (raw === undefined || raw.trim() === "") return new Set(DEFAULT_ENABLED_CAPABILITIES);
  const ids = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = ids.filter((id) => !Object.hasOwn(CAPABILITY_VERSIONS, id));
  if (unknown.length > 0) throw new SignalError("configuration", "enabled_unknown_capability", `HBECHO_SIGNALS_ENABLED 含目录外的能力标识：${unknown.join("、")}`);
  return new Set(ids);
}
