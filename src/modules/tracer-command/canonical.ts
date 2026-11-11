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

/** 名单导入的根任务（a-activity-plan design §10.2）：自己的 closed schema，版本号与 tracer 命令不同，不会碰撞。 */
export const ROSTER_COMMAND_SCHEMA_VERSION = "roster-resolve.v1";
export const ROSTER_TASK_PARAMETERS_VERSION = "roster-resolve-task-parameters.v1";
const rosterCommand = z.strictObject({
  schema_version: z.literal(ROSTER_COMMAND_SCHEMA_VERSION),
  platform_id_decimal: decimalId,
  media_staff_id_decimal: decimalId,
  home_locator_exact_utf8: z.string().min(1).refine((s) => s.isWellFormed(), "含孤立代理项"),
  import_batch_id_decimal: decimalId,
  row_no: z.number().int().min(1),
});
export function rosterCommandDigest(p: { platformId: bigint; staffId: bigint; locator: string; importBatchId: bigint; rowNo: number }): Buffer {
  return jcsSha256(
    rosterCommand.parse({
      schema_version: ROSTER_COMMAND_SCHEMA_VERSION,
      platform_id_decimal: p.platformId.toString(),
      media_staff_id_decimal: p.staffId.toString(),
      home_locator_exact_utf8: p.locator,
      import_batch_id_decimal: p.importBatchId.toString(),
      row_no: p.rowNo,
    }),
  );
}
/** 名单根任务只采主页（profile_only），所以没有 effective_initial_content_limit。 */
export function buildRosterTaskParameters(importBatchId: bigint, rowNo: number) {
  return { schema_version: ROSTER_TASK_PARAMETERS_VERSION, profile_only: true as const, import_batch_id: importBatchId.toString(), row_no: rowNo };
}
