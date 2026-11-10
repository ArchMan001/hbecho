// `pnpm sms-smoke`：真实短信的受控试发（b-access-control AX-13：真实发送不属于自动验收，需要人工批准、显式开关、固定条数、审计摘要）。
//
//   pnpm sms-smoke --phone 138xxxxxxxx --kind login [--count 1] --confirm-real-send
//
// 规则（全部在 `plan` 里，纯函数，不联网，所以每条拒绝路径都能离线测试）：
//   - 必须同时带 --confirm-real-send **和** 环境变量 HBECHO_SMS_SMOKE=1，缺任一条不发；
//   - 必须是 HBECHO_SMS_MODE=aliyun 且阿里云配置齐全（走与生产同一个 parseAccessConfig）；
//   - 条数固定上限 3（默认 1），目标号码只能有一个、必须是规范化后合法的手机号；
//   - 绝不打印验证码，不把验证码写进任何文件；输出只有审计摘要（时间、用途、条数、手机号、阿里云流水号 bizId、结果码）。
// 验证码是临时随机的 6 位数字，只存在于这一次调用的内存里，用户在手机上看到短信即可，不需要也不应该在终端里出现。
import { randomInt } from "node:crypto";
import { parseArgs } from "node:util";
import { AccessConfigError, parseAccessConfig, type AccessConfig } from "../modules/access-control/config";
import { normalizePhone } from "../modules/phone";
import type { SmsKind, SmsSender } from "../modules/access-control/sms";

export const MAX_SMOKE_COUNT = 3;
const KINDS: readonly SmsKind[] = ["login", "reset", "activate"];

export type SmokePlan =
  | { ok: true; phone: string; kind: SmsKind; count: number; config: AccessConfig }
  | { ok: false; code: "usage" | "not_confirmed" | "switch_off" | "config" | "bad_phone" | "bad_kind" | "bad_count" | "not_aliyun"; message: string };

export function planSmoke(argv: string[], env: Record<string, string | undefined>): SmokePlan {
  let values: { phone?: string; kind?: string; count?: string; "confirm-real-send"?: boolean };
  try {
    values = parseArgs({ args: argv, strict: true, options: { phone: { type: "string" }, kind: { type: "string" }, count: { type: "string" }, "confirm-real-send": { type: "boolean" } } }).values;
  } catch {
    return { ok: false, code: "usage", message: "用法：pnpm sms-smoke --phone <手机号> --kind login|reset|activate [--count 1..3] --confirm-real-send" };
  }
  // 先判断开关：没有批准信号时，不做任何别的事（连配置都不解析）
  if (values["confirm-real-send"] !== true) return { ok: false, code: "not_confirmed", message: "缺少 --confirm-real-send：这是真实发送，会产生费用并向真实手机号发短信" };
  if (env.HBECHO_SMS_SMOKE !== "1") return { ok: false, code: "switch_off", message: "缺少环境变量 HBECHO_SMS_SMOKE=1（真实发送的显式开关）" };
  const phone = values.phone === undefined ? null : normalizePhone(values.phone);
  if (phone === null) return { ok: false, code: "bad_phone", message: "--phone 不是合法的中国大陆手机号" };
  if (!KINDS.includes(values.kind as SmsKind)) return { ok: false, code: "bad_kind", message: "--kind 必须是 login、reset 或 activate" };
  const count = values.count === undefined ? 1 : /^\d+$/.test(values.count) ? Number(values.count) : 0;
  if (count < 1 || count > MAX_SMOKE_COUNT) return { ok: false, code: "bad_count", message: `--count 必须是 1 到 ${MAX_SMOKE_COUNT}` };
  let config: AccessConfig;
  try {
    config = parseAccessConfig(env);
  } catch (e) {
    return { ok: false, code: "config", message: e instanceof AccessConfigError ? `配置缺失或不合法：${e.keys.join(", ")}` : "配置不合法" };
  }
  if (config.smsMode !== "aliyun" || !config.aliyun) return { ok: false, code: "not_aliyun", message: "HBECHO_SMS_MODE 不是 aliyun：不会走真实发送器" };
  return { ok: true, phone, kind: values.kind as SmsKind, count, config };
}

export interface SmokeSummary {
  at: string;
  kind: SmsKind;
  phone: string;
  requested: number;
  results: Array<{ n: number; ok: boolean; providerRef?: string; error?: string; operational?: boolean }>;
}

export interface SmsSmokeDeps {
  /** 构造真实发送器（测试注入假实现，保证默认测试不联网）。 */
  makeSender(config: AccessConfig): SmsSender;
  now(): Date;
  stdout(s: string): void;
  stderr(s: string): void;
  /** 每条之间的间隔，避免触发 60 秒冷却的同类限流；测试注入 0。 */
  pauseMs?: number;
  sleep?(ms: number): Promise<void>;
}

/** 退出码：0 全部发送成功；2 被拒（未发送任何短信）；3 发送了但有失败。 */
export async function runSmsSmoke(argv: string[], env: Record<string, string | undefined>, deps: SmsSmokeDeps): Promise<number> {
  const plan = planSmoke(argv, env);
  if (!plan.ok) {
    deps.stderr(`${plan.message}\n`);
    deps.stdout(`${JSON.stringify({ ok: false, sent: 0, reason: plan.code })}\n`);
    return 2;
  }
  const sender = deps.makeSender(plan.config);
  const summary: SmokeSummary = { at: deps.now().toISOString(), kind: plan.kind, phone: plan.phone, requested: plan.count, results: [] };
  for (let n = 1; n <= plan.count; n++) {
    if (n > 1) await (deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(deps.pauseMs ?? 3000);
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0"); // 只在内存里，从不打印
    try {
      const r = await sender.send({ phone: plan.phone, code, kind: plan.kind });
      summary.results.push({ n, ok: true, ...(r.providerRef ? { providerRef: r.providerRef } : {}) });
    } catch (e) {
      const x = e as { providerCode?: unknown; operational?: unknown };
      // 只报供应商错误码，不报 message 原文（可能含请求细节）
      summary.results.push({ n, ok: false, error: typeof x.providerCode === "string" ? x.providerCode : e instanceof Error ? e.name : "unknown", operational: x.operational === true });
    }
  }
  deps.stdout(`${JSON.stringify({ ok: summary.results.every((r) => r.ok), sent: summary.results.filter((r) => r.ok).length, summary })}\n`);
  return summary.results.every((r) => r.ok) ? 0 : 3;
}
