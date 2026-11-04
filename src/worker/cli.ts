// CLI：`pnpm tracer submit|status|cancel`（design §14）。只调用 Module，不直接写库；输出 JSON。
// 退出码：0 成功 / 2 校验、授权、不支持 / 3 幂等冲突 / 4 不存在或已过期 / 1 其他错误。
import { parseArgs } from "node:util";
import { TracerError, type ActorContext, type TracerCommands, type TracerStatusQuery } from "../modules/tracer-command";

export interface CliDeps {
  commands: Pick<TracerCommands, "submit" | "cancel">;
  status: TracerStatusQuery;
  actor: ActorContext;
  stdout(text: string): void;
  stderr(text: string): void;
  /** 服务端诊断（完整错误）。不会写进 stdout 的 JSON。 */
  onInternalError?(error: unknown): void;
}

const USAGE = [
  "用法：",
  "  tracer submit --platform <code> --staff <media_staff_id> --locator <text> --key <idempotency-key> [--limit 1..20]",
  "  tracer status <root_task_id>",
  "  tracer cancel <root_task_id>",
].join("\n");

const EXIT: Record<TracerError["category"], number> = {
  input: 2,
  authorization: 2,
  unsupported: 2,
  conflict: 3,
  not_found: 4,
  configuration: 1,
};

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const print = (v: unknown) => deps.stdout(`${JSON.stringify(v)}\n`);
  const fail = (e: TracerError): number => {
    print({ ok: false, error: { code: e.code, message: e.message } });
    return EXIT[e.category];
  };

  try {
    const [cmd, ...rest] = argv;
    switch (cmd) {
      case "submit": {
        const { values } = parseArgs({
          args: rest,
          strict: true,
          options: {
            platform: { type: "string" },
            staff: { type: "string" },
            locator: { type: "string" },
            key: { type: "string" },
            limit: { type: "string" },
          },
        });
        for (const k of ["platform", "staff", "locator", "key"] as const) {
          if (values[k] === undefined) throw new TracerError("invalid_input", `缺少 --${k}\n${USAGE}`);
        }
        const r = await deps.commands.submit(
          {
            platform: values.platform,
            mediaStaffId: values.staff,
            homeLocator: values.locator,
            idempotencyKey: values.key,
            // 非数字原样传下去，由 Module 的校验拒绝；CLI 不自己解释
            ...(values.limit === undefined ? {} : { initialContentLimit: /^\d+$/.test(values.limit) ? Number(values.limit) : values.limit }),
          },
          deps.actor,
        );
        print({ root_task_id: r.rootTaskId, deduplicated: r.deduplicated, reused_active_task: r.reusedActiveTask });
        return 0;
      }
      case "status":
      case "cancel": {
        const { positionals } = parseArgs({ args: rest, strict: true, allowPositionals: true, options: {} });
        if (positionals.length !== 1) throw new TracerError("invalid_input", `需要且只需要一个 root_task_id\n${USAGE}`);
        const id = positionals[0]!;
        const result = cmd === "status" ? await deps.status.get(id, deps.actor) : await deps.commands.cancel(id, deps.actor);
        print(result);
        return result.kind === "found" ? 0 : 4;
      }
      default:
        throw new TracerError("invalid_input", `未知子命令\n${USAGE}`);
    }
  } catch (e) {
    if (e instanceof TracerError) return fail(e);
    // node:util.parseArgs 的参数错误（未知选项、缺值）也是输入错误
    if (e instanceof TypeError && String((e as { code?: string }).code).startsWith("ERR_PARSE_ARGS")) {
      return fail(new TracerError("invalid_input", `${e.message}\n${USAGE}`));
    }
    deps.onInternalError?.(e);
    print({ ok: false, error: { code: "internal_error", message: "内部错误，详见服务端日志" } });
    deps.stderr(`internal_error (${e instanceof Error ? e.name : typeof e})\n`);
    return 1;
  }
}
