// 跑一轮真实的周期流程（调度器规划 → worker → 主页 / 列表 Runner），让内容有 finalized 快照与 current——按需采集的前提。
// 列表页是合成的（结构取自 raw3），内容 ID 由调用方给定，所以可以和详情 / 评论 fixture 里的 post_id 对上。
import { eq } from "drizzle-orm";
import type { TestDb } from "./db";
import { listBytes, type SyntheticEntry } from "./list-bytes";
import { SLOT, PROFILE_PATH, defaultProfileFixture, type SyncEnv } from "./sync-env";
import { settleTasks } from "./sync-fixtures";
import { contents, syncBatches } from "../../src/db/schema";
import type { Platform } from "../../src/modules/provider-adapter";
import { createAccountRunners } from "../../src/modules/sync-runner";

export interface PeriodicAccount {
  platform: Platform;
  staffId: bigint;
  postIds: string[];
  /** 列表条目的作者；抖音默认与 raw3 主页一致，其余随意（不足 5 条不做作者判定）。 */
  author?: string;
}

export async function runPeriodic(t: TestDb, env: SyncEnv, specs: PeriodicAccount[]) {
  const made = [];
  const profiles: Record<string, string> = {};
  const lists: Record<string, SyntheticEntry[]> = {};
  for (const s of specs) {
    const a = await env.addAccount(s.platform, s.staffId);
    profiles[env.locatorOf(a.accountId)] = defaultProfileFixture(s.platform);
    lists[env.locatorOf(a.accountId)] = s.postIds.map((postId, i) => ({ postId, userId: s.author ?? (s.platform === "douyin" ? "HITACHI1" : "AUTHOR"), createdMs: 1788169004000 - i * 1000 }));
    made.push(a);
  }
  env.routeBy(PROFILE_PATH, profiles);
  env.routeList(({ url }) => listBytes(lists[url]!, { hasMore: false, cursorJson: "0" }));
  await env.scheduler.tick(SLOT);
  await env.worker(createAccountRunners(env.deps)).run({ untilIdle: true });
  const out = [];
  for (const a of made) {
    const rows = await t.db.select().from(contents).where(eq(contents.accountId, a.accountId));
    out.push({ ...a, contentIds: new Map(rows.map((r) => [r.platformContentId, r.contentId])) });
  }
  return out;
}

/** 进入下一轮：把正在运行的 full 批次的未完成任务收尾，推进 7 天，tick（汇总旧批次并开始新的 full 批次，新批次的 started_at 即新的「本轮起点」）。 */
export async function nextRound(t: TestDb, env: SyncEnv): Promise<void> {
  const running = await t.db.select().from(syncBatches).where(eq(syncBatches.status, "running"));
  for (const b of running.filter((x) => x.purpose === "full")) {
    const open = (await env.tasks()).filter((x) => x.batchId === b.batchId && ["pending", "retry_wait", "leased", "running"].includes(x.status));
    for (const task of open) await settleTasks(t.db, b.batchId, { status: "succeeded", where: (x) => x.taskId === task.taskId }, env.clock.now());
  }
  env.clock.advance(7 * 24 * 3600 * 1000);
  await env.scheduler.tick(env.clock.now());
  await env.scheduler.tick(env.clock.now());
}
