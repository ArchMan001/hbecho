// sync_settings 读取与校验（FS-1.2、FS-D15）：timezone 不是 Asia/Shanghai 或时点非法 → 拒绝启动，不静默纠正。
// 批次创建时把设置与运行时配置冻结进 settings_snapshot，之后批次内所有任务只读快照。
import { eq } from "drizzle-orm";
import type { Db, DbTx } from "../../db/client";
import { syncSettings } from "../../db/schema";
import type { Environment, ExecutionMode } from "../provider-adapter";
import { SyncError } from "./errors";
import { slotsSchema, type Slot } from "./slots";

/** 运行时配置：写入批次快照，供审计；规划用其中的 modes 固化每个任务的同步 / 异步模式（不写死总策略）。 */
export interface SyncRuntime {
  environment: Environment;
  modes: { media_user_info: ExecutionMode; user_video_list: ExecutionMode };
  [extra: string]: unknown;
}
export type SettingsRow = typeof syncSettings.$inferSelect;
export interface LoadedSettings {
  row: SettingsRow;
  slots: Slot[];
}

export async function loadSettings(db: Db | DbTx, opts: { lock?: boolean } = {}): Promise<LoadedSettings> {
  const q = db.select().from(syncSettings).where(eq(syncSettings.settingsId, 1));
  const [row] = await (opts.lock ? q.for("update") : q);
  if (!row) throw new SyncError("sync_settings_missing", "sync_settings 未配置");
  if (row.timezone !== "Asia/Shanghai") {
    throw new SyncError("invalid_settings", `只支持 Asia/Shanghai（固定 UTC+8，无夏令时），当前 ${row.timezone}`);
  }
  const slots = slotsSchema.safeParse(row.scheduleSlots);
  if (!slots.success) {
    throw new SyncError("invalid_settings", `schedule_slots 非法：${slots.error.issues.map((i) => `${i.path.join(".") || "$"}: ${i.message}`).join("; ")}`);
  }
  return { row, slots: slots.data };
}

export function settingsSnapshot(row: SettingsRow, runtime: SyncRuntime): Record<string, unknown> {
  return {
    timezone: row.timezone,
    schedule_slots: row.scheduleSlots,
    initial_content_limit: row.initialContentLimit,
    list_safety_page_limit: row.listSafetyPageLimit,
    comment_page_limit: row.commentPageLimit,
    comment_item_limit: row.commentItemLimit,
    account_resolve_max_attempts: row.accountResolveMaxAttempts,
    task_max_attempts: row.taskMaxAttempts,
    config_version: row.configVersion.toString(),
    runtime,
  };
}
