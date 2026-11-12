// CLI：`pnpm signals <命令>`（design §9）。只调用 Module，不直接读写库；输出 JSON，BIGINT 一律十进制字符串，不含内容原文。
// 退出码：0 成功 / 2 输入、授权 / 3 冲突 / 4 不存在 / 5 超限 / 1 配置与其他错误（与 plan-cli 一致）。
// 没有 --force、--skip-auth、recompute --all 之类的旁路：权限边界只来自环境变量身份（HBECHO_SIG_*，缺任一项启动失败）。
import { parseArgs } from "node:util";
import {
  CAP_ACCOUNT_READ,
  CAP_CONTENT_READ,
  CAP_SCORE_REQUEST,
  CAP_SEGMENT_MANAGE,
  CATALOG,
  SignalError,
  assert,
  capabilityOf,
  platformSignals,
  versionOf,
  type SignalActor,
  type Signals,
  type Subject,
} from "../modules/signals";

export interface SignalsCliDeps {
  signals: Pick<Signals, "config" | "reader" | "segments" | "requestScores" | "recompute" | "scanner" | "retention" | "tasks">;
  actor: SignalActor;
  /** 读本地文件（标准图、ID 清单）。 */
  readFile(path: string): Uint8Array;
  /** 常驻循环；只有 `signals run` 需要，main 负责接停止信号。 */
  run?(): Promise<void>;
  stdout(text: string): void;
  stderr(text: string): void;
  onInternalError?(error: unknown): void;
}

const USAGE = [
  "用法：",
  "  signals catalog [--object content|account|comment] [--platform douyin|xiaohongshu|kuaishou]",
  "  signals show --content <ID> | --account <ID> | --comment <ID> [--plan <ID> --version <n>]   # 带监控段时一并读取其参数化信号",
  "  signals segment create --plan <ID> --platform <平台> | show|check|publish --plan <ID> --version <n> | new-draft --plan <ID> --from-version <n> | purge --plan <ID> --apply",
  "  signals segment set-items --plan <ID> --version <n> --items '<JSON 数组>'",
  "  signals segment put-image --plan <ID> --version <n> --kind template|element --target cover|background|avatar [--element-key <键>] --file <路径>",
  "  signals segment remove-image --plan <ID> --version <n> --kind template|element --target cover|background|avatar [--element-key <键>]",
  "  signals score --plan <ID> --version <n> (--contents <ID,ID|文件> | --accounts <ID,ID|文件>)",
  "  signals recompute preview|apply --signal <信号键> --scope '<JSON>'     # scope 键：contentIds accountIds brandCode publishedFrom publishedTo segmentRef",
  "  signals recompute cancel --run <ID>",
  "  signals scan --once | reconcile --once | retention --once",
  "  signals tasks list [--status <状态>] [--limit <n>] | revive <taskId>",
  "  signals run",
].join("\n");
const EXIT: Record<SignalError["category"], number> = { input: 2, authorization: 2, conflict: 3, not_found: 4, limit: 5, configuration: 1 };
const bad = (msg: string): never => {
  throw new SignalError("input", "invalid_input", `${msg}\n${USAGE}`);
};
const id = (v: string | undefined, what: string): bigint => (v !== undefined && /^[1-9]\d*$/.test(v) ? BigInt(v) : bad(`${what}必须是不带前导零的正十进制整数`));
const int = (v: string | undefined, what: string): number => (v !== undefined && /^[1-9]\d*$/.test(v) && Number.isSafeInteger(Number(v)) ? Number(v) : bad(`${what}必须是正整数`));
const oneOf = <T extends string>(v: string | undefined, allowed: readonly T[], what: string): T => (allowed as readonly string[]).includes(v ?? "") ? (v as T) : bad(`${what}只能是 ${allowed.join("、")}`);
const tally = (xs: Iterable<string>): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const x of xs) out[x] = (out[x] ?? 0) + 1;
  return out;
};
const SCOPE_KEYS = ["contentIds", "accountIds", "brandCode", "publishedFrom", "publishedTo", "segmentRef"];

