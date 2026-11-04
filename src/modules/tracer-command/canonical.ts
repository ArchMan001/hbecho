// data-foundation-tracer-command.v1：closed schema + RFC 8785 JCS 摘要（v2 §5.5、§9.3）。
// 逻辑对象固定五个字段；两个内部 ID 用十进制 string，locator 保留 exact Unicode text，limit 是 JSON integer。
import { createHash } from "node:crypto";
import { z } from "zod";
import { jcsSha256 } from "../canonical-json";

export const COMMAND_SCHEMA_VERSION = "data-foundation-tracer-command.v1";
export const TASK_PARAMETERS_SCHEMA_VERSION = "data-foundation-tracer-task-parameters.v1";
const MAX_BIGINT = 9223372036854775807n;

export const decimalId = z
  .string()
  .regex(/^[1-9]\d*$/, "必须是不带前导零的正十进制整数 string")
  // zod 不会因 regex 失败而跳过后面的 refine，先确认纯数字再转 BigInt
  .refine((s) => !/^\d+$/.test(s) || BigInt(s) <= MAX_BIGINT, "超出 BIGINT 范围");

const commandV1 = z.strictObject({
  schema_version: z.literal(COMMAND_SCHEMA_VERSION),
  platform_id_decimal: decimalId,
  media_staff_id_decimal: decimalId,
  home_locator_exact_utf8: z.string().min(1).refine((s) => s.isWellFormed(), "含孤立代理项"),
  effective_initial_content_limit: z.number().int().min(1).max(20),
});
export type CommandV1 = z.infer<typeof commandV1>;

/** 根任务 task_parameters 的两字段 persistence projection（不是完整 command）。 */
const taskParametersV1 = z.strictObject({
  schema_version: z.literal(TASK_PARAMETERS_SCHEMA_VERSION),
  effective_initial_content_limit: z.number().int().min(1).max(20),
});
export type TaskParametersV1 = z.infer<typeof taskParametersV1>;

export function buildCommandV1(p: { platformId: bigint; mediaStaffId: bigint; homeLocator: string; effectiveLimit: number }): CommandV1 {
  return commandV1.parse({
    schema_version: COMMAND_SCHEMA_VERSION,
    platform_id_decimal: p.platformId.toString(),
    media_staff_id_decimal: p.mediaStaffId.toString(),
    home_locator_exact_utf8: p.homeLocator,
    effective_initial_content_limit: p.effectiveLimit,
  });
}

export function parseCommandV1(input: unknown): CommandV1 {
  return commandV1.parse(input);
}

export function commandDigest(command: CommandV1): Buffer {
  return jcsSha256(commandV1.parse(command));
}

export function buildTaskParameters(effectiveLimit: number): TaskParametersV1 {
  return taskParametersV1.parse({ schema_version: TASK_PARAMETERS_SCHEMA_VERSION, effective_initial_content_limit: effectiveLimit });
}

export const sha256Of = (text: string): Buffer => createHash("sha256").update(text, "utf8").digest();
