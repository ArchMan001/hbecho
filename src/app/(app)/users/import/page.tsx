import { ImportWizard, type WizardBatch } from "../../../_components/import-wizard";
import { BackLink, DeniedState, PageHead } from "../../../_components/ui";
import { SKIP_REASONS } from "../../../_lib/labels";
import { isAccessError } from "../../../_lib/action";
import { requireUser, web } from "../../../_lib/session";
import { AccessError } from "../../../../modules/access-control";

export default async function ImportPage({ searchParams }: { searchParams: Promise<{ batch?: string }> }) {
  const ctx = await requireUser();
  if (!ctx.capabilities.has("user.manage")) return <DeniedState text="当前角色没有「用户管理」权限，批量导入入口不对你开放。" />;
  const { batch: id } = await searchParams;
  let batch: WizardBatch | null = null;
  if (id) {
    try {
      if (!/^\d{1,19}$/.test(id)) throw new AccessError("not_found", "batch_not_found", "");
      const { batch: b, raw } = await web().importRows(ctx, BigInt(id));
      batch = {
        batchId: b.batchId,
        status: b.status,
        fileName: b.fileName ?? "用户导入.csv",
        totalRows: b.totalRows,
        newRows: b.newRows,
        skippedRows: b.skippedRows,
        errorRows: b.errorRows,
        conflictRows: b.conflictRows,
        rows: b.rows.map((r) => {
          const c = raw.get(r.rowNo) ?? {};
          return {
            rowNo: r.rowNo,
            name: c["姓名"] ?? "",
            role: c["角色"] ?? "",
            phone: c["手机号"] ?? "",
            brand: c["品牌"] ?? "",
            scope: [c["分公司"], c["门店编码"]].filter(Boolean).join(" · "),
            kind: r.precheckClass === "new" ? "new" : r.reasonCode && SKIP_REASONS.has(r.reasonCode) ? "skip" : "error",
            outcome: r.outcome,
            reason: r.reasonCode,
            guidance: r.guidance,
          };
        }),
      };
    } catch (e) {
      // 只有提交人本人能看到批次；其他人（包括更高级别的管理员）一律「未找到」
      if (isAccessError(e) && e.category === "not_found") return <DeniedState text="这个导入批次不存在，或不是你提交的。" home="/users/import" />;
      throw e;
    }
  }
  return (
    <>
      <BackLink href="/users">返回用户列表</BackLink>
      <PageHead title="批量导入用户" sub="固定 6 列；全部同步执行；预检结果不过期，确认时重新校验全部行。" />
      <div className="wizard-layout">
        <ImportWizard batch={batch} />
        <aside className="wizard-rail" aria-label="导入说明">
          <div className="rail-card">
            <div className="rail-kicker">模板</div>
            <div className="rail-title">固定 6 列</div>
            <div className="rail-text">姓名、角色、手机号、品牌、分公司、门店编码。角色写中文名；品牌、分公司写编码，多个用分号隔开；门店编码仅门店专员填。</div>
          </div>
          <div className="rail-card">
            <div className="rail-kicker">限额</div>
            <div className="rail-list">
              <div className="rail-row"><span>数据行</span><strong>≤ 1,000</strong></div>
              <div className="rail-row"><span>文件大小</span><strong>≤ 10 MB</strong></div>
              <div className="rail-row"><span>执行</span><strong>全部同步</strong></div>
            </div>
          </div>
          <div className="rail-card">
            <div className="rail-kicker">越权处理</div>
            <div className="rail-title">越权行不拖垮整批</div>
            <div className="rail-text">越权行进入跳过清单；手机号已存在会标记为「手机号已存在」；不提供「一键改成新增」，不静默改角色或范围。</div>
          </div>
        </aside>
      </div>
    </>
  );
}
