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
  return RUN_STATUS[r.status] ?? { label: r.status, tone: "gray" };
}
export const KIND_LABEL: Record<string, string> = { video: "视频", image: "图文" };
export const TARGET_LABEL: Record<string, string> = { avatar: "头像", cover: "封面", background: "主页背景" };
export const ABILITY_LABEL: Record<string, string> = { whole_image: "整张图片对比", image_element: "图片元素对比" };
const MODE_LABEL: Record<string, string> = { any: "任一", all: "全含" };
const METHOD_LABEL = (m: { type: string; n?: number; ratio?: string } | undefined): string => {
  if (!m) return "";
  if (m.type === "at_least_n") return `至少 ${m.n} 条`;
  if (m.type === "all") return "全部命中";
  if (m.type === "any") return "任一命中";
  if (m.type === "ratio") return `命中率 ≥ ${m.ratio}`;
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
