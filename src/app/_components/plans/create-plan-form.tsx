"use client";
// 新建活动计划表单（已确认原型 ui-lab/hbecho-ui-v2 的 renderNewPlan）。创建即发布，没有草稿；品牌 / 平台 / 板块创建后不可修改。
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { createPlan } from "../../_actions/plans";
import { Icon } from "../icon";
import { useToast } from "../toast";

export interface Option {
  value: string;
  label: string;
}

export function CreatePlanForm({ brands, platforms, sectors, today }: { brands: Option[]; platforms: Option[]; sectors: Option[]; today: string }) {
  const [brand, setBrand] = useState(brands.length === 1 ? brands[0]!.value : "");
  const [platform, setPlatform] = useState("");
  const [picked, setPicked] = useState<string[]>(sectors.map((s) => s.value)); // 默认全选
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [startsOn, setStartsOn] = useState(today);
  const [endsOn, setEndsOn] = useState("");
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const toast = useToast();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    start(async () => {
      setError(null);
      let r: Awaited<ReturnType<typeof createPlan>>;
      try {
        r = await createPlan({ brand, platform, sectors: picked, name, description, startsOn, endsOn });
      } catch {
        r = { ok: false, code: "network_error", message: "请求没有完成，请检查网络后重试" };
      }
      if (!r.ok) {
        setError({ code: r.code, message: r.message });
        return;
      }
      toast(`计划已创建并发布。${r.data.required}`);
      router.push(`/plans/${r.data.planId}`);
    });
  };
  const toggle = (v: string) => setPicked((cur) => (cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]));

  return (
    <form className="card card-pad wizard-main" onSubmit={submit}>
      <div className="form-grid">
        <div className="field">
          <label htmlFor="np-brand">品牌 *</label>
          <select className="select" id="np-brand" required value={brand} onChange={(e) => setBrand(e.target.value)}>
            <option value="">请选择品牌</option>
            {brands.map((b) => (
              <option key={b.value} value={b.value}>{b.label}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="np-platform">平台 *</label>
          <select className="select" id="np-platform" required value={platform} onChange={(e) => setPlatform(e.target.value)}>
            <option value="">请选择平台</option>
            {platforms.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
        </div>
        <div className="field span-2">
          <label id="np-sectors">板块 *（默认全选）</label>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }} role="group" aria-labelledby="np-sectors">
            {sectors.map((s) => (
              <label key={s.value} className="chip" style={{ cursor: "pointer" }}>
                <input type="checkbox" checked={picked.includes(s.value)} onChange={() => toggle(s.value)} style={{ accentColor: "#0FA3A8" }} /> {s.label}
              </label>
            ))}
          </div>
          <span className="hint">板块是计划的范围属性；要停某个板块，暂停 / 归档或删除重建。</span>
        </div>
        <div className="field span-2">
          <label htmlFor="np-name">计划名称 *</label>
          <input className="input" id="np-name" maxLength={200} placeholder="例如：2026 双十一家装专项" required value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field span-2">
          <label htmlFor="np-desc">说明</label>
          <textarea className="textarea" id="np-desc" maxLength={2000} placeholder="仅作说明，不参与判定。" value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="np-start">开始日期 *（北京时间自然日）</label>
          <input className="input" id="np-start" type="date" required value={startsOn} onChange={(e) => setStartsOn(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="np-end">结束日期</label>
          <input className="input" id="np-end" type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} />
          <span className="hint">留空表示无结束日，视为持续引用。</span>
        </div>
      </div>
      <div className="callout" style={{ marginTop: 16 }}>
        <Icon name="sparkles" />
        <span>创建后返回「本计划需要 N 份监控判定计划：&lt;板块列表&gt;」；判定计划在「判定计划」页创建。</span>
      </div>
      {error ? (
        <div className="callout danger" role="alert" style={{ marginTop: 12 }}>
          <Icon name="alert" />
          <span>{error.message}（错误码 {error.code}）</span>
        </div>
      ) : null}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
        <Link className="btn" href="/plans">取消</Link>
        <button className="btn btn-primary" type="submit" disabled={pending}>
          <Icon name="check" /> {pending ? "创建中…" : "创建并发布"}
        </button>
      </div>
    </form>
  );
}
