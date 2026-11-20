// 判定计划页面用语（ui-foundation §6.6）：状态、向导步骤、运行状态、配置摘要在这里换成人话。
// 未登记的码原样回退显示稳定码，不会被吞掉；内部字段名、表名不出现在界面。
import type { Tone } from "../_components/ui";
import type { Config } from "../../modules/judgement/config";
import type { ExecutionBrief } from "../../modules/judgement/views";
import { PLATFORM_LABEL } from "./plan-labels";
export { PLATFORM_LABEL };
export const JP_STATUS: Record<string, { label: string; tone: Tone }> = {
  active: { label: "进行中", tone: "green" },
  archived: { label: "已归档", tone: "gray" },
  provisioning: { label: "创建中", tone: "amber" },
};
/** 向导进度：草稿的 wizardStep → 下一步该去第几页（design §15.2）。 */
export const STEP_PAGE: Record<string, 1 | 2 | 3> = { draft: 1, circled: 2, compared: 3 };
export const STEP_NAME: Record<1 | 2 | 3, string> = { 1: "圈定", 2: "比对", 3: "理解与执行" };
export const wizardHref = (planId: string, wizardStep: string): string => `/judgement/${planId}/wizard/${STEP_PAGE[wizardStep] ?? 1}`;
const RUN_STATUS: Record<string, { label: string; tone: Tone }> = {
  planned: { label: "排队中", tone: "gray" },
  running: { label: "执行中", tone: "blue" },
  waiting: { label: "执行中", tone: "blue" },
  completed: { label: "已完成", tone: "green" },
  failed: { label: "失败", tone: "red" },
  cancelled: { label: "已取消", tone: "gray" },
};
/** 「等待采集 / 等待识别」只在运行在等依赖时显示（design §15.2）。 */
export function runStatus(r: Pick<ExecutionBrief, "status" | "waitingOn">): { label: string; tone: Tone } {
  if (r.status === "waiting" && r.waitingOn === "demand") return { label: "等待采集", tone: "amber" };
  if (r.status === "waiting" && r.waitingOn === "signals") return { label: "等待识别", tone: "amber" };
  if (r.status === "waiting" && r.waitingOn === "collection") return { label: "等待列表采集", tone: "amber" };
  return RUN_STATUS[r.status] ?? { label: r.status, tone: "gray" };
}
export const KIND_LABEL: Record<string, string> = { video: "视频", image: "图文" };
export const TARGET_LABEL: Record<string, string> = { avatar: "头像", cover: "封面", background: "主页背景" };
export const ABILITY_LABEL: Record<string, string> = { whole_image: "整张图片对比", image_element: "图片元素对比" };
const MODE_LABEL: Record<string, string> = { any: "任一", all: "全含" };
export const METHOD_LABEL = (m: { type: string; n?: number; bp?: number } | undefined): string => {
  if (!m) return "";
  if (m.type === "at_least_n") return `至少 ${m.n} 条`;
  if (m.type === "all") return "全部命中";
  if (m.type === "any") return "任一命中";
  if (m.type === "ratio") return `命中率 ≥ ${(m.bp ?? 0) / 100}%`;
  return m.type;
};
/** 配置摘要：一行一个条件，业务看得懂的话（不含正文原文，只有配置里的关键词 / 话题）。 */
export function configChips(c: Config): string[] {
  const out: string[] = [`时间窗 ${c.window.from} ~ ${c.window.to ?? "执行时"}`, `形态 ${c.kinds.map((k) => KIND_LABEL[k] ?? k).join(" / ")}`];
  for (const t of c.layer1.text) out.push(`${t.fields.map((f) => (f === "title" ? "标题" : "正文")).join("、")}${MODE_LABEL[t.mode] ?? t.mode}：${t.keywords.join(" / ")}`);
  for (const h of c.layer1.hashtags) out.push(`话题${MODE_LABEL[h.mode] ?? h.mode}：${h.values.map((v) => `#${v}`).join(" ")}`);
  if (c.layer1.duration) out.push(`时长 ${c.layer1.duration.minSeconds ?? 0}–${c.layer1.duration.maxSeconds ?? "不限"} 秒`);
  if (c.layer1.quantity) out.push(`至少 ${c.layer1.quantity.n} 条命中（按点赞取前 ${c.layer1.quantity.n} 条）`);
  for (const a of c.layer2.abilities) out.push(`${a.alias ? `${a.alias} · ` : ""}${ABILITY_LABEL[a.kind] ?? a.kind} · ${TARGET_LABEL[a.target] ?? a.target} ≥ ${a.threshold}`);
  if (c.commentRequirement) out.push(`评论${MODE_LABEL[c.commentRequirement.mode] ?? c.commentRequirement.mode}：${c.commentRequirement.keywords.join(" / ")} · ${METHOD_LABEL(c.commentRequirement.method as never)}`);
  if (c.contentRequirement?.layer3) out.push("音频理解（ASR 判定）");
  return out;
}
/** 失败的稳定错误码 → 人话（未登记的原样显示码）。 */
const RUN_ERROR: Record<string, string> = {
  internal_error: "运行中遇到内部错误，可以续跑",
  plan_not_found: "所属活动计划已不存在",
  submitter_revoked: "提交人的账号已不可用，运行已取消",
  participant_conflict: "名单里有账号对应同一位专员，请先处理名单",
  no_staff_assignment: "名单里有账号没有归属专员，请先处理名单",
  not_executable: "监控段当前不可执行",
};
export const runErrorText = (code: string | null): string | null => (code ? (RUN_ERROR[code] ?? "运行失败") : null);
export const timeText = (d: Date | null): string => {
  if (!d) return "—";
  const x = new Date(d.getTime() + 8 * 3600_000);
  const p = (v: number) => String(v).padStart(2, "0");
  return `${p(x.getUTCMonth() + 1)}-${p(x.getUTCDate())} ${p(x.getUTCHours())}:${p(x.getUTCMinutes())}`;
};

/** 未获取成功 / 未通过的原因码 → 人话；未登记的原样显示码，不吞。 */
const REASON: Record<string, string> = {
  media_pending: "素材未归档",
  audio_not_archived: "音频未归档",
  comments_incomplete: "评论覆盖不全",
  account_unavailable: "账号不可用",
  no_profile_snapshot: "无主页快照",
  sync_gap: "同步有缺口",
  sync_failed: "采集失败",
  sync_pending: "采集中",
  not_computed: "识别尚未补算",
  published_at_missing: "发布时间缺失",
  content_kind_unknown: "内容形态无法归类",
  layer1_not_selected: "未进入前 N 条",
  layer1_text_miss: "第 1 层文本未命中",
  layer2_below_threshold: "第 2 层低于阈值",
  dependency_timeout: "依赖超时",
  not_executable: "能力不可执行",
  incomplete_judgement_evidence: "判定证据不完整",
};
export const reasonLabel = (code: string | null | undefined): string => (code ? (REASON[code] ?? code) : "—");
/** 三值结果（内容 / 评论 / 账号 / 总结果 / 各层）的显示。 */
export const RESULT: Record<string, { label: string; tone: Tone }> = {
  success: { label: "成功", tone: "green" },
  pass: { label: "通过", tone: "green" },
  not_met: { label: "不达标", tone: "red" },
  fail: { label: "不通过", tone: "red" },
  unobtained: { label: "未获取成功", tone: "gray" },
  skipped: { label: "未进入", tone: "gray" },
  not_configured: { label: "未配置", tone: "gray" },
  waiting: { label: "等待中", tone: "amber" },
};
export const resultOf = (v: string | null | undefined): { label: string; tone: Tone } => (v ? (RESULT[v] ?? { label: v, tone: "gray" as const }) : { label: "—", tone: "gray" as const });
/** 向导里阻塞项的稳定码 → 人话。 */
export const BLOCKER: Record<string, string> = {
  config_invalid: "配置还不完整：请回到对应页面补全",
  image_missing: "还有图片元素对比没有上传元素图",
  wizard_step_required: "请先完成上一步（圈定 / 试跑）",
  not_executable: "有能力当前不可用（例如音频理解尚未启用），暂时不能发布与执行",
};
/** 执行的阶段（顺序即进度）：页面只显示「正在做什么」与大致进度，不显示内部阶段名。 */
const EXECUTION_PHASES: Array<[string, string]> = [
  ["freeze", "冻结名单与内容"],
  ["scope", "确定参与范围"],
  ["layer1", "第 1 层条件"],
  ["select", "按点赞取前 N 条"],
  ["scores", "第 2 层比对"],
  ["demand", "提交采集需求"],
  ["layer3", "第 3 层判定"],
  ["comments", "评论要求"],
  ["aggregate", "汇总结果"],
  ["finalize", "收尾"],
];
export function phaseInfo(phase: string | null): { label: string; percent: number } {
  const i = EXECUTION_PHASES.findIndex(([k]) => k === phase);
  return i < 0 ? { label: "准备中", percent: 5 } : { label: EXECUTION_PHASES[i]![1], percent: Math.round(((i + 0.5) / EXECUTION_PHASES.length) * 100) };
}
