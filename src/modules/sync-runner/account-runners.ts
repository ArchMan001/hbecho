// 账号采集 Runner 的注册（任务 5）：fetch_profile、fetch_content_list。依赖由调用方注入（gateway 不能是模块级常量），
// 结果传给 buildSyncApp({ runners })。任务 6、7 的动作在各自任务里加入。
import type { AccountRunnerDeps } from "./account-deps";
import { createListWalker } from "./list-walker";
import { createProfileRunner } from "./profile-runner";
import type { RunnerRegistry } from "./types";

export function createAccountRunners(deps: AccountRunnerDeps): RunnerRegistry {
  return Object.freeze({
    fetch_profile: createProfileRunner(deps),
    fetch_content_list: createListWalker(deps),
  });
}
