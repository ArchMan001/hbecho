import type { RunnerRegistry } from "./types";

/**
 * 动作 → Runner。任务 5（fetch_profile / fetch_content_list）、任务 6（fetch_content_detail / fetch_comments）、
 * 任务 7（download_media）依次注册。空的时候 worker 什么都不领：未实现的动作不会被领走后失败。
 */
export const RUNNERS: RunnerRegistry = Object.freeze({});
