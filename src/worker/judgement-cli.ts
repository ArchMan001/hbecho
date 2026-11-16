// CLI：`pnpm judgement <命令>`（design §9）。只调用 Module，不直接写库；输出一行 JSON，BIGINT 一律十进制字符串。
// 退出码：0 成功 / 2 输入、授权 / 3 冲突 / 4 不存在 / 5 超限 / 1 配置与其他（由 exitCodeOf 映射，与 plan-cli 同一套）。
// 没有 --force / --skip-auth 之类的旁路：权限只来自环境变量里的用户身份（HBECHO_JP_ACTOR=user:<id>），
// 由 judgement-main 用 B 的 contextForUser 取该用户当前的 AuthContext，走与页面相同的 authorize。
// 回退 / 取消默认只预览，--apply 才写。
import { parseArgs } from "node:util";
import { constraintOf, type AuthContext } from "../modules/access-control";
import { exitCodeOf, JudgementError } from "../modules/judgement/errors";
import type { Judgement } from "../modules/judgement/assemble";

export interface JudgementCliDeps {
  j: Pick<Judgement, "plans" | "versions" | "runs" | "outcomes" | "claim" | "authz">;
  ctx: AuthContext;
  readFile(path: string): Uint8Array;
  /** 常驻：领取运行 + tick + 每日 maintain；由 judgement-main 装配，直到收到停止信号才返回。 */
  serve?: () => Promise<void>;
  stdout(text: string): void;
  stderr(text: string): void;
  onInternalError?(error: unknown): void;
}
const USAGE = [
  "用法：",
  "  judgement plan create --activity-plan <id> --alias <名> [--description <说明>]",
  "  judgement plan show <planId> | list [--activity-plan <id>] [--status <状态>] | archive|unarchive <planId> | reconcile [--plan <id>]",
  "  judgement config show <planId> [--version <n>] | set <planId> --file <config.json>",
  "  judgement image put <planId> --ability <能力ID> --kind template|element --file <路径> | remove <planId> --ability <能力ID>",
  "  judgement circle <planId> | trial <planId> [--wait] | trial-report <planId>",
  "  judgement rollback <planId> [--apply] | new-draft <planId> [--from <已发布版本>]",
  "  judgement confirm <planId> --key <幂等键> [--apply]   # 无 --apply 只预览：将发布的版本与阻塞项",
  "  judgement execute <planId> --key <幂等键>             # 对最近已发布版本重新执行",
  "  judgement run show <runId> | list --plan <id> | cancel <runId> [--apply] | resume <runId>",
  "  judgement result summary <executionId> | participants <executionId> [--result <结果>] [--limit <n>] | contents <executionId> [--staff <id>] [--final <结果>] [--limit <n>] | circle <runId> [--limit <n>]",
  "  judgement explain --execution <id> (--content <cid> | --staff <sid>)",
  "  judgement serve | maintain --once",
].join("\n");
const bad = (msg: string): never => {
  throw new JudgementError("input", "invalid_input", `${msg}\n${USAGE}`);
};
const id = (v: string | undefined, what: string): bigint => (v !== undefined && /^[1-9]\d*$/.test(v) ? BigInt(v) : bad(`${what}必须是不带前导零的正十进制整数`));
const int = (v: string | undefined, what: string): number | undefined => (v === undefined ? undefined : /^[1-9]\d*$/.test(v) ? Number(v) : bad(`${what}必须是正整数：${v}`));
const one = (positionals: string[], what: string): string => (positionals.length === 1 ? positionals[0]! : bad(`需要且只需要一个${what}`));
const oneOf = <T extends string>(v: string | undefined, allowed: readonly T[], what: string): T => (allowed.includes(v as T) ? (v as T) : bad(`${what}必须是 ${allowed.join(" | ")}`));
/** 列表类输出的上限：避免一行 JSON 无限大；超出时 truncated = true，用过滤条件或 --limit 缩小。 */
const OUTPUT_LIMIT_MAX = 1000;
const OUTPUT_LIMIT_DEFAULT = 100;

