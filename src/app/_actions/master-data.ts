"use server";
// 主数据导入页面的服务端动作：只做「会话 → ActorContext → Module 调用」的转接。
// 授权（Capability、品牌范围、结构模式仅超管）全部由 Module 判定；这里不写 SQL，不写角色条件。
import { MasterDataError } from "../../modules/master-data-import";
import { idOf, idsOf, run } from "../_lib/action";
import { masterData, mdActorOf } from "../_lib/master-data";
import type { ActionResult } from "../_lib/result";

const MAX_BYTES = 10 * 1024 * 1024;

export async function precheckMasterImport(form: FormData): Promise<ActionResult<{ batchId: string }>> {
  return run(async (ctx) => {
    const file = form.get("file");
    const mode = form.get("mode");
    if (mode !== "import" && mode !== "structure") throw new MasterDataError("input", "invalid_mode", "请选择导入模式");
    if (!(file instanceof File) || file.size === 0) throw new MasterDataError("input", "file_missing", "请先选择要上传的 CSV 文件");
    if (file.size > MAX_BYTES) throw new MasterDataError("limit", "file_too_large", "文件超过 10 MB，请拆分后再上传", { bytes: file.size });
    const r = await masterData().imports.precheck({ fileName: file.name.slice(0, 200), bytes: new Uint8Array(await file.arrayBuffer()), mode }, await mdActorOf(ctx));
    return { batchId: r.batchId };
  });
}

/** 确认写入。closureStoreIds 只能是本批次待确认撤店清单里的门店；不在清单里的整条命令被拒、零写入。 */
export async function confirmMasterImport(batchId: string, closureStoreIds: string[]): Promise<ActionResult<{ closed: number; alreadyCompleted: boolean }>> {
  return run(async (ctx) => {
    const ids = idsOf(closureStoreIds, "门店", 10_000).map(String);
    const r = await masterData().imports.confirm(String(idOf(batchId, "批次")), { closureStoreIds: ids }, await mdActorOf(ctx));
    return { closed: r.closedStores.length, alreadyCompleted: r.alreadyCompleted };
  });
}

/** 回流文件：错误行、需超管处理的行和冲突行；由浏览器保存，不落服务器磁盘。 */
export async function masterReturnFile(batchId: string): Promise<ActionResult<{ fileName: string; csv: string; rows: number }>> {
  return run(async (ctx) => {
    const id = String(idOf(batchId, "批次"));
    const f = await masterData().query.returnFile(id, await mdActorOf(ctx));
    return { fileName: `主数据回流-批次${id}.csv`, csv: f.content, rows: f.rows };
  });
}
