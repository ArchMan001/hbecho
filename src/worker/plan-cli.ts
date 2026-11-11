// CLI：`pnpm plan <命令>`（design §9）。只调用 Module，不直接写库；输出 JSON，BIGINT 一律十进制字符串。
// 退出码：0 成功 / 2 输入、授权 / 3 冲突 / 4 不存在 / 5 超限（含超过时间上限） / 1 配置与其他错误。
// 没有 --skip-auth、--force 之类的旁路：权限边界只来自服务身份（环境变量 HBECHO_AP_*，缺任一项启动失败）。
// 影响多个对象的命令（delete、branch exit、roster remove、owner assign / replace）默认只预览，--apply 才写。
import { parseArgs } from "node:util";
import { ROSTER_HEADER } from "../modules/activity-plan/constants";
import { PlanError } from "../modules/activity-plan/errors";
import { buildTemplate, TEMPLATE_GUIDE } from "../modules/activity-plan/roster/template";
import type { ActivityPlan, PlanActor } from "../modules/activity-plan";

export interface PlanCliDeps {
  ap: ActivityPlan;
  actor: PlanActor;
  readFile(path: string): Uint8Array;
  writeFile(path: string, content: string): void;
  /** 分公司编码 → ID；不存在抛 PlanError(not_found) */
  branchIdOf(code: string): Promise<bigint>;
  stdout(text: string): void;
  stderr(text: string): void;
  onInternalError?(error: unknown): void;
}

const USAGE = [
  "用法：",
  "  plan create --brand <编码> --platform <平台> --name <名称> --starts-on <YYYY-MM-DD> [--ends-on <日期>] [--description <说明>] [--sectors water,home]",
  "  plan edit <计划ID> [--name <名称>] [--description <说明>] [--starts-on <日期>] [--ends-on <日期>|--no-ends-on]",
  "  plan show <计划ID> | list [--status <状态>] [--platform <平台>] [--brand <编码>]",
  "  plan pause|archive|resume <计划ID>",
  "  plan delete <计划ID> [--apply] | restore <计划ID> | trash",
  "  plan branch join <计划ID> --branch <分公司编码> | exit <计划ID> --branch <分公司编码> [--apply]",
  "  plan owner list <计划ID> [--branch <编码>] | assign|replace <计划ID> --branch <编码> --owner <主体> [--name <姓名>] [--slot 1|2] [--apply]",
  "  plan roster template [--out <csv>]",
  "  plan roster precheck <计划ID> --file <csv> [--branch <编码>] | confirm --batch <ID>",
  "  plan roster batches [--plan <ID>] | batch <ID> | rows <ID> [--class <类>] [--outcome <结果>] | report <ID> --out <csv>",
  "  plan roster list <计划ID> [--state in_roster|removed] | remove <计划ID> (--account <ID>... | --staff <ID>...) [--apply]",
  "  plan account confirm-empty <账号ID>",
  "  plan resolve --once | maintain",
].join("\n");

const EXIT: Record<PlanError["category"], number> = { input: 2, authorization: 2, conflict: 3, not_found: 4, limit: 5, configuration: 1 };
const bad = (msg: string): never => {
  throw new PlanError("input", "invalid_input", `${msg}\n${USAGE}`);
};
const id = (v: string | undefined, what: string): bigint => (v !== undefined && /^[1-9]\d*$/.test(v) ? BigInt(v) : bad(`${what}必须是不带前导零的正十进制整数`));
const num = (v: string | undefined, what: string): number | undefined => (v === undefined ? undefined : /^\d+$/.test(v) ? Number(v) : bad(`${what}不是非负整数：${v}`));
const one = (positionals: string[], what: string): string => (positionals.length === 1 ? positionals[0]! : bad(`需要且只需要一个${what}`));