export async function runSignalsCli(argv: string[], deps: SignalsCliDeps): Promise<number> {
  const { signals, actor } = deps;
  const print = (v: unknown) => deps.stdout(`${JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? x.toString() : x))}\n`);
  const done = (v: object): number => (print({ ok: true, ...v }), 0);
  const fail = (e: SignalError): number => {
    print({ ok: false, error: { code: e.code, message: e.message, ...(e.detail === undefined ? {} : { detail: e.detail }) } });
    return EXIT[e.category];
  };
  const parse = <O extends Record<string, { type: "string" | "boolean" }>>(args: string[], options: O, allowPositionals = false) => parseArgs({ args, strict: true, allowPositionals, options });
  /** ID 清单：纯数字与逗号按字面解析，否则当文件路径读（逗号或空白分隔）。 */
  const idList = (v: string, what: string): bigint[] => {
    const text = /^[\d,\s]+$/.test(v) ? v : new TextDecoder().decode(deps.readFile(v));
    const ids = text.split(/[\s,]+/).filter(Boolean);
    return ids.length === 0 ? bad(`${what}是空的`) : ids.map((x) => id(x, what));
  };
  const segKey = (values: { plan?: string | undefined; version?: string | undefined }) => ({ planId: id(values.plan, "--plan"), version: int(values.version, "--version") });
  const imageKey = (values: { plan?: string | undefined; version?: string | undefined; kind?: string | undefined; target?: string | undefined; "element-key"?: string | undefined }) => ({
    ...segKey(values),
    kind: oneOf(values.kind, ["template", "element"], "--kind"),
    target: oneOf(values.target, ["cover", "background", "avatar"], "--target"),
    ...(values["element-key"] === undefined ? {} : { elementKey: values["element-key"] }),
  });
  const IMAGE_OPTS = { plan: { type: "string" }, version: { type: "string" }, kind: { type: "string" }, target: { type: "string" }, "element-key": { type: "string" } } as const;
  try {
    const [cmd, ...rest] = argv;
    switch (cmd) {
      case "catalog": {
        const { values } = parse(rest, { object: { type: "string" }, platform: { type: "string" } });
        if (values.object !== undefined && !["content", "account", "comment"].includes(values.object)) bad("--object 只能是 content、account、comment");
        const allowed = values.platform === undefined ? undefined : new Set(platformSignals(values.platform));
        const enabled = signals.config.enabled;
        const list = CATALOG.filter((e) => (values.object === undefined || e.object === values.object) && (allowed === undefined || allowed.has(e.key))).map((e) => {
          const platforms = values.platform === undefined ? e.platforms : [values.platform];
          return {
            signal: e.key,
            object: e.object,
            scope: e.scope,
            costTier: e.costTier,
            storage: e.storage,
            platforms: e.platforms,
            // 能力标识含平台时逐平台列出
            capabilities: [...new Set(platforms.map((p) => capabilityOf(e, p)))].map((c) => ({ id: c, version: versionOf(c), enabled: enabled.has(c) })),
          };
        });
        return done({ signals: list });
      }
      case "show": {
        const { values } = parse(rest, { content: { type: "string" }, account: { type: "string" }, comment: { type: "string" }, plan: { type: "string" }, version: { type: "string" } });
        const given = (["content", "account", "comment"] as const).filter((k) => values[k] !== undefined);
        if (given.length !== 1) bad("需要且只需要 --content、--account、--comment 之一");
        if ((values.plan === undefined) !== (values.version === undefined)) bad("--plan 与 --version 要一起给");
        const kind = given[0]!;
        const subject: Subject = { kind, id: id(values[kind], `--${kind}`) };
        const requires = kind === "account" ? CAP_ACCOUNT_READ : CAP_CONTENT_READ;
        assert(actor, requires); // 先于任何读库
        // 参数化信号需要监控段里的图片 / 判定项才能读：给了 --plan --version 就按该监控段的条目读，否则只列出它们的名字
        const segment = values.plan === undefined ? undefined : segKey(values);
        const items = segment === undefined ? [] : (await signals.segments.show(actor, segment)).items;
        const entries = CATALOG.filter((e) => e.object === kind);
        const list = [];
        const needParam: string[] = [];
        for (const e of entries) {
          if (e.scope !== "parameterized") {
            list.push({ signal: e.key, ...(await signals.reader.read(actor, subject, e.key, { requires })) });
          } else if (segment === undefined) {
            needParam.push(e.key);
          } else {
            for (const it of items.filter((i) => i.signal === e.key)) {
              const param = { segment, ...(it.element_key === undefined ? {} : { elementKey: it.element_key }) };
              list.push({ signal: e.key, ...(it.element_key === undefined ? {} : { elementKey: it.element_key }), ...(await signals.reader.read(actor, subject, e.key, { requires, param })) });
            }
          }
        }
        return done({ subject, ...(segment === undefined ? {} : { segment }), signals: list, requiresParam: needParam });
      }
      case "segment": {
        const [sub, ...args] = rest;
        const seg = signals.segments;
        switch (sub) {
          case "create": {
            const { values } = parse(args, { plan: { type: "string" }, platform: { type: "string" } });
            return done({ segment: await seg.create(actor, { planId: id(values.plan, "--plan"), platform: values.platform ?? bad("需要 --platform") }) });
          }
          case "set-items": {
            const { values } = parse(args, { plan: { type: "string" }, version: { type: "string" }, items: { type: "string" } });
            let items: unknown;
            try {
              items = JSON.parse(values.items ?? bad("需要 --items"));
            } catch {
              bad("--items 不是合法 JSON");
            }
            return done({ items: await seg.setItems(actor, segKey(values), items) });
          }
          case "put-image": {
            const { values } = parse(args, { ...IMAGE_OPTS, file: { type: "string" } });
            const key = imageKey(values); // 先校验参数，再读文件
            const bytes = deps.readFile(values.file ?? bad("需要 --file"));
            return done({ image: await seg.putImage(actor, key, bytes) });
          }
          case "remove-image": {
            const { values } = parse(args, IMAGE_OPTS);
            await seg.removeImage(actor, imageKey(values));
            return done({});
          }
          case "show": {
            const { values } = parse(args, { plan: { type: "string" }, version: { type: "string" } });
            return done({ segment: await seg.show(actor, segKey(values)) });
          }
          case "check": {
            const { values } = parse(args, { plan: { type: "string" }, version: { type: "string" } });
            return done({ executability: await seg.executability(actor, segKey(values)) });
          }
          case "publish": {
            const { values } = parse(args, { plan: { type: "string" }, version: { type: "string" } });
            await seg.publish(actor, segKey(values));
            return done({});
          }
          case "new-draft": {
            const { values } = parse(args, { plan: { type: "string" }, "from-version": { type: "string" } });
            return done({ segment: await seg.newDraft(actor, { planId: id(values.plan, "--plan"), fromVersion: int(values["from-version"], "--from-version") }) });
          }
          case "purge": {
            // 删除该计划的所有版本与标准图对象，不可恢复：没有预览能力，所以必须显式 --apply
            const { values } = parse(args, { plan: { type: "string" }, apply: { type: "boolean" } });
            const planId = id(values.plan, "--plan");
            if (!values.apply) bad("purge 会删除该计划所有版本的监控段与标准图，不可恢复；确认后加 --apply");
            return done(await seg.purge(actor, planId));
          }
          default:
            return bad(sub === undefined ? "segment 缺少子命令" : `未知的 segment 子命令：${sub}`);
        }
      }
      case "score": {
        const { values } = parse(rest, { plan: { type: "string" }, version: { type: "string" }, contents: { type: "string" }, accounts: { type: "string" } });
        if ((values.contents === undefined) === (values.accounts === undefined)) bad("需要且只需要 --contents、--accounts 之一");
        const kind = values.contents !== undefined ? "content" : "account";
        const subjects: Subject[] = idList(values.contents ?? values.accounts!, `--${kind}s`).map((i) => ({ kind, id: i }));
        const r = await signals.requestScores(actor, segKey(values), subjects, { caller: actor.actor });
        return done({
          tasks: r.tasks,
          items: r.items.map((it) => ({
            signal: it.signal,
            ...(it.elementKey === undefined ? {} : { elementKey: it.elementKey }),
            dispositions: tally(it.subjects.map((s) => s.disposition)),
            reasons: tally(it.subjects.flatMap((s) => (s.reason === undefined ? [] : [s.reason]))),
          })),
          needMedia: r.needMedia,
        });
      }
      case "recompute": {
        const [sub, ...args] = rest;
        if (sub === "cancel") {
          const { values } = parse(args, { run: { type: "string" } });
          await signals.recompute.cancel(actor, { runId: id(values.run, "--run") });
          return done({});
        }
        if (sub !== "preview" && sub !== "apply") return bad(sub === undefined ? "recompute 缺少子命令" : `未知的 recompute 子命令：${sub}`);
        const { values } = parse(args, { signal: { type: "string" }, scope: { type: "string" } });
        let scope: unknown;
        try {
          scope = JSON.parse(values.scope ?? bad("需要 --scope（没有“全部”选项）"));
        } catch {
          bad("--scope 不是合法 JSON");
        }
        if (typeof scope !== "object" || scope === null || Array.isArray(scope)) bad("--scope 必须是 JSON 对象");
        const extra = Object.keys(scope as object).filter((k) => !SCOPE_KEYS.includes(k));
        if (extra.length > 0) bad(`--scope 含未知键：${extra.join("、")}`);
        const input = { signal: values.signal ?? bad("需要 --signal"), scope: scope as Parameters<typeof signals.recompute.preview>[1]["scope"] };
        return done(sub === "preview" ? { preview: await signals.recompute.preview(actor, input) } : { run: await signals.recompute.apply(actor, input) });
      }
      case "scan":
      case "reconcile":
      case "retention": {
        const { values } = parse(rest, { once: { type: "boolean" } });
        if (!values.once) bad(`需要 --once（常驻运行用 signals run）`);
        assert(actor, CAP_SEGMENT_MANAGE); // 运维入口；实际执行用固定服务身份，不经用户范围
        if (cmd === "scan") return done({ contents: await signals.scanner.contents(), comments: await signals.scanner.comments() });
        if (cmd === "reconcile") return done({ reconcile: await signals.scanner.reconcile() });
        return done({ retention: await signals.retention.purgeExpired() });
      }
      case "tasks": {
        const [sub, ...args] = rest;
        if (sub === "list") {
          const { values } = parse(args, { status: { type: "string" }, limit: { type: "string" } });
          const tasks = await signals.tasks.list(actor, { ...(values.status === undefined ? {} : { status: values.status }), limit: values.limit === undefined ? 50 : int(values.limit, "--limit") });
          return done({ tasks });
        }
        if (sub === "revive") {
          const { positionals } = parse(args, {}, true);
          if (positionals.length !== 1) bad("需要且只需要一个 taskId");
          await signals.tasks.revive(actor, id(positionals[0], "taskId"));
          return done({});
        }
        return bad(sub === undefined ? "tasks 缺少子命令" : `未知的 tasks 子命令：${sub}`);
      }
      case "run": {
        parse(rest, {});
        if (!deps.run) throw new SignalError("configuration", "run_unavailable", "当前装配不支持常驻运行");
        assert(actor, CAP_SEGMENT_MANAGE);
        await deps.run();
        return 0;
      }
      default:
        return bad(cmd === undefined ? "缺少命令" : `未知命令：${cmd}`);
    }
  } catch (e) {
    if (e instanceof SignalError) return fail(e);
    if (e instanceof TypeError && (e as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) return fail(new SignalError("input", "invalid_input", `${e.message}\n${USAGE}`));
    deps.onInternalError?.(e);
    deps.stderr(`内部错误：${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}
