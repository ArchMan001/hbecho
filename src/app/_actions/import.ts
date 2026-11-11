"use server";
// 用户批量导入的服务端动作。文件在服务端解析与预检（Module），页面只传字节。
import { AccessError } from "../../modules/access-control";
import { idOf, run } from "../_lib/action";
import { web } from "../_lib/session";
import type { ActionResult } from "../_lib/result";

const MAX_BYTES = 10 * 1024 * 1024; // 与 Module 的 USER_IMPORT_LIMITS 一致；这里先挡一次，避免读入过大的文件

export async function precheckImport(form: FormData): Promise<ActionResult<{ batchId: string }>> {
  return run(async (ctx) => {
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) throw new AccessError("input", "file_missing", "请先选择要上传的 CSV 文件");
    if (file.size > MAX_BYTES) throw new AccessError("limit", "file_too_large", "文件超过 10 MB，请拆分后再上传");
    const batch = await web().imp.precheck(ctx, { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
    return { batchId: batch.batchId };
  });
}

export async function confirmImport(batchId: string): Promise<ActionResult<{ created: number }>> {
  return run(async (ctx) => {
    const r = await web().imp.confirm(ctx, idOf(batchId, "批次"));
    return { created: r.rows.filter((x) => x.outcome === "imported").length };
  });
}

/** 回流文件：由提交人本人下载，只含本次提交的行；返回内容由浏览器保存，不落服务器磁盘。 */
export async function returnFile(batchId: string): Promise<ActionResult<{ fileName: string; csv: string; rows: number }>> {
  return run((ctx) => web().imp.returnFile(ctx, idOf(batchId, "批次")));
}
