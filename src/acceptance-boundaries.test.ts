// 静态边界检查（acceptance R5、R9、N7）：靠扫描源码保证，不靠人记得。
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { createBatchPlanner } from "./modules/sync-schedule";

const SRC = join(__dirname);
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
const all = walk(SRC);
const rel = (p: string) => relative(SRC, p);
const isTest = (p: string) => /\.test\.ts$/.test(p);

describe("R9：只有按需模块 / 详情 Runner 能创建按需任务", () => {
  it("insertDemandTask 的调用点固定在 demand/ 与 sync-runner/detail-runner.ts", () => {
    const callers = all.filter((p) => !isTest(p) && p.endsWith(".ts") && /\binsertDemandTask\s*\(/.test(readFileSync(p, "utf8"))).map(rel).sort();
    expect(callers).toEqual(["modules/demand/submit.ts", "modules/demand/tasks.ts", "modules/sync-runner/detail-runner.ts"]);
  });
  it("其它非测试代码不向 sync_tasks 写 fetch_content_detail / fetch_comments / 视频 download_media（demandTaskKey 只在 demand 与任务键模块里出现）", () => {
    const users = all.filter((p) => !isTest(p) && p.endsWith(".ts") && /\bdemandTaskKey\b/.test(readFileSync(p, "utf8"))).map(rel).sort();
    expect(users).toEqual(["modules/demand/tasks.ts", "modules/sync-schedule/index.ts", "modules/sync-schedule/task-keys.ts"]); // index.ts 只是再导出
  });
});

describe("R5：同步相关数据库测试里没有 Promise.all（避免抢同一行锁，dev-ci-cadence 第 3 条）", () => {
  it("a-full-sync 新增 / 改动的 *.db.test.ts", () => {
    const dirs = ["sync-schedule", "sync-runner", "demand", "comments", "sync-ops", "sync-status", "maintenance", "monitoring", "media-archive"].map((d) => join(SRC, "modules", d));
    const files = [...dirs.flatMap(walk), ...walk(join(SRC, "worker"))].filter((f) => f.endsWith(".db.test.ts"));
    expect(files.length).toBeGreaterThan(10);
    // 本文件之外的测试不得出现；用字符串拼接避免本文件自己命中
    const needle = ["Promise", "all("].join(".");
    expect(files.filter((f) => readFileSync(f, "utf8").includes(needle)).map(rel)).toEqual([]);
  });
});

describe("N7：不提供停用专员的命令（FS-14.5）", () => {
  it("CLI 的用法说明和命令分派里没有停用 / 禁用专员", () => {
    const cli = readFileSync(join(SRC, "worker", "sync-cli.ts"), "utf8");
    expect(cli).not.toMatch(/deactivate|disable-staff|staff\s+disable|停用专员/i);
  });
});

describe("B11：规划分块上限 500（FS-2.7）", () => {
  it("块大小超过 500 被拒绝；500 可用（规模演练里 6,000 账号实际按 ≤500 分 13 块）", () => {
    const deps = { db: {} as never, clock: { now: () => new Date() }, resolver: {} as never };
    expect(() => createBatchPlanner({ ...deps, chunkSize: 501 })).toThrow(RangeError);
    expect(() => createBatchPlanner({ ...deps, chunkSize: 0 })).toThrow(RangeError);
    expect(() => createBatchPlanner({ ...deps, chunkSize: 500 })).not.toThrow();
    expect(() => createBatchPlanner(deps)).not.toThrow(); // 缺省值落在 1..500 内
  });
});

describe("Q5 / R7：启动接线（静态检查）", () => {
  it("worker 启动时清理 24 小时前的 .part 临时文件（Q5）", () => {
    const main = readFileSync(join(SRC, "worker", "sync-main.ts"), "utf8");
    expect(main).toMatch(/cleanStaleTmp\(cfg\.media\.tmpDir,\s*24 \* 3600_000/);
  });
  it("周期任务的固定服务身份是 service:sync-worker（R7）", () => {
    expect(readFileSync(join(SRC, "worker", "sync-config.ts"), "utf8")).toContain('default("service:sync-worker")');
  });
});
