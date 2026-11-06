// 按需动作的 Runner 注册（任务 6）：fetch_content_detail、fetch_comments。download_media 在任务 7 加入。
import { createCommentsRunner } from "../comments/comments-runner";
import type { AccountRunnerDeps } from "./account-deps";
import { createDetailRunner } from "./detail-runner";
import { ACCOUNT_MEDIA_SCHEMA, createAccountMediaRunner } from "./account-media-runner";
import type { MediaRunnerDeps } from "./media-deps";
import type { RunnerRegistry, TaskRunner } from "./types";
import { MEDIA_VIDEO_SCHEMA, createVideoRunner } from "./video-runner";

export function createDemandRunners(deps: AccountRunnerDeps): RunnerRegistry {
  return Object.freeze({ fetch_content_detail: createDetailRunner(deps), fetch_comments: createCommentsRunner(deps) });
}

/** 媒资 Runner（任务 7）：download_media 有两种任务——周期的账号级（scope=account_batch）和按需的视频 / 音频，按参数的 schema_version 分派。 */
export function createMediaRunner(deps: MediaRunnerDeps): TaskRunner {
  const account = createAccountMediaRunner(deps);
  const video = createVideoRunner(deps);
  return (ctx) => {
    const v = (ctx.task.taskParameters as { schema_version?: string } | null)?.schema_version;
    if (v === ACCOUNT_MEDIA_SCHEMA) return account(ctx);
    if (v === MEDIA_VIDEO_SCHEMA) return video(ctx);
    return Promise.resolve({ kind: "failure", code: "task_parameters_invalid", detail: { reason: "unknown_media_task_schema" } });
  };
}
export function createMediaRunners(deps: MediaRunnerDeps): RunnerRegistry {
  return Object.freeze({ download_media: createMediaRunner(deps) });
}
