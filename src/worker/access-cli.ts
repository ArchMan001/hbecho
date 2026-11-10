// CLI：`pnpm access ...`（design §9.3）。只调用 Module，不直接写库；输出 JSON，BIGINT 一律十进制字符串。
// 退出码：0 成功 / 2 输入、授权 / 3 冲突 / 4 不存在 / 5 超过上限 / 1 其他（对齐 master-data）。
// 没有 --force / --skip-auth：权限边界来自「以哪个真实用户的身份操作」，范围与能力一律从数据库里的该用户现算，
// 不接受环境变量自行声明角色或范围。写命令不带 --apply 一律只预览，库里无变化。
//   需要身份的命令：HBECHO_ACCESS_ACTOR=user:<id>（必须是有效用户）。
//   不需要身份的命令（持数据库凭证的运维操作）：token create、bootstrap-superadmin、maintain。
import { parseArgs } from "node:util";
import { AccessError, type AuditReader, type AuthContext, type Bootstrap, type UserAdmin, type UserImport, type StaffLinkage } from "../modules/access-control";

export interface AccessCliDeps {
  admin: UserAdmin;
  imp: UserImport;
  boot: Bootstrap;
  audit: AuditReader;
  maintain: Pick<StaffLinkage, "runNow">;
  /** 环境变量 HBECHO_ACCESS_ACTOR 的值；缺省时需要身份的命令启动失败。 */
  actorId: string | undefined;
  /** 把 actorId 现算成 AuthContext（真实用户、有效状态、范围来自数据库）。失败抛 AccessError。 */
  context(actorId: string): Promise<AuthContext>;
  /** 品牌 / 分公司编码 → ID。 */
  refs(): Promise<{ brandIds: Map<string, bigint>; branchIds: Map<string, bigint> }>;
  readFile(path: string): Uint8Array;
  writeFile(path: string, content: string): void;
  stdout(text: string): void;
  stderr(text: string): void;
  onInternalError?(error: unknown): void;
}

const USAGE = [
  "用法：",
  "  access token create",
  "  access bootstrap-superadmin --token <t> --phone <p> --name <n>",
  "  access user invite --name <n> --role <中文名|角色码> --phone <p> [--brand A,B] [--branch X,Y] [--store-code C] [--apply]",
  "  access user list [--status pending_activation|active|disabled] [--role <角色码>]",
  "  access user show <id>",
  "  access user change <id> [--name n] [--role r] [--brand A,B] [--branch X,Y] [--phone p] [--apply]",
  "  access user disable|restore|force-logout <id> [--apply]",
  "  access user import precheck --file <csv>",
  "  access user import confirm --batch <id> [--apply]",
  "  access user import batches | batch <id> | rows <id> | report <id> --out <csv>",
  "  access audit list [--actor a] [--target-type t] [--target-id i] [--batch b] [--event-type e] [--from iso] [--to iso] [--limit n] [--offset n]",
  "  access maintain [--apply]",
  "写命令不带 --apply 只预览，不改变任何数据。",
].join("\n");