export async function runJudgementCli(argv: string[], deps: JudgementCliDeps): Promise<number> {
  const { j, ctx } = deps;
  const print = (v: unknown) => deps.stdout(`${JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? x.toString() : x))}\n`);
  const done = (v: unknown): number => (print({ ok: true, ...(v as object) }), 0);
  const fail = (e: JudgementError): number => {
    print({ ok: false, error: { code: e.code, message: e.message, ...(e.detail === undefined ? {} : { detail: e.detail }) } });
    return exitCodeOf(e);
  };
  const parse = <O extends Record<string, { type: "string" | "boolean" }>>(args: string[], options: O = {} as O, allowPositionals = true) => parseArgs({ args, strict: true, allowPositionals, options });
  const limitOf = (v: string | undefined): number => Math.min(int(v, "--limit") ?? OUTPUT_LIMIT_DEFAULT, OUTPUT_LIMIT_MAX);
  async function take<T>(gen: AsyncIterable<T>, limit: number, keep: (x: T) => boolean = () => true): Promise<{ rows: T[]; truncated: boolean }> {
    const rows: T[] = [];
    for await (const x of gen) {
      if (!keep(x)) continue;
      if (rows.length === limit) return { rows, truncated: true };
      rows.push(x);
    }
    return { rows, truncated: false };
  }
  /** 取执行（或运行）所属判定计划并按「读」授权：越范围表现为未找到。 */
  const authorizeRun = (runId: bigint) => j.runs.show(ctx, runId);
  try {
    const [cmd, sub, ...tail] = argv;
    // 不带子命令的命令：sub 其实是第一个参数
    const flat = (): string[] => [sub, ...tail].filter((x): x is string => x !== undefined);
    switch (cmd) {
      case "plan": {
        const rest = tail;
        switch (sub) {
          case "create": {
            const { values } = parse(rest, { "activity-plan": { type: "string" }, alias: { type: "string" }, description: { type: "string" } }, false);
            if (!values.alias) bad("需要 --activity-plan 和 --alias");
            return done(await j.plans.create(ctx, { activityPlanId: id(values["activity-plan"], "--activity-plan"), alias: values.alias!, ...(values.description === undefined ? {} : { description: values.description }) }));
          }
          case "show": return done(await j.plans.show(ctx, id(one(parse(rest, {}).positionals, "判定计划 ID"), "判定计划 ID")));
          case "list": {
            const { values } = parse(rest, { "activity-plan": { type: "string" }, status: { type: "string" } }, false);
            const status = values.status === undefined ? undefined : oneOf(values.status, ["provisioning", "active", "archived"] as const, "--status");
            return done({ plans: await j.plans.list(ctx, { ...(values["activity-plan"] === undefined ? {} : { activityPlanId: id(values["activity-plan"], "--activity-plan") }), ...(status === undefined ? {} : { status }) }) });
          }
          case "archive":
          case "unarchive": {
            const planId = id(one(parse(rest, {}).positionals, "判定计划 ID"), "判定计划 ID");
            await (sub === "archive" ? j.plans.archive(ctx, planId) : j.plans.unarchive(ctx, planId));
            return done({ planId, archived: sub === "archive" });
          }
          case "reconcile": {
            const { values } = parse(rest, { plan: { type: "string" } }, false);
            return done(await j.plans.reconcile(ctx, values.plan === undefined ? undefined : id(values.plan, "--plan")));
          }
          default: return bad("未知的 plan 子命令");
        }
      }
      case "config": {
        switch (sub) {
          case "show": {
            const { values, positionals } = parse(tail, { version: { type: "string" } });
            return done(await j.versions.showConfig(ctx, id(one(positionals, "判定计划 ID"), "判定计划 ID"), int(values.version, "--version")));
          }
          case "set": {
            const { values, positionals } = parse(tail, { file: { type: "string" } });
            if (!values.file) bad("需要 --file");
            let raw: unknown;
            try {
              raw = JSON.parse(Buffer.from(deps.readFile(values.file!)).toString("utf8"));
            } catch (e) {
              if ((e as { code?: string }).code === "ENOENT") throw new JudgementError("input", "file_not_found", "找不到指定文件");
              throw new JudgementError("input", "config_not_json", "配置文件不是合法的 JSON");
            }
            return done(await j.versions.setConfig(ctx, id(one(positionals, "判定计划 ID"), "判定计划 ID"), raw));
          }
          default: return bad("未知的 config 子命令");
        }
      }
      case "image": {
        switch (sub) {
          case "put": {
            const { values, positionals } = parse(tail, { ability: { type: "string" }, kind: { type: "string" }, file: { type: "string" } });
            if (!values.ability || !values.file) bad("需要 --ability --kind --file");
            const kind = oneOf(values.kind, ["template", "element"] as const, "--kind");
            const planId = id(one(positionals, "判定计划 ID"), "判定计划 ID");
            let bytes: Uint8Array;
            try {
              bytes = deps.readFile(values.file!);
            } catch {
              throw new JudgementError("input", "file_not_found", "找不到指定文件");
            }
            return done(kind === "template" ? await j.versions.putTemplate(ctx, planId, values.ability!, bytes) : await j.versions.putElement(ctx, planId, values.ability!, bytes));
          }
          case "remove": {
            const { values, positionals } = parse(tail, { ability: { type: "string" } });
            if (!values.ability) bad("需要 --ability");
            const planId = id(one(positionals, "判定计划 ID"), "判定计划 ID");
            await j.versions.removeImage(ctx, planId, values.ability!);
            return done({ planId, abilityId: values.ability });
          }
          default: return bad("未知的 image 子命令");
        }
      }
      case "circle": return done({ circle: await j.runs.circle(ctx, id(one(parse(flat()).positionals, "判定计划 ID"), "判定计划 ID")) });
      case "trial": {
        const { values, positionals } = parse(flat(), { wait: { type: "boolean" } });
        return done(await j.runs.trial(ctx, id(one(positionals, "判定计划 ID"), "判定计划 ID"), { wait: values.wait === true }));
      }
      case "trial-report": return done(await j.runs.trialReport(ctx, id(one(parse(flat()).positionals, "判定计划 ID"), "判定计划 ID")));
      case "rollback": {
        const { values, positionals } = parse(flat(), { apply: { type: "boolean" } });
        const r = await j.versions.rollback(ctx, id(one(positionals, "判定计划 ID"), "判定计划 ID"), { apply: values.apply === true });
        return done({ ...r, apply: values.apply === true });
      }
      case "new-draft": {
        const { values, positionals } = parse(flat(), { from: { type: "string" } });
        return done(await j.versions.newDraft(ctx, id(one(positionals, "判定计划 ID"), "判定计划 ID"), int(values.from, "--from")));
      }
      case "confirm":
      case "execute": {
        const { values, positionals } = parse(flat(), { key: { type: "string" }, apply: { type: "boolean" } });
        const planId = id(one(positionals, "判定计划 ID"), "判定计划 ID");
        await j.plans.show(ctx, planId); // 授权与存在性（越范围表现为未找到）
        const draft = await j.versions.draftOf(planId);
        if (cmd === "confirm") {
          if (!draft) throw new JudgementError("conflict", "no_draft", "没有可确认的草稿；要对已发布版本重新执行请用 execute");
          if (values.apply !== true) return done({ apply: false, preview: await j.versions.previewPublish(ctx, planId) });
        } else if (draft) {
          throw new JudgementError("conflict", "draft_exists", "有未确认的草稿；请先 confirm，或回退草稿");
        }
        if (!values.key?.trim()) bad("需要 --key <幂等键>");
        return done({ apply: true, ...(await j.runs.execute(ctx, planId, { key: values.key! })) });
      }
      case "run": {
        switch (sub) {
          case "show": return done({ run: await j.runs.show(ctx, id(one(parse(tail).positionals, "运行 ID"), "运行 ID")) });
          case "list": {
            const { values } = parse(tail, { plan: { type: "string" } }, false);
            return done({ runs: await j.runs.list(ctx, id(values.plan, "--plan")) });
          }
          case "cancel": {
            const { values, positionals } = parse(tail, { apply: { type: "boolean" } });
            const runId = id(one(positionals, "运行 ID"), "运行 ID");
            const run = await j.runs.show(ctx, runId);
            if (values.apply !== true) return done({ apply: false, run, wouldCancel: ["planned", "running", "waiting"].includes(run.status) });
            return done({ apply: true, runId, cancelled: await j.runs.cancel(ctx, runId) });
          }
          case "resume": {
            const runId = id(one(parse(tail).positionals, "运行 ID"), "运行 ID");
            return done({ runId, resumed: await j.runs.resume(ctx, runId) });
          }
          default: return bad("未知的 run 子命令");
        }
      }
      case "result": {
        const scope = constraintOf(ctx.scope);
        switch (sub) {
          case "summary": {
            const executionId = id(one(parse(tail).positionals, "执行 ID"), "执行 ID");
            await authorizeRun(executionId);
            return done({ execution: await j.outcomes.describe(executionId) });
          }
          case "participants": {
            const { values, positionals } = parse(tail, { result: { type: "string" }, limit: { type: "string" } });
            const executionId = id(one(positionals, "执行 ID"), "执行 ID");
            const want = values.result === undefined ? undefined : oneOf(values.result, ["success", "not_met", "unobtained"] as const, "--result");
            await authorizeRun(executionId);
            return done(await take(j.outcomes.streamParticipants(executionId, scope), limitOf(values.limit), (p) => want === undefined || p.results.plan === want));
          }
          case "contents": {
            const { values, positionals } = parse(tail, { staff: { type: "string" }, final: { type: "string" }, limit: { type: "string" } });
            const executionId = id(one(positionals, "执行 ID"), "执行 ID");
            const staff = values.staff === undefined ? undefined : id(values.staff, "--staff");
            const final = values.final === undefined ? undefined : oneOf(values.final, ["pass", "fail", "unobtained", "skipped"] as const, "--final");
            await authorizeRun(executionId);
            // 内容行带账号不带专员：先按冻结的参与专员找到该专员的账号
            let account: bigint | null | undefined;
            if (staff !== undefined) {
              account = null;
              for await (const p of j.outcomes.streamParticipants(executionId, scope)) if (p.staffId === staff) account = p.accountId;
            }
            return done(await take(j.outcomes.streamContents(executionId, scope), limitOf(values.limit), (c) => (final === undefined || c.final === final) && (account === undefined || c.accountId === account)));
          }
          case "circle": {
            const { values, positionals } = parse(tail, { limit: { type: "string" } });
            const runId = id(one(positionals, "圈定运行 ID"), "圈定运行 ID");
            await authorizeRun(runId);
            return done(await take(j.outcomes.streamCircleRows(runId, scope), limitOf(values.limit)));
          }
          default: return bad("未知的 result 子命令");
        }
      }
      case "explain": {
        const { values } = parse(sub === undefined ? [] : [sub, ...tail], { execution: { type: "string" }, content: { type: "string" }, staff: { type: "string" } }, false);
        if ((values.content === undefined) === (values.staff === undefined)) bad("--content 与 --staff 必须二选一");
        const target = values.content !== undefined ? { contentId: id(values.content, "--content") } : { staffId: id(values.staff, "--staff") };
        return done({ explanation: await j.outcomes.explain(ctx, id(values.execution, "--execution"), target) });
      }
      case "maintain": {
        const { values } = parse(flat(), { once: { type: "boolean" } }, false);
        if (values.once !== true) bad("maintain 目前只支持 --once（常驻驱动在 serve 里）");
        await j.authz.require(ctx, "manage");
        return done({ report: await j.outcomes.maintain() });
      }
      case "serve": {
        parse(flat(), {}, false);
        if (!deps.serve) throw new JudgementError("configuration", "serve_not_wired", "常驻驱动未装配");
        await j.authz.require(ctx, "manage");
        await deps.serve();
        return done({ stopped: true });
      }
      default:
        return bad(cmd === undefined ? "需要子命令" : "未知命令");
    }
  } catch (e) {
    if (e instanceof JudgementError) return fail(e);
    if (e instanceof TypeError && String((e as { code?: string }).code).startsWith("ERR_PARSE_ARGS")) return fail(new JudgementError("input", "invalid_input", `${e.message}\n${USAGE}`));
    deps.onInternalError?.(e);
    print({ ok: false, error: { code: "internal_error", message: "内部错误，详见服务端日志" } });
    deps.stderr(`internal_error (${e instanceof Error ? e.name : typeof e})\n`);
    return 1;
  }
}
