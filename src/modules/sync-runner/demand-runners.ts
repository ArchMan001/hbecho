// 按需动作的 Runner 注册（任务 6）：fetch_content_detail、fetch_comments。download_media 在任务 7 加入。
import { createCommentsRunner } from "../comments/comments-runner";
import type { AccountRunnerDeps } from "./account-deps";
import { createDetailRunner } from "./detail-runner";
import type { RunnerRegistry } from "./types";

export function createDemandRunners(deps: AccountRunnerDeps): RunnerRegistry {
  return Object.freeze({ fetch_content_detail: createDetailRunner(deps), fetch_comments: createCommentsRunner(deps) });
}