const EXIT: Record<AccessError["category"], number> = { input: 2, authorization: 2, conflict: 3, not_found: 4, limit: 5, configuration: 1 };
const bad = (msg: string) => new AccessError("input", "invalid_input", `${msg}\n${USAGE}`);
const bigint = (v: string | undefined, what: string): bigint => {
  if (v === undefined || !/^\d{1,19}$/.test(v)) throw bad(`${what} 必须是十进制数字`);
  return BigInt(v);
};
const num = (v: string | undefined): number | undefined => {
  if (v === undefined) return undefined;
  if (!/^\d+$/.test(v)) throw bad(`不是非负整数：${v}`);
  return Number(v);
};
const csv = (v: string | undefined): string[] => (v ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const date = (v: string | undefined, what: string): Date | undefined => {
  if (v === undefined) return undefined;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw bad(`${what} 不是合法的时间（ISO 8601）`);
  return d;
};

export async function runAccessCli(argv: string[], deps: AccessCliDeps): Promise<number> {
  const print = (v: unknown) => deps.stdout(`${JSON.stringify(v)}\n`);
  const fail = (e: AccessError): number => {
    print({ ok: false, error: { code: e.code, message: e.message, ...(e.detail === undefined ? {} : { detail: e.detail }) } });
    return EXIT[e.category];
  };
  const ctx = async (): Promise<AuthContext> => {
    if (!deps.actorId) throw new AccessError("configuration", "actor_missing", "缺少 HBECHO_ACCESS_ACTOR（user:<id>，必须是有效用户）");
    return deps.context(deps.actorId);
  };
  const codesToIds = async (kind: "brand" | "branch", codes: string[]): Promise<bigint[]> => {
    const refs = await deps.refs();
    const map = kind === "brand" ? refs.brandIds : refs.branchIds;
    return codes.map((c) => {
      const id = map.get(c);
      if (id === undefined) throw new AccessError("input", `${kind}_not_found`, `${kind === "brand" ? "品牌" : "分公司"}编码不存在：${c}`);
      return id;
    });
  };
  const preview = (what: string, detail: unknown) => print({ ok: true, applied: false, message: "预览，未做任何改动；加 --apply 执行", action: what, preview: detail });

  try {
    const [cmd, ...rest] = argv;
    switch (cmd) {
      case "token": {
        if (rest[0] !== "create" || rest.length !== 1) throw bad("未知子命令");
        const r = await deps.boot.createToken();
        deps.stderr("令牌只显示这一次，24 小时内有效。\n");
        print({ ok: true, token: r.token, expiresAt: r.expiresAt.toISOString() });
        return 0;
      }
      case "bootstrap-superadmin": {
        const { values } = parseArgs({ args: rest, strict: true, options: { token: { type: "string" }, phone: { type: "string" }, name: { type: "string" } } });
        if (!values.token || !values.phone || !values.name) throw bad("需要 --token、--phone、--name");
        print({ ok: true, ...(await deps.boot.bootstrapSuperadmin({ token: values.token, phone: values.phone, name: values.name })) });
        return 0;
      }
      case "maintain": {
        const { values } = parseArgs({ args: rest, strict: true, options: { apply: { type: "boolean" } } });
        // 会停用用户、恢复用户、清理表：和其它写命令一样，不带 --apply 只说明将做什么，不执行
        if (!values.apply) {
          preview("maintain", { steps: ["补偿：停用绑定专员已失效的用户", "条件恢复：专员恢复后恢复因其自动停用的用户", "审计到期清理（保留 365 天）", "增长型表清理（短信流水、登录失败计数、引导令牌）"] });
          return 0;
        }
        const r = await deps.maintain.runNow();
        print({ ok: r.ok, report: r.report });
        return r.ok ? 0 : 1;
      }
      case "audit": {
        if (rest[0] !== "list") throw bad("未知子命令");
        const { values } = parseArgs({
          args: rest.slice(1),
          strict: true,
          options: { actor: { type: "string" }, "target-type": { type: "string" }, "target-id": { type: "string" }, batch: { type: "string" }, "event-type": { type: "string" }, from: { type: "string" }, to: { type: "string" }, limit: { type: "string" }, offset: { type: "string" } },
        });
        const q = {
          ...(values.actor !== undefined ? { actor: values.actor } : {}),
          ...(values["target-type"] !== undefined ? { targetType: values["target-type"] } : {}),
          ...(values["target-id"] !== undefined ? { targetId: values["target-id"] } : {}),
          ...(values.batch !== undefined ? { batchRef: bigint(values.batch, "--batch") } : {}),
          ...(values["event-type"] !== undefined ? { eventType: values["event-type"] } : {}),
          ...(values.from !== undefined ? { from: date(values.from, "--from")! } : {}),
          ...(values.to !== undefined ? { to: date(values.to, "--to")! } : {}),
          ...(values.limit !== undefined ? { limit: num(values.limit)! } : {}),
          ...(values.offset !== undefined ? { offset: num(values.offset)! } : {}),
        };
        print({ ok: true, events: await deps.audit.read(await ctx(), q) });
        return 0;
      }
      case "user":
        return await runUser(rest);
      default:
        throw bad("未知子命令");
    }
  } catch (e) {
    return handle(e);
  }

  async function runUser(args: string[]): Promise<number> {
    const [sub, ...rest] = args;
    switch (sub) {
      case "invite": {
        const { values } = parseArgs({
          args: rest,
          strict: true,
          options: { name: { type: "string" }, role: { type: "string" }, phone: { type: "string" }, brand: { type: "string" }, branch: { type: "string" }, "store-code": { type: "string" }, apply: { type: "boolean" } },
        });
        if (!values.name || !values.role || !values.phone) throw bad("需要 --name、--role、--phone");
        const input = {
          name: values.name,
          role: ROLE_ALIAS[values.role] ?? values.role,
          phone: values.phone,
          brandIds: await codesToIds("brand", csv(values.brand)),
          branchIds: await codesToIds("branch", csv(values.branch)),
          ...(values["store-code"] !== undefined ? { storeCode: values["store-code"] } : {}),
        };
        const c = await ctx();
        if (!values.apply) {
          preview("invite", await deps.admin.previewInvite(c, input));
          return 0;
        }
        print({ ok: true, applied: true, ...(await deps.admin.invite(c, input)) });
        return 0;
      }
      case "list": {
        const { values } = parseArgs({ args: rest, strict: true, options: { status: { type: "string" }, role: { type: "string" } } });
        const filter: { status?: "pending_activation" | "active" | "disabled"; role?: never } = {};
        if (values.status !== undefined) {
          if (!["pending_activation", "active", "disabled"].includes(values.status)) throw bad("--status 取值不合法");
          filter.status = values.status as "pending_activation" | "active" | "disabled";
        }
        const roleFilter = values.role === undefined ? undefined : (ROLE_ALIAS[values.role] ?? values.role);
        print({ ok: true, users: await deps.admin.list(await ctx(), { ...filter, ...(roleFilter ? { role: roleFilter as never } : {}) }) });
        return 0;
      }
      case "show": {
        const { positionals } = parseArgs({ args: rest, strict: true, allowPositionals: true, options: {} });
        if (positionals.length !== 1) throw bad("需要且只需要一个用户 ID");
        print({ ok: true, user: await deps.admin.get(await ctx(), bigint(positionals[0], "用户 ID")) });
        return 0;
      }
      case "change": {
        const { values, positionals } = parseArgs({
          args: rest,
          strict: true,
          allowPositionals: true,
          options: { name: { type: "string" }, role: { type: "string" }, brand: { type: "string" }, branch: { type: "string" }, phone: { type: "string" }, apply: { type: "boolean" } },
        });
        if (positionals.length !== 1) throw bad("需要且只需要一个用户 ID");
        const id = bigint(positionals[0], "用户 ID");
        const change = {
          ...(values.name !== undefined ? { displayName: values.name } : {}),
          ...(values.role !== undefined ? { role: ROLE_ALIAS[values.role] ?? values.role } : {}),
          ...(values.brand !== undefined ? { brandIds: await codesToIds("brand", csv(values.brand)) } : {}),
          ...(values.branch !== undefined ? { branchIds: await codesToIds("branch", csv(values.branch)) } : {}),
          ...(values.phone !== undefined ? { phone: values.phone } : {}),
        };
        if (Object.keys(change).length === 0) throw bad("没有要修改的内容");
        const c = await ctx();
        if (!values.apply) {
          preview("change", { current: await deps.admin.get(c, id), change: JSON.parse(JSON.stringify(change, (_k, v) => (typeof v === "bigint" ? v.toString() : v))) });
          return 0;
        }
        print({ ok: true, applied: true, ...(await deps.admin.changeAccess(c, id, change)) });
        return 0;
      }
      case "disable":
      case "restore":
      case "force-logout": {
        const { values, positionals } = parseArgs({ args: rest, strict: true, allowPositionals: true, options: { apply: { type: "boolean" } } });
        if (positionals.length !== 1) throw bad("需要且只需要一个用户 ID");
        const id = bigint(positionals[0], "用户 ID");
        const c = await ctx();
        if (!values.apply) {
          preview(sub, { current: await deps.admin.get(c, id) }); // get 已按管理范围判断：越界 = 未找到
          return 0;
        }
        const r = sub === "disable" ? await deps.admin.disable(c, id) : sub === "restore" ? await deps.admin.restore(c, id) : await deps.admin.forceLogout(c, id);
        print({ ok: true, applied: true, ...r, ...(sub === "restore" ? { removedBrandIds: (r as { removedBrandIds: bigint[] }).removedBrandIds.map(String), removedBranchIds: (r as { removedBranchIds: bigint[] }).removedBranchIds.map(String) } : {}) });
        return 0;
      }
      case "import":
        return runImport(rest);
      default:
        throw bad("未知子命令");
    }
  }

  async function runImport(args: string[]): Promise<number> {
    const [sub, ...rest] = args;
    switch (sub) {
      case "precheck": {
        const { values } = parseArgs({ args: rest, strict: true, options: { file: { type: "string" } } });
        if (!values.file) throw bad("需要 --file");
        const r = await deps.imp.precheck(await ctx(), { name: values.file.split("/").pop() ?? values.file, bytes: deps.readFile(values.file) });
        print({ ok: true, ...r });
        return 0;
      }
      case "confirm": {
        const { values } = parseArgs({ args: rest, strict: true, options: { batch: { type: "string" }, apply: { type: "boolean" } } });
        const id = bigint(values.batch, "--batch");
        const c = await ctx();
        if (!values.apply) {
          preview("import_confirm", await deps.imp.get(c, id));
          return 0;
        }
        print({ ok: true, applied: true, ...(await deps.imp.confirm(c, id)) });
        return 0;
      }
      case "batches": {
        const { values } = parseArgs({ args: rest, strict: true, options: { offset: { type: "string" }, limit: { type: "string" } } });
        print({ ok: true, batches: await deps.imp.list(await ctx(), { ...(values.offset !== undefined ? { offset: num(values.offset)! } : {}), ...(values.limit !== undefined ? { limit: num(values.limit)! } : {}) }) });
        return 0;
      }
      case "batch": {
        const { positionals } = parseArgs({ args: rest, strict: true, allowPositionals: true, options: {} });
        if (positionals.length !== 1) throw bad("需要且只需要一个批次 ID");
        const { rows: _rows, ...batch } = await deps.imp.get(await ctx(), bigint(positionals[0], "批次 ID"));
        print({ ok: true, ...batch });
        return 0;
      }
      case "rows": {
        const { positionals } = parseArgs({ args: rest, strict: true, allowPositionals: true, options: {} });
        if (positionals.length !== 1) throw bad("需要且只需要一个批次 ID");
        print({ ok: true, rows: (await deps.imp.get(await ctx(), bigint(positionals[0], "批次 ID"))).rows });
        return 0;
      }
      case "report": {
        const { values, positionals } = parseArgs({ args: rest, strict: true, allowPositionals: true, options: { out: { type: "string" } } });
        if (positionals.length !== 1 || !values.out) throw bad("需要批次 ID 与 --out");
        const f = await deps.imp.returnFile(await ctx(), bigint(positionals[0], "批次 ID"));
        deps.writeFile(values.out, f.csv);
        print({ ok: true, rows: f.rows, out: values.out });
        return 0;
      }
      default:
        throw bad("未知子命令");
    }
  }

  function handle(e: unknown): number {
    if (e instanceof AccessError) return fail(e);
    if (e instanceof TypeError && String((e as { code?: string }).code).startsWith("ERR_PARSE_ARGS")) return fail(bad(e.message));
    if ((e as { code?: string }).code === "ENOENT") return fail(new AccessError("input", "file_not_found", "找不到指定文件"));
    deps.onInternalError?.(e);
    print({ ok: false, error: { code: "internal_error", message: "内部错误，详见服务端日志" } });
    deps.stderr(`internal_error (${e instanceof Error ? e.name : typeof e})\n`);
    return 1;
  }
}

/** 中文角色名 → 角色码；其它原样交给 Module 校验。 */
const ROLE_ALIAS: Record<string, string> = { 超级管理员: "platform_admin", 总部人员: "hq_manager", 分公司人员: "branch_manager", 经销商人员: "store_staff" };
