// `pnpm smoke`：批准式、预算受限的真实 smoke 入口（R17）。独立于默认测试与 CI。
//   smoke preview --plan <plan.json>                          只校验计划并打印预算预览；不需要审批，也不会有任何副作用
//   smoke run --plan <plan.json> --approval <approval.json>   门槛全部满足才执行（需要环境变量 HBECHO_SMOKE=approved-paid-calls）
// 退出码：0 成功 / 2 门槛拒绝或输入不合法 / 5 已获批但真实执行器未接线 / 1 其他错误。
// 门槛在读取 secret、构造 transport、写数据库之前检查；拒绝信息不回显 locator 与审批细节。
import { parseArgs } from "node:util";
import { SmokeRefused, preflight, validatePlan, type SmokeAuthorized, type SmokeSummary } from "../modules/smoke";

export interface SmokeCliDeps {
  readJson(path: string): Promise<unknown>;
  env: Record<string, string | undefined>;
  now(): Date;
  stdout(text: string): void;
  stderr(text: string): void;
  /** 真实执行（HTTP transport + 私有 ODS + secret provider 接线之后才有）。没有则获批后以退出码 5 停止。 */
  execute?: (auth: SmokeAuthorized) => Promise<SmokeSummary>;
  onInternalError?(e: unknown): void;
}

const USAGE = ["用法：", "  smoke preview --plan <plan.json>", "  smoke run --plan <plan.json> --approval <approval.json>"].join("\n");

export async function runSmokeCli(argv: string[], deps: SmokeCliDeps): Promise<number> {
  const print = (v: unknown) => deps.stdout(`${JSON.stringify(v)}\n`);
  try {
    const [cmd, ...rest] = argv;
    const { values } = parseArgs({ args: rest, options: { plan: { type: "string" }, approval: { type: "string" } }, strict: true });
    if ((cmd !== "preview" && cmd !== "run") || !values.plan) {
      deps.stderr(`${USAGE}\n`);
      return 2;
    }
    if (cmd === "preview") {
      const v = validatePlan(await deps.readJson(values.plan));
      print({ ok: true, preview: v.preview, plan_sha256: v.planSha256, note: "仅预览：未审批、未执行、未读取 secret" });
      return 0;
    }
    // run：先过门槛（开关 → 审批 → 计划），任何一条不满足都在读文件之外没有任何副作用
    if (deps.env.HBECHO_SMOKE === undefined) {
      // 与 preflight 同一条规则；提前返回只是为了不去读审批文件
      print({ ok: false, error: { code: "switch_off", message: "运行期开关 HBECHO_SMOKE 未设置为约定值" } });
      return 2;
    }
    const approval = values.approval ? await deps.readJson(values.approval) : null;
    const auth = preflight({ plan: await deps.readJson(values.plan), approval, env: deps.env, now: deps.now() });
    if (!deps.execute) {
      print({ ok: false, authorized: true, error: { code: "executor_not_wired", message: "已通过全部门槛，但真实 HTTP transport / 私有 ODS / secret provider 尚未接线，未发出任何调用" }, preview: auth.preview });
      return 5;
    }
    const summary = await deps.execute(auth);
    print({ ok: true, summary });
    return 0;
  } catch (e) {
    if (e instanceof SmokeRefused) {
      print({ ok: false, error: { code: e.code, message: e.message } });
      return 2;
    }
    if ((e as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) {
      deps.stderr(`${USAGE}\n`);
      return 2;
    }
    deps.onInternalError?.(e);
    print({ ok: false, error: { code: "internal_error", message: "内部错误，详情见服务端日志" } });
    return 1;
  }
}