export async function runPlanCli(argv: string[], deps: PlanCliDeps): Promise<number> {
  const { ap, actor } = deps;
  const print = (v: unknown) => deps.stdout(`${JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? x.toString() : x))}\n`);
  const done = (v: unknown): number => (print({ ok: true, ...(v as object) }), 0);
  const fail = (e: PlanError): number => {
    print({ ok: false, error: { code: e.code, message: e.message, ...(e.detail === undefined ? {} : { detail: e.detail }) } });
    return EXIT[e.category];
  };
  const parse = <O extends Record<string, { type: "string" | "boolean"; multiple?: boolean }>>(args: string[], options: O, allowPositionals = true) =>
    parseArgs({ args, strict: true, allowPositionals, options });
  try {
    const [cmd, ...rest] = argv;
    switch (cmd) {
      case "create": {
        const { values } = parse(rest, { brand: { type: "string" }, platform: { type: "string" }, name: { type: "string" }, description: { type: "string" }, "starts-on": { type: "string" }, "ends-on": { type: "string" }, sectors: { type: "string" } }, false);
        if (!values.brand || !values.platform || !values.name || !values["starts-on"]) bad("需要 --brand --platform --name --starts-on");
        const r = await ap.plans.create(actor, {
          brand: values.brand!,
          platform: values.platform!,
          name: values.name!,
          startsOn: values["starts-on"]!,
          ...(values.description === undefined ? {} : { description: values.description }),
          ...(values["ends-on"] === undefined ? {} : { endsOn: values["ends-on"] }),
          ...(values.sectors === undefined ? {} : { sectors: values.sectors.split(",").map((s) => s.trim()).filter(Boolean) }),
        });
        return done({ plan: r.plan, required: r.required });
      }
      case "edit": {
        // brand / platform / sectors 故意收下再交给 Module 拒绝：命令行带这些参数得到 immutable_field，而不是「未知选项」
        const { values, positionals } = parse(rest, { name: { type: "string" }, description: { type: "string" }, "starts-on": { type: "string" }, "ends-on": { type: "string" }, "no-ends-on": { type: "boolean" }, brand: { type: "string" }, platform: { type: "string" }, sectors: { type: "string" } });
        const patch: Record<string, unknown> = {};
        if (values.name !== undefined) patch.name = values.name;
        if (values.description !== undefined) patch.description = values.description;
        if (values["starts-on"] !== undefined) patch.startsOn = values["starts-on"];
        if (values["ends-on"] !== undefined) patch.endsOn = values["ends-on"];
        if (values["no-ends-on"]) patch.endsOn = null;
        for (const k of ["brand", "platform", "sectors"] as const) if (values[k] !== undefined) patch[k] = values[k];
        return done(await ap.plans.edit(actor, id(one(positionals, "计划 ID"), "计划 ID"), patch));
      }
      case "show": {
        const { positionals } = parse(rest, {});
        return done({ plan: await ap.query.planDetail(actor, id(one(positionals, "计划 ID"), "计划 ID")) });
      }
      case "list": {
        const { values } = parse(rest, { status: { type: "string" }, platform: { type: "string" }, brand: { type: "string" } }, false);
        return done({ plans: await ap.query.listPlans(actor, { ...(values.status ? { status: values.status } : {}), ...(values.platform ? { platform: values.platform } : {}), ...(values.brand ? { brand: values.brand } : {}) }) });
      }
      case "pause":
      case "archive":
      case "resume": {
        const { positionals } = parse(rest, {});
        return done(await ap.plans.setStatus(actor, id(one(positionals, "计划 ID"), "计划 ID"), cmd));
      }
      case "delete": {
        const { values, positionals } = parse(rest, { apply: { type: "boolean" } });
        return done(await ap.plans.delete(actor, id(one(positionals, "计划 ID"), "计划 ID"), { apply: values.apply === true }));
      }
      case "restore": {
        const { positionals } = parse(rest, {});
        return done(await ap.plans.restore(actor, id(one(positionals, "计划 ID"), "计划 ID")));
      }
      case "trash":
        return done({ plans: await ap.plans.trash(actor) });
      case "branch": {
        const [sub, ...args] = rest;
        const { values, positionals } = parse(args, { branch: { type: "string" }, apply: { type: "boolean" } });
        if (sub !== "join" && sub !== "exit") bad("未知子命令");
        if (!values.branch) bad("需要 --branch");
        const planId = id(one(positionals, "计划 ID"), "计划 ID");
        const branchId = await deps.branchIdOf(values.branch!);
        return done(sub === "join" ? await ap.participation.join(actor, planId, branchId) : await ap.participation.exit(actor, planId, branchId, { apply: values.apply === true }));
      }
      case "owner": {
        const [sub, ...args] = rest;
        const { values, positionals } = parse(args, { branch: { type: "string" }, owner: { type: "string" }, name: { type: "string" }, slot: { type: "string" }, apply: { type: "boolean" } });
        const planId = id(one(positionals, "计划 ID"), "计划 ID");
        if (sub === "list") return done({ owners: await ap.owners.list(actor, planId, values.branch ? await deps.branchIdOf(values.branch) : undefined) });
        if (sub !== "assign" && sub !== "replace") bad("未知子命令");
        if (!values.branch || !values.owner) bad("需要 --branch 与 --owner");
        const slotNo = values.slot === undefined ? undefined : Number(values.slot);
        if (sub === "replace" && slotNo === undefined) bad("replace 需要 --slot");
        const a = { planId, branchId: await deps.branchIdOf(values.branch!), owner: values.owner!, ...(values.name ? { displayName: values.name } : {}), apply: values.apply === true };
        return done(sub === "assign" ? await ap.owners.assign(actor, { ...a, ...(slotNo === undefined ? {} : { slotNo }) }) : await ap.owners.replace(actor, { ...a, slotNo: slotNo! }));
      }
      case "roster":
        return await rosterCommand(rest);
      case "account": {
        const [sub, ...args] = rest;
        const { positionals } = parse(args, {});
        if (sub !== "confirm-empty") bad("未知子命令");
        return done(await ap.roster.maintenance.confirmEmpty(actor, id(one(positionals, "账号 ID"), "账号 ID")));
      }
      case "resolve": {
        const { values } = parse(rest, { once: { type: "boolean" } }, false);
        if (!values.once) bad("resolve 目前只支持 --once（常驻驱动在 sync worker 里）");
        if (!ap.roster.resolver) throw new PlanError("configuration", "resolver_not_wired", "名单解析驱动未装配（需要真实 worker 配置，且有已批准的 capability）");
        return done({ report: await ap.roster.resolver.runOnce() });
      }
      case "maintain":
        return done({ report: await ap.maintenance.runNow() });
      default:
        return bad("未知子命令");
    }
  } catch (e) {
    if (e instanceof PlanError) return fail(e);
    if (e instanceof TypeError && String((e as { code?: string }).code).startsWith("ERR_PARSE_ARGS")) return fail(new PlanError("input", "invalid_input", `${e.message}\n${USAGE}`));
    if ((e as { code?: string }).code === "ENOENT") return fail(new PlanError("input", "file_not_found", "找不到指定文件"));
    deps.onInternalError?.(e);
    print({ ok: false, error: { code: "internal_error", message: "内部错误，详见服务端日志" } });
    deps.stderr(`internal_error (${e instanceof Error ? e.name : typeof e})\n`);
    return 1;
  }

  async function rosterCommand(args: string[]): Promise<number> {
    const [sub, ...r] = args;
    const parse2 = <O extends Record<string, { type: "string" | "boolean"; multiple?: boolean }>>(options: O) => parseArgs({ args: r, strict: true, allowPositionals: true, options });
    const out = (v: unknown): number => (deps.stdout(`${JSON.stringify({ ok: true, ...(v as object) })}\n`), 0);
    switch (sub) {
      case "template": {
        const { values } = parse2({ out: { type: "string" } });
        const content = buildTemplate();
        if (values.out) deps.writeFile(values.out, content);
        return out({ header: ROSTER_HEADER, guide: TEMPLATE_GUIDE, ...(values.out ? { out: values.out } : { content }) });
      }
      case "precheck": {
        const { values, positionals } = parse2({ file: { type: "string" }, branch: { type: "string" } });
        if (!values.file) bad("需要 --file");
        const path = values.file!;
        const planId = id(one(positionals, "计划 ID"), "计划 ID");
        const r2 = await ap.roster.precheck({ planId, fileName: path.split("/").pop() ?? path, bytes: deps.readFile(path), ...(values.branch ? { branchId: await deps.branchIdOf(values.branch) } : {}) }, actor);
        if (r2.summary.precheck.soft_cap_exceeded) deps.stderr(`提示：提交后预计名单 ${r2.summary.precheck.plan_entries_after} 个账号，超过 1,200 的软提示线（不阻止确认）。\n`);
        return out(r2);
      }
      case "confirm": {
        const { values } = parse2({ batch: { type: "string" } });
        if (!values.batch) bad("需要 --batch");
        return out(await ap.roster.confirm(values.batch!, actor));
      }
      case "batches": {
        const { values } = parse2({ plan: { type: "string" }, offset: { type: "string" }, limit: { type: "string" } });
        const offset = num(values.offset, "offset");
        const limit = num(values.limit, "limit");
        return out({ batches: await ap.query.batches(actor, { ...(values.plan ? { planId: id(values.plan, "计划 ID") } : {}), ...(offset === undefined ? {} : { offset }), ...(limit === undefined ? {} : { limit }) }) });
      }
      case "batch": {
        const { positionals } = parse2({});
        return out({ batch: await ap.query.batch(actor, one(positionals, "批次 ID")) });
      }
      case "rows": {
        const { values, positionals } = parse2({ class: { type: "string" }, outcome: { type: "string" }, offset: { type: "string" }, limit: { type: "string" } });
        const offset = num(values.offset, "offset");
        const limit = num(values.limit, "limit");
        return out(await ap.query.rows(actor, one(positionals, "批次 ID"), { ...(values.class ? { precheckClass: values.class } : {}), ...(values.outcome ? { outcome: values.outcome } : {}), ...(offset === undefined ? {} : { offset }), ...(limit === undefined ? {} : { limit }) }));
      }
      case "report": {
        const { values, positionals } = parse2({ out: { type: "string" } });
        if (!values.out) bad("需要 --out");
        const f = await ap.query.returnFile(actor, one(positionals, "批次 ID"));
        deps.writeFile(values.out!, f.content);
        return out({ rows: f.rows, out: values.out });
      }
      case "list": {
        const { values, positionals } = parse2({ state: { type: "string" }, offset: { type: "string" }, limit: { type: "string" } });
        if (values.state !== undefined && values.state !== "in_roster" && values.state !== "removed") bad("--state 只能是 in_roster 或 removed");
        const offset = num(values.offset, "offset");
        const limit = num(values.limit, "limit");
        return out(await ap.query.roster(actor, id(one(positionals, "计划 ID"), "计划 ID"), { ...(values.state ? { state: values.state as "in_roster" | "removed" } : {}), ...(offset === undefined ? {} : { offset }), ...(limit === undefined ? {} : { limit }) }));
      }
      case "remove": {
        const { values, positionals } = parse2({ account: { type: "string", multiple: true }, staff: { type: "string", multiple: true }, apply: { type: "boolean" } });
        return out(
          await ap.roster.maintenance.remove(actor, {
            planId: id(one(positionals, "计划 ID"), "计划 ID"),
            accountIds: (values.account ?? []).map((v) => id(v, "账号 ID")),
            staffIds: (values.staff ?? []).map((v) => id(v, "专员 ID")),
            apply: values.apply === true,
          }),
        );
      }
      default:
        return bad("未知子命令");
    }
  }
}
