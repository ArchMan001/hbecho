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

// ---- b-access-control（AX-6、AX-11、AX-12）-----------------------------------------------------------------
import { CAPABILITIES } from "./modules/access-control/roles";

const nonTestSources = all.filter((p) => p.endsWith(".ts") && !isTest(p));
const text = (p: string) => readFileSync(p, "utf8");
/** 去掉注释，避免说明文字触发扫描。 */
const code = (p: string) => text(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("B-AX-6：业务代码只检查 Capability，不写角色条件", () => {
  it("四个角色字面量只出现在 access-control、授权表 schema 与 access CLI 里", () => {
    const allowed = (r: string) => r.startsWith("modules/access-control/") || r === "db/schema/access.ts" || r.startsWith("worker/access-");
    const offenders = nonTestSources.filter((p) => !allowed(rel(p)) && /\b(platform_admin|hq_manager|branch_manager|store_staff)\b/.test(code(p))).map(rel);
    expect(offenders).toEqual([]);
  });

  it("仓库里出现的 Capability 字符串都属于注册表（29 项）", () => {
    expect(CAPABILITIES).toHaveLength(29);
    const known = new Set<string>(CAPABILITIES);
    const re = /["'`]((?:data|report|rule|metric|learning|ai|user|audit|config|activity_plan|monitor)\.[a-z_]+(?:\.[a-z_]+)*)["'`]/g;
    const unknown: string[] = [];
    // 日志事件名（logger.info(obj, "audit.low_risk_write_failed")）长得像 Capability 但不是；只放行这一种明确形态
    const logEvent = /\b(?:logger|log)\??\.(?:info|warn|error|debug)\([^)]*["'`]$/;
    for (const p of nonTestSources) {
      const src = code(p);
      for (const m of src.matchAll(re)) {
        if (known.has(m[1]!)) continue;
        if (logEvent.test(src.slice(Math.max(0, m.index! - 160), m.index! + 1))) continue;
        unknown.push(`${rel(p)}: ${m[1]}`);
      }
    }
    expect(unknown).toEqual([]);
  });

  it("没有 admin 旁路：authorize.ts 里不存在「是超管就直接放行」", () => {
    const src = code(join(SRC, "modules", "access-control", "authorize.ts"));
    expect(src).not.toMatch(/platform_admin[^\n]*return\s*\{?\s*(ok:\s*true|true)/);
    expect(src).not.toMatch(/isAdmin|platformAdmin\s*\)\s*return/);
  });
});

describe("B-AX-1：不使用 better-auth 的 admin 体系", () => {
  it("非测试代码里没有 adminAc / set-password / impersonate / defaultRole / adminRoles", () => {
    const offenders = nonTestSources.filter((p) => /\b(adminAc|defaultRole|adminRoles)\b|(?<![\w-])set-password|impersonate/.test(code(p))).map(rel);
    expect(offenders).toEqual([]);
  });
});

describe("B-AX-5：用户只停用不删除，且不触碰监控开关（acceptance D16、D17）", () => {
  const sources = nonTestSources.filter((p) => rel(p).startsWith("modules/access-control/"));
  it("access-control 里没有删除 access_users / auth_users 行的路径", () => {
    expect(sources.length).toBeGreaterThan(5);
    const offenders = sources.filter((p) => /\.delete\(\s*(accessUsers|authUsers)\s*\)|DELETE\s+FROM\s+(access_users|auth_users)\b/i.test(code(p))).map(rel);
    expect(offenders).toEqual([]);
  });
  it("access-control 里没有对 monitoring_enabled 的任何引用", () => {
    expect(sources.filter((p) => /monitoring_?enabled/i.test(code(p))).map(rel)).toEqual([]);
  });
});
describe("B-AX-14：其他模块只经 access-control 的入口（index）导入它", () => {
  // 例外：src/app（Next 入口）与本模块自己的进程入口（worker/access-*、worker/sms-smoke-*）
  const own = (r: string) => r.startsWith("modules/access-control/") || r.startsWith("app/") || r.startsWith("worker/access-") || r.startsWith("worker/sms-smoke-");
  it("非测试代码里，模块外对 access-control 的导入路径都以 access-control 结尾（不带子路径）", () => {
    const offenders = nonTestSources.filter((p) => !own(rel(p)) && /from\s+["'][^"']*\/access-control\/[^"']+["']/.test(code(p))).map(rel);
    expect(offenders).toEqual([]);
    expect(nonTestSources.some((p) => !own(rel(p)) && /from\s+["'][^"']*\/access-control["']/.test(code(p)))).toBe(true); // 确实有人在用入口
  });
});
describe("B-AX-12：src/app 只做入口，不写 SQL", () => {
  it("src/app 下没有 insert / update / delete / execute / transaction / sql 模板 / 对 db 目录的导入", () => {
    const app = nonTestSources.filter((p) => rel(p).startsWith("app/"));
    expect(app.length).toBeGreaterThan(0);
    const offenders = app.filter((p) => /\.(insert|update|delete|execute|transaction)\(|\bsql`|from\s+["'][^"']*\/db\/|drizzle-orm/.test(code(p))).map(rel);
    expect(offenders).toEqual([]);
  });
});

describe("B-AX-13：access-control 的数据库测试里没有并发造数（dev-ci-cadence 第 3 条）", () => {
  it("access-control 与 src/db 下新增的 *.db.test.ts 没有 Promise.all", () => {
    const files = all.filter((f) => f.endsWith(".db.test.ts") && (rel(f).startsWith("modules/access-control/") || rel(f).startsWith("db/access-")));
    expect(files.length).toBeGreaterThan(3);
    const needle = ["Promise", "all("].join(".");
    expect(files.filter((f) => text(f).includes(needle)).map(rel)).toEqual([]);
  });
});

describe("csv-parse 只在 csv-file 里被导入（ADR-0014）", () => {
  it("其余模块拿到的是项目自己的行结构", () => {
    const offenders = nonTestSources.filter((p) => /from\s+["']csv-parse/.test(code(p)) && rel(p) !== "modules/csv-file/index.ts").map(rel);
    expect(offenders).toEqual([]);
  });
});
