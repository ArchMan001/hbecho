// 学习进度上报与续播位置（G-7、design §4.4 / §5.2）。
//   - 一个 (用户, 课程) 一行，upsert；不做事件流水（design §9）。
//   - 位置取最后上报值，只在超出片长时截断；**不做回退保护**（G-D18）。
//   - 单次观看增量超过 60 秒的部分不计（G-D19）；资料不计时长，只记首末时间与打开次数。
//   - `started=true`（真正起播 / 打开资料）才让播放次数 +1；心跳与暂停后继续不加。
import { sql } from "drizzle-orm";
import { z } from "zod";
import { learningProgress } from "../../db/schema";
import type { AuthContext } from "../access-control";
import { authorizeOrThrow, requireUser, type LearningDeps } from "./deps";
import { LearningError } from "./errors";
import { parseId } from "./ids";
import { loadCourse } from "./read";

/** 单次上报最多计入的观看秒数（心跳 15 秒一次，留一倍多余量给节流补报）。 */
export const MAX_DELTA_SEC = 60;

const input = z
  .object({
    courseId: z.string(),
    positionSec: z.number().int().min(0).max(86_400),
    deltaWatchedSec: z.number().int().min(0).max(86_400).default(0),
    started: z.boolean().default(false),
  })
  .strict();

export async function reportProgress(deps: LearningDeps, ctx: AuthContext, raw: unknown): Promise<{ positionSec: number }> {
  const userId = requireUser(ctx);
  const parsed = input.safeParse(raw);
  if (!parsed.success) throw new LearningError("input", "invalid_input", `字段不合法：${[...new Set(parsed.error.issues.map((i) => i.path.join(".") || "(root)"))].join("、")}`);
  const body = parsed.data;
  const courseId = parseId(body.courseId, "courseId");
  await authorizeOrThrow(deps, ctx, "learning.read");
  const loaded = await loadCourse(deps, courseId);
  if (!loaded) throw new LearningError("not_found", "course_not_found", "课程不存在");
  // 每次上报都重过范围：下架 / 移出范围后下一次上报即 403
  await authorizeOrThrow(deps, ctx, "learning.read", { key: "learning_course", ref: loaded.ref });

  const c = loaded.course;
  const isVideo = c.kind === "video";
  const positionSec = isVideo ? Math.min(body.positionSec, c.durationSec ?? body.positionSec) : 0;
  const delta = isVideo ? Math.min(body.deltaWatchedSec, MAX_DELTA_SEC) : 0;
  const plays = body.started ? 1 : 0;
  const now = deps.clock.now();
  await deps.db
    .insert(learningProgress)
    .values({ userId, courseId, positionSec, watchedSec: delta, playCount: plays, firstLearnedAt: now, lastLearnedAt: now })
    .onDuplicateKeyUpdate({
      // 并发上报按提交顺序，后写覆盖位置；累计值用加法，不会丢更新
      set: {
        positionSec: isVideo ? positionSec : sql`${learningProgress.positionSec}`,
        watchedSec: sql`${learningProgress.watchedSec} + ${delta}`,
        playCount: sql`${learningProgress.playCount} + ${plays}`,
        lastLearnedAt: now,
      },
    });
  return { positionSec };
}
