"use client";
// 新建判定计划弹窗（已确认原型 ui-lab/d-rule-engine/precision 的「新建判定计划」）：
// 只列本人创建的、采集中的活动计划（超管全部）；创建后直接进入向导第 1 页。
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { createJudgementPlan } from "../../_actions/judgement";
import { Dialog } from "../dialog";
import { Icon } from "../icon";
import { useToast } from "../toast";
export interface ActivityOption {
  id: string;
  name: string;
  brandName: string;
  platform: string;
}
export function CreateJudgementPlan({ options, label = "新建判定计划", buttonClass = "btn btn-primary" }: { options: ActivityOption[]; label?: string; buttonClass?: string }) {
  const [open, setOpen] = useState(false);
  const [activityPlanId, setActivityPlanId] = useState(options.length === 1 ? options[0]!.id : "");
  const [alias, setAlias] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const toast = useToast();
  const submit = () =>
    start(async () => {
      setError(null);
      let r: Awaited<ReturnType<typeof createJudgementPlan>>;
      try {
        r = await createJudgementPlan({ activityPlanId, alias, description });
      } catch {
        r = { ok: false, code: "network_error", message: "请求没有完成，请检查网络后重试" };
      }
      if (!r.ok) {
        setError({ code: r.code, message: r.message });
        return;
      }
      toast("判定计划已创建，从第 1 页开始圈定");
      setOpen(false);
      router.push(`/judgement/${r.data.planId}/wizard/1`);
    });
  return (
    <>
      <button type="button" className={buttonClass} onClick={() => setOpen(true)}>
        <Icon name="plus" /> {label}
      </button>
      <Dialog
        open={open}
        title="新建判定计划"
        onClose={() => (pending ? undefined : setOpen(false))}
        foot={
          <>
            <button type="button" className="btn" disabled={pending} onClick={() => setOpen(false)}>取消</button>
            <button type="button" className="btn btn-primary" disabled={pending || !activityPlanId || !alias.trim()} onClick={submit}>创建判定计划</button>
          </>
        }
      >
        {options.length === 0 ? (
          <p className="hint">你名下没有采集中的活动计划。判定计划只能建在自己创建的、采集中的活动计划下。</p>
        ) : (
          <div className="form-grid">
            <div className="field">
              <label htmlFor="jp-activity">所属活动计划 *</label>
              <select className="select" id="jp-activity" value={activityPlanId} onChange={(e) => setActivityPlanId(e.target.value)}>
                <option value="">请选择活动计划</option>
                {options.map((o) => (
                  <option key={o.id} value={o.id}>{o.name} · {o.brandName}</option>
                ))}
              </select>
              <span className="hint">只列出你创建的、采集中的活动计划。</span>
            </div>
            <div className="field">
              <label htmlFor="jp-alias">别名 *</label>
              <input className="input" id="jp-alias" maxLength={200} value={alias} onChange={(e) => setAlias(e.target.value)} placeholder="例如：618 主推视频考核" />
            </div>
            <div className="field">
              <label htmlFor="jp-desc">说明</label>
              <textarea className="input" id="jp-desc" rows={3} maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)} />
            </div>
            {error ? (
              <p className="field-error" role="alert">{error.message}（{error.code}）</p>
            ) : null}
          </div>
        )}
      </Dialog>
    </>
  );
}
