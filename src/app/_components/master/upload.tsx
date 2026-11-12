"use client";
// 主数据导入的前两步：选择模式 → 上传文件。上传成功后带 ?batch= 回到本页，进入预检报告。
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { precheckMasterImport } from "../../_actions/master-data";
import { Dialog } from "../dialog";
import { Icon } from "../icon";
import { useToast } from "../toast";

export const MD_STEPS = ["选择模式", "上传文件", "预检报告", "确认写入", "批次详情"] as const;
export function MdSteps({ current }: { current: number }) {
  return (
    <div className="steps" aria-label="导入步骤">
      {MD_STEPS.map((label, i) => (
        <div key={label} className={`step ${i + 1 < current ? "done" : ""} ${i + 1 === current ? "active" : ""}`}>
          <span className="step-num">{i + 1}</span>
          {label}
        </div>
      ))}
    </div>
  );
}

export function MasterUpload({ canStructure }: { canStructure: boolean }) {
  const [stage, setStage] = useState<1 | 2>(1);
  const [mode, setMode] = useState<"import" | "structure">("import");
  const [help, setHelp] = useState(false);
  const [error, setError] = useState<{ code: string; message: string; hint?: string | undefined } | null>(null);
  const [pending, start] = useTransition();
  const fileInput = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const toast = useToast();

  const upload = (file: File) =>
    start(async () => {
      setError(null);
      const form = new FormData();
      form.set("file", file);
      form.set("mode", mode);
      let r: Awaited<ReturnType<typeof precheckMasterImport>>;
      try {
        r = await precheckMasterImport(form);
      } catch {
        r = { ok: false, code: "network_error", message: "文件没有传上去，请检查网络后重试" };
      }
      if (!r.ok) {
        setError(r);
        return;
      }
      toast("已读取文件并完成预检；预检只读，没有写入任何数据");
      router.replace(`/master-data/import?batch=${r.data.batchId}`);
    });

  const card = (key: "import" | "structure", title: string, text: string, disabled: boolean) => (
    <button
      type="button"
      className="card card-pad"
      disabled={disabled}
      aria-pressed={mode === key}
      onClick={() => setMode(key)}
      style={{ textAlign: "left", cursor: disabled ? "not-allowed" : "pointer", border: `1px solid ${mode === key ? "rgba(15,163,168,.6)" : "#E4E9F0"}`, background: mode === key ? "#E9F5F6" : "#fff", opacity: disabled ? 0.6 : 1 }}
    >
      <div className="card-title">{title}</div>
      <div className="cell-sub" style={{ marginTop: 6, whiteSpace: "normal" }}>{text}</div>
      {disabled ? <div className="cell-sub" style={{ marginTop: 8 }}><Icon name="lock" /> 仅超管可用</div> : null}
    </button>
  );

  return (
    <>
      <MdSteps current={stage} />
      <div className="card-pad">
        {stage === 1 ? (
          <>
            <div className="card-title" style={{ marginBottom: 4 }}>选择导入模式</div>
            <div className="card-sub" style={{ marginBottom: 12 }}>大多数情况用「普通导入」。商家或门店关系有变化、需要新建商家时才用结构导入。</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(260px,1fr))", gap: 12 }}>
              {card("import", "普通导入", "新增 / 更新 / 恢复门店（名称、等级、所属商家不变）；商家还不存在的行标为「需超管处理」。", false)}
              {card("structure", "结构导入", "在普通导入基础上，新建商家、更新商家名称、调整门店与商家的关系；不新建品牌、大区、分公司、板块。", !canStructure)}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
              <button type="button" className="btn btn-primary" onClick={() => setStage(2)}><Icon name="arrowRight" /> 下一步</button>
            </div>
          </>
        ) : (
          <div className="dropzone">
            <div className="state-icon"><Icon name="upload" /></div>
            <strong>上传门店信息 CSV</strong>
            <p className="hint">固定 11 列，表头必须与权威导出一致（含「门店所属商家」「门店所属商家渠道编码」；不要带「负责人」列）。GB18030 与 UTF-8 都可以。</p>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center", marginTop: 6 }}>
              <input ref={fileInput} type="file" accept=".csv,text/csv" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ""; }} />
              <button type="button" className="btn btn-primary" onClick={() => fileInput.current?.click()} disabled={pending}>
                <Icon name="upload" /> {pending ? "上传并预检中…" : "选择文件"}
              </button>
              <button type="button" className="btn" onClick={() => setHelp(true)}><Icon name="file" /> 怎么从 Excel 导出</button>
            </div>
            <p className="hint">从 xlsx 的「门店信息数据」页签另存为 CSV；不要在 Excel 里重新排列列。单个文件 ≤ 10,000 行、≤ 10 MB。当前模式：{mode === "structure" ? "结构导入" : "普通导入"}。</p>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setStage(1)}>上一步</button>
            {error ? (
              <div className="callout danger" role="alert" style={{ marginTop: 12, textAlign: "left" }}>
                <Icon name="alert" />
                <span>{error.message}{error.hint ? `（${error.hint}）` : ""}（错误码 {error.code}）</span>
              </div>
            ) : null}
          </div>
        )}
      </div>
      <Dialog open={help} title="怎么从 Excel 导出" onClose={() => setHelp(false)} foot={<button type="button" className="btn" onClick={() => setHelp(false)}>关闭</button>}>
        <ol className="hint" style={{ paddingLeft: 18, lineHeight: 1.9 }}>
          <li>打开权威信息 xlsx 的「门店信息数据」页签。</li>
          <li>如果有「负责人」列，先整列删除。</li>
          <li>文件 → 另存为 → CSV（UTF-8 或 GB18030 都可以）。</li>
          <li>不要在 Excel 里重新排列列；门店编码列先设为文本格式。</li>
        </ol>
      </Dialog>
    </>
  );
}
