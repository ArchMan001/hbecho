// 学习域的界面用语（ui-foundation §6.6）：状态码、级别码换成人话；页面不出现「已完成」（G-D02）。
export const COURSE_KIND: Record<string, { label: string; icon: "play" | "file" }> = {
  video: { label: "视频", icon: "play" },
  document: { label: "资料", icon: "file" },
};
export const COURSE_STATUS: Record<string, { label: string; tone: "green" | "amber" | "gray" }> = {
  published: { label: "已发布", tone: "green" },
  unpublished: { label: "已下架", tone: "amber" },
  archived: { label: "已归档", tone: "gray" },
};
export const VOD_STATUS: Record<string, { label: string; tone: "amber" | "red" }> = {
  uploading: { label: "上传中", tone: "amber" },
  transcoding: { label: "转码中", tone: "amber" },
  failed: { label: "转码失败", tone: "red" },
};
export const AUDIENCE_LABEL: Record<string, string> = {
  all: "全部人员",
  branch_and_above: "分公司及以上",
  hq_and_above: "仅总部及以上",
};
export const AUDIENCE_OPTIONS = Object.keys(AUDIENCE_LABEL);

/** 秒 → m:ss（超过一小时 h:mm:ss）。 */
export function clock(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const mm = h ? String(m).padStart(2, "0") : String(m);
  return `${h ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}
/** 字节 → B/KB/MB/GB，一位小数（ui-foundation §6.7）。 */
export function fileSize(n: number | null): string {
  if (n === null) return "—";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}
export const MIME_LABEL: Record<string, string> = { "application/pdf": "PDF", "image/jpeg": "JPG", "image/png": "PNG" };

/** 按名字识别（不用 instanceof：Next 的服务端打包可能把同一个模块装成两份）。 */
export const isLearningError = (e: unknown): e is Error & { category: string; code: string; status: number } => e instanceof Error && e.name === "LearningError";
export const fmtDay = (iso: string | null): string => (iso ? new Date(iso).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" }) : "—");
