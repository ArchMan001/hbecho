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
    const dirs = ["sync-schedule", "sync-runner", "demand", "comments", "sync-ops", "sync-status", "maintenance", "monitoring", "media-archive", "activity-plan", "plan-references"].map((d) => join(SRC, "modules", d));
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

const nonTestSources = all.filter((p) => /\.tsx?$/.test(p) && !isTest(p));
const text = (p: string) => readFileSync(p, "utf8");
/** 去掉注释，避免说明文字触发扫描。 */
const code = (p: string) => text(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("B-AX-6：业务代码只检查 Capability，不写角色条件", () => {
  // 页面里的角色字面量只用于「角色名展示」和「表单选项 / 筛选芯片」，授权判断一律 ctx.capabilities.has(...)。
  // 白名单精确到这几个文件，页面新增文件出现角色字面量会被这条拦住，由人确认它不是在做授权判断。
  const APP_DISPLAY_ONLY = new Set(["app/(app)/users/_scope.ts", "app/(app)/users/[id]/page.tsx", "app/(app)/users/page.tsx", "app/_lib/labels.ts", "app/_components/user-forms.tsx"]);
  it("四个角色字面量只出现在 access-control、授权表 schema、access CLI 与页面的几个展示文件里", () => {
    const allowed = (r: string) => r.startsWith("modules/access-control/") || r === "db/schema/access.ts" || r.startsWith("worker/access-") || APP_DISPLAY_ONLY.has(r);
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

// ---- a-activity-plan（design §10.3 三条静态护栏）----------------------------------------------------------------
describe("AP 护栏：无引用起点与 unreferenced_15d 只由 plan-references 写", () => {
  // 匹配的是「写位置」（对象字面量里的属性赋值），不是任意出现：schema、迁移、读取（aa.unreferencedSince）都不命中
  const WRITE = [/\bunreferencedSince\s*:/, /monitoringClosedReason\s*:\s*["']unreferenced_15d["']/];
  const findViolations = (files: Array<{ rel: string; text: string }>): string[] =>
    files.filter((f) => !f.rel.startsWith("db/schema/") && !f.rel.startsWith("modules/plan-references/") && WRITE.some((re) => re.test(f.text))).map((f) => f.rel);
  const scanned = nonTestSources.filter((p) => p.endsWith(".ts")).map((p) => ({ rel: rel(p), text: code(p) }));
  it("src 下除 plan-references 与 db/schema 外没有写这两处的代码", () => {
    expect(scanned.length).toBeGreaterThan(100);
    expect(findViolations(scanned)).toEqual([]);
  });
  it("反向用例：放进一个故意违规的文件，护栏必须报错", () => {
    const bad = [
      { rel: "modules/zz-violation/a.ts", text: "await tx.update(aa).set({ unreferencedSince: now })" },
      { rel: "modules/zz-violation/b.ts", text: 'await tx.update(aa).set({ monitoringClosedReason: "unreferenced_15d" })' },
      { rel: "modules/zz-violation/c.ts", text: "const x = a.unreferencedSince; // 只读不算" },
    ];
    expect(findViolations(bad)).toEqual(["modules/zz-violation/a.ts", "modules/zz-violation/b.ts"]);
    expect(findViolations([{ rel: "modules/plan-references/reconcile.ts", text: bad[0]!.text }])).toEqual([]);
  });
});
describe("AP 护栏：活动计划不创建详情 / 评论任务", () => {
  it("activity-plan 目录不调用 insertDemandTask", () => {
    const files = nonTestSources.filter((p) => rel(p).startsWith("modules/activity-plan/") || rel(p).startsWith("modules/plan-references/"));
    expect(files.length).toBeGreaterThan(3);
    expect(files.filter((p) => /\binsertDemandTask\b/.test(code(p))).map(rel)).toEqual([]);
  });
});
describe("AP：名单解析驱动与周期 Runner 共用同一个网关（装配静态检查）", () => {
  it("sync-main 用 onGateway 取出 buildAccountRunners 的网关给 createRosterResolver，且没有自建 RawCaptureGateway", () => {
    const main = readFileSync(join(SRC, "worker", "sync-main.ts"), "utf8");
    expect(main).toMatch(/onGateway:\s*\(g\)\s*=>/);
    expect(main).toMatch(/createRosterResolver\(/);
    expect(main).not.toMatch(/new RawCaptureGateway\(/);
  });
});
describe("AP：计划每日维护不依赖 OSS（装配静态检查，AP-D15）", () => {
  it("sync-main 在 OSS 维护的 try/catch 之外装配 createPlanMaintenance，并接入 runForever", () => {
    const main = readFileSync(join(SRC, "worker", "sync-main.ts"), "utf8");
    expect(main).toMatch(/planMaintain:\s*\(\)\s*=>\s*planMaintenance\.runDaily\(\)/);
    expect(main.indexOf("createPlanMaintenance({")).toBeGreaterThan(main.indexOf('"daily maintenance disabled"'));
    // 与 createMaintenance 没有任何依赖关系
    expect(readFileSync(join(SRC, "modules", "activity-plan", "maintenance.ts"), "utf8")).not.toMatch(/OssObjectStore|modules\/maintenance|raw-capture\/oss/);
  });
});

// ---- c-signals（requirements SG-16 四条静态护栏；design §4、§10）---------------------------------------------------
import { getTableName, is } from "drizzle-orm";
import { MySqlTable } from "drizzle-orm/mysql-core";
import * as allSchema from "./db/schema";
import * as signalsSchema from "./db/schema/signals";

describe("SG-16 护栏：signals 模块与 A 域、供应商、模型的边界", () => {
  type Src = { rel: string; text: string };
  const FACTS = "modules/signals/facts.ts";
  const MATCHER_CLIENT = "modules/signals/scoring/matcher-client.ts";
  const sources: Src[] = nonTestSources.filter((p) => rel(p).startsWith("modules/signals/")).map((p) => ({ rel: rel(p), text: code(p) }));

  // A 域的表 = 全部 schema 导出的表，减去 C 自己的（signals.ts 导出的）
  const aTables = Object.entries(allSchema).filter(([name, v]) => is(v, MySqlTable) && !(name in signalsSchema)) as Array<[string, MySqlTable]>;
  const aExportNames = aTables.map(([name]) => name);
  const aSqlNames = aTables.map(([, table]) => getTableName(table));
  const writeDrizzle = new RegExp(`\\.(?:insert|update|delete)\\(\\s*(?:${aExportNames.join("|")})\\s*\\)`);
  const writeSql = new RegExp(`\\b(?:INSERT\\s+(?:IGNORE\\s+)?INTO|UPDATE|DELETE\\s+FROM|REPLACE\\s+INTO)\\s+\`?(?:${aSqlNames.join("|")})\`?\\b`, "i");
  const specs = (text: string): Array<{ spec: string; typeOnly: boolean }> =>
    [...text.matchAll(/(?:import|export)\s+(type\s+)?[^"';]*?\bfrom\s*["']([^"']+)["']|import\s+["']([^"']+)["']/g)].map((m) => ({ spec: m[2] ?? m[3]!, typeOnly: m[1] !== undefined }));
  const importedNames = (text: string): string[] =>
    [...text.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["'][^"']*\/db\/schema(?:\/[\w-]+)?["']/g)].flatMap((m) => m[1]!.split(",").map((n) => n.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]!).filter(Boolean));

  // ① 不写 A 域表；只有 facts.ts 可以（只读地）引用 A 域表
  const writesA = (files: Src[]): string[] => files.filter((f) => writeDrizzle.test(f.text) || writeSql.test(f.text)).map((f) => f.rel);
  const namespaceImport = /import\s*\*\s*as\s+\w+\s+from\s*["'][^"']*\/db\/schema(?:\/[\w-]+)?["']/;
  const readSql = new RegExp(`\\b(?:FROM|JOIN)\\s+\`?(?:${aSqlNames.join("|")})\`?\\b`, "i");
  // 引用 A 域表的三种写法：具名 import、命名空间 import、裸 SQL 的 FROM / JOIN
  const readsAOutsideFacts = (files: Src[]): string[] =>
    files.filter((f) => f.rel !== FACTS && (importedNames(f.text).some((n) => aExportNames.includes(n)) || namespaceImport.test(f.text) || readSql.test(f.text))).map((f) => f.rel);
  // ② 不碰供应商调用与采集网关，不建同步任务
  const forbiddenImport = ({ spec, typeOnly }: { spec: string; typeOnly: boolean }): boolean =>
    /provider-adapter|\/orchestrator(\/|$)/.test(spec) || (/raw-capture/.test(spec) && !typeOnly && !/raw-capture\/(ports|oss-store)$/.test(spec));
  const touchesProvider = (files: Src[]): string[] =>
    files.filter((f) => specs(f.text).some(forbiddenImport) || /\b(?:RawCaptureGateway|callAndInterpret|HttpProviderTransport)\b/.test(f.text)).map((f) => f.rel);
  // ④ 网络只在 matcher-client；AI 只经 AiGatewayPort（signals 模块里不出现模型 SDK 或模型域名）
  const NET_LIBS = /^(?:node:)?https?$|^undici$|^axios$|^got$|^node-fetch$|^ali-oss$/;
  const AI_LIBS = /^openai$|^@anthropic-ai\/|^@google\/generative-ai|dashscope|^@alicloud\/|^@ai-sdk\/|^ai$/;
  const AI_HOSTS = /dashscope|bailian|openai\.com|anthropic\.com|deepseek/i;
  const strayNetwork = (files: Src[]): string[] =>
    files
      .filter((f) => f.rel !== MATCHER_CLIENT && (/\bfetch\s*\(/.test(f.text) || specs(f.text).some((s) => NET_LIBS.test(s.spec))))
      .concat(files.filter((f) => specs(f.text).some((s) => AI_LIBS.test(s.spec)) || AI_HOSTS.test(f.text)))
      .map((f) => f.rel);
  // ③ signals 下的数据库测试没有 Promise.all
  const PROMISE_ALL = ["Promise", "all("].join(".");
  const dbTests = [...walk(join(SRC, "modules", "signals")), ...walk(join(SRC, "worker")).filter((f) => /signals-[\w.-]*\.db\.test\.ts$/.test(f)), join(SRC, "db", "signals-schema.db.test.ts")].filter((f) => f.endsWith(".db.test.ts"));

  it("扫描到了 signals 的源文件（避免目录改名后护栏空转）", () => {
    expect(sources.length).toBeGreaterThan(6);
    expect(sources.map((s) => s.rel)).toContain(FACTS);
    expect(aExportNames).toEqual(expect.arrayContaining(["contents", "contentSnapshots", "comments", "mediaReferences", "mediaAssets", "externalAccounts", "syncTasks"]));
    expect(aExportNames).not.toContain("signalResults");
  });
  it("① 不对 A 域表做 insert / update / delete；A 域表只在 facts.ts 里被引用", () => {
    expect(writesA(sources)).toEqual([]);
    expect(readsAOutsideFacts(sources)).toEqual([]);
  });
  it("① 反向用例：违规文件必须被护栏抓到，C 自己的表与 facts.ts 的只读引用不算违规", () => {
    const bad: Src[] = [
      { rel: "modules/signals/zz-a.ts", text: "await tx.insert(contents).values(x);" },
      { rel: "modules/signals/zz-b.ts", text: "await tx.update( mediaReferences ).set(y);" },
      { rel: "modules/signals/zz-c.ts", text: "await tx.execute(sql`UPDATE content_snapshots SET title = 'x'`);" },
      { rel: "modules/signals/zz-d.ts", text: "await tx.execute(sql`delete from `comments` where 1`);" },
    ];
    expect(writesA(bad)).toEqual(bad.map((b) => b.rel));
    const ok: Src[] = [
      { rel: "modules/signals/zz-e.ts", text: 'import { signalResults } from "../../db/schema"; await tx.insert(signalResults).values(x); await tx.update(signalTasks).set(y);' },
      { rel: FACTS, text: 'import { contents, comments } from "../../db/schema"; await db.select().from(contents);' },
      { rel: "modules/signals/zz-k.ts", text: "await db.execute(sql`SELECT * FROM signal_results WHERE 1`);" },
    ];
    expect(writesA(ok)).toEqual([]);
    expect(readsAOutsideFacts(ok)).toEqual([]);
    const reads: Src[] = [
      { rel: "modules/signals/zz-f.ts", text: 'import { contents, signalResults } from "../../db/schema";' },
      { rel: "modules/signals/zz-g.ts", text: 'import { type comments as c } from "../../db/schema/content";' },
      { rel: "modules/signals/zz-h.ts", text: 'import * as schema from "../../db/schema";' },
      { rel: "modules/signals/zz-i.ts", text: "await db.execute(sql`SELECT content_id FROM contents WHERE 1`);" },
      { rel: "modules/signals/zz-j.ts", text: "await db.execute(sql`SELECT 1 FROM signal_results r JOIN `content_snapshots` s ON 1`);" },
    ];
    expect(readsAOutsideFacts(reads)).toEqual(reads.map((r) => r.rel));
  });
  it("② 不 import provider-adapter / orchestrator / 采集网关", () => {
    expect(touchesProvider(sources)).toEqual([]);
  });
  it("② 反向用例", () => {
    const bad: Src[] = [
      { rel: "modules/signals/zz-a.ts", text: 'import { decode } from "../provider-adapter";' },
      { rel: "modules/signals/zz-b.ts", text: 'import { claimTask } from "../orchestrator/claim";' },
      { rel: "modules/signals/zz-c.ts", text: 'import { RawCaptureGateway } from "../raw-capture";' },
      { rel: "modules/signals/zz-d.ts", text: 'import { callAndInterpret } from "../raw-capture/interpret";' },
    ];
    expect(touchesProvider(bad)).toEqual(bad.map((b) => b.rel));
    const ok: Src[] = [
      { rel: "modules/signals/zz-e.ts", text: 'import type { Clock, MediaObjectStore } from "../raw-capture"; import type { ObjectStore } from "../raw-capture/ports";' },
      { rel: "modules/signals/zz-f.ts", text: 'import { OssObjectStore } from "../raw-capture/oss-store";' },
    ];
    expect(touchesProvider(ok)).toEqual([]);
  });
  it("③ signals 下的 *.db.test.ts 没有 Promise.all（dev-ci-cadence 第 3 条）", () => {
    expect(dbTests.length).toBeGreaterThan(1);
    expect(dbTests.filter((f) => readFileSync(f, "utf8").includes(PROMISE_ALL)).map(rel)).toEqual([]);
  });
  it("③ 反向用例：扫描条件本身能识别 Promise.all", () => {
    expect(`await ${PROMISE_ALL}[a(), b()])`.includes(PROMISE_ALL)).toBe(true);
    expect("for (const x of xs) await run(x);".includes(PROMISE_ALL)).toBe(false);
  });
  it("④ 网络调用只在 matcher-client；signals 模块里没有模型 SDK 或模型域名", () => {
    expect(strayNetwork(sources)).toEqual([]);
  });
  it("④ 反向用例", () => {
    const bad: Src[] = [
      { rel: "modules/signals/zz-a.ts", text: "const r = await fetch(url);" },
      { rel: "modules/signals/zz-b.ts", text: 'import https from "node:https";' },
      { rel: "modules/signals/zz-c.ts", text: 'import OpenAI from "openai";' },
      { rel: "modules/signals/zz-d.ts", text: 'const BASE = "https://dashscope.aliyuncs.com/api/v1";' },
      { rel: "modules/signals/zz-e.ts", text: 'import { generate } from "@ai-sdk/openai";' },
    ];
    expect(strayNetwork(bad)).toEqual(bad.map((b) => b.rel));
    expect(strayNetwork([{ rel: MATCHER_CLIENT, text: "const r = await fetch(url);" }])).toEqual([]); // 唯一允许的网络出口
    expect(strayNetwork([{ rel: MATCHER_CLIENT, text: 'import OpenAI from "openai";' }])).toEqual([MATCHER_CLIENT]); // 但它也不能调模型
  });
  it("E5：读取路径不引用 ODS 表（特征读取不依赖原始载荷，ODS 一年后清理不影响它）", () => {
    const odsRef = /\bods_\w+|\bods[A-Z]\w*/;
    expect(sources.filter((f) => odsRef.test(f.text)).map((f) => f.rel)).toEqual([]);
    expect(odsRef.test("db.select().from(odsPayloads)")).toBe(true); // 反向：扫描条件本身能识别
  });
});
