// CLI：`pnpm square policy list | set --brand <编码> --mode all|own`（f-video-square design §5.3、requirements U1）。
// 只调用 Module，不直接写库；输出 JSON，BIGINT 一律十进制字符串。身份与 `pnpm access` 相同：HBECHO_ACCESS_ACTOR=user:<id>，
// 必须是有效用户且持有 config.manage（只有超管），范围一律从数据库现算；没有任何旁路开关。
// 退出码：0 成功 / 2 输入、授权 / 4 不存在 / 1 配置与其他错误。
import { parseArgs } from "node:util";
import type { AuthContext } from "../modules/access-control";
import { isSquareError, listBrandPolicies, setBrandPolicy, type SquareDeps } from "../modules/video-square";

export interface SquareCliDeps {
  square: SquareDeps;
  actorId: string | undefined;
  /** 把 actorId 现算成 AuthContext；失败抛错（信息会原样输出，不含密钥）。 */
  context(actorId: string): Promise<AuthContext>;
  /** 品牌编码 → ID；不存在返回 undefined。 */
  brandIdOf(code: string): Promise<bigint | undefined>;
  stdout(text: string): void;
  stderr(text: string): void;
  onInternalError?(error: unknown): void;
}

const USAGE = ["用法：", "  square policy list", "  square policy set --brand <品牌编码> --mode all|own"].join("\n");

export async function runSquareCli(argv: string[], deps: SquareCliDeps): Promise<number> {
  const print = (v: unknown) => deps.stdout(`${JSON.stringify(v)}\n`);
  const fail = (code: string, message: string, exit: number): number => (print({ ok: false, error: { code, message } }), exit);
  try {
    const [group, cmd, ...rest] = argv;
    if (group !== "policy" || (cmd !== "list" && cmd !== "set")) return fail("invalid_input", `未知命令\n${USAGE}`, 2);
    if (!deps.actorId) return fail("actor_missing", "缺少 HBECHO_ACCESS_ACTOR（user:<id>，必须是持有 config.manage 的有效用户）", 1);
    const ctx = await deps.context(deps.actorId);
    if (cmd === "list") {
      print({ ok: true, policies: await listBrandPolicies(deps.square.db) });
      return 0;
    }
    const { values } = parseArgs({ args: rest, strict: true, allowPositionals: false, options: { brand: { type: "string" }, mode: { type: "string" } } });
    if (!values.brand || !values.mode) return fail("invalid_input", `需要 --brand 与 --mode\n${USAGE}`, 2);
    const brandId = await deps.brandIdOf(values.brand);
    if (brandId === undefined) return fail("brand_not_found", `品牌编码 ${values.brand} 不存在`, 4);
    print({ ok: true, ...(await setBrandPolicy(deps.square, ctx, brandId, values.mode)) });
    return 0;
  } catch (e) {
    if (isSquareError(e)) return fail(e.code, e.message, e.kind === "not_found" ? 4 : e.kind === "unavailable" ? 1 : 2);
    if (e instanceof TypeError && /Unknown option|argument/i.test(e.message)) return fail("invalid_input", `${e.message}\n${USAGE}`, 2);
    deps.onInternalError?.(e);
    return fail("internal_error", e instanceof Error ? e.message : "内部错误", 1);
  }
}
