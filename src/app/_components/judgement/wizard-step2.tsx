"use client";
// 向导第 2 页 · 比对：按需添加整张图片对比 / 图片元素对比（图片文字对比是 2.0，1.0 不可添加）；
// 每个能力先选对比元素，再上传素材、调阈值；试跑只对第 1 层留下的 C1 比对，不触发第 3 层、不产生付费调用。
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import type { Config, Ability } from "../../../modules/judgement/config";
import type { TrialAbilityView, TrialBrief } from "../../../modules/judgement/views";
import { removeAbilityImage, trialJudgementPlan, uploadAbilityImage } from "../../_actions/judgement";
import * as C from "../../_lib/judgement-config";
import { ABILITY_LABEL, TARGET_LABEL, reasonLabel } from "../../_lib/judgement-labels";
import { n as fmt } from "../../_lib/plan-labels";
import { Icon } from "../icon";
import { useToast } from "../toast";
import { PageHead } from "../ui";
import { RollbackButton } from "./dialogs";
import { useConfigEditor, type ConfigEditor } from "./use-config-editor";
import { AddMenu, CapHead, ErrorLine, SaveBadge } from "./wizard-common";

export interface Step2Props {
  planId: string;
  alias: string;
  sub: string;
  version: number;
  initial: Config;
  canWrite: boolean;
  /** 活动计划平台：头像 / 主页背景只对抖音可用 */
  platform: string;
  uploaded: Record<string, boolean>;
  trial: TrialBrief | null;
  trialRun: { status: string; lastErrorCode: string | null } | null;
  rollbackLabel: string | null;
}
const MAX_IMAGE = 10 * 1024 * 1024;
type Err = { code: string; message: string } | null;
const net = { ok: false as const, code: "network_error", message: "请求没有完成，请检查网络后重试" };

export function WizardStep2({ planId, alias, sub, version, initial, canWrite, platform, uploaded, trial, trialRun, rollbackLabel }: Step2Props) {
  const ed = useConfigEditor(planId, initial, canWrite);
  const c = ed.config;
  const dis = !canWrite;
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [error, setError] = useState<Err>(null);
  const caps = c.layer2.abilities;
  const running = trialRun !== null && ["planned", "running", "waiting"].includes(trialRun.status);
  const allReady = caps.every((a) => uploaded[a.abilityId] === true);

  // 试跑由后台领取：页面每 3 秒刷新一次，直到出结果或失败
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => router.refresh(), 3000);
    return () => clearInterval(t);
  }, [running, router]);

  const doTrial = () =>
    start(async () => {
      setError(null);
      if (!(await ed.flush())) return;
      let r: Awaited<ReturnType<typeof trialJudgementPlan>>;
      try {
        r = await trialJudgementPlan(planId);
      } catch {
        r = net;
      }
      if (!r.ok) return setError(r);
      toast("已提交试跑");
      router.refresh();
    });

  const hasTrial = trial !== null && !ed.busy;
  const primary =
    caps.length === 0 || hasTrial ? (
      <Link className="btn btn-primary" href={`/judgement/${planId}/wizard/3`}>
        进入第 3 页 <Icon name="arrowRight" />
      </Link>
    ) : (
      <button type="button" className="btn btn-primary" onClick={doTrial} disabled={dis || pending || running || ed.busy || !allReady} aria-busy={pending || running}>
        <Icon name="play" /> {running ? "试跑中…" : "开始试跑"}
      </button>
    );
  const actions = (
    <>
      {canWrite && rollbackLabel ? <RollbackButton planId={planId} label={rollbackLabel} /> : null}
      {canWrite ? primary : <span className="badge gray">只读</span>}
    </>
  );

  return (
    <>
      <PageHead
        title={
          <>
            {alias} <span className="badge amber">草稿 v{version}</span>
          </>
        }
        sub={sub}
        actions={
          <>
            <SaveBadge state={ed.state} />
            {actions}
          </>
        }
      />
      <div className="wizard-grid">
        <div>
          {running ? (
            <div className="callout" role="status" style={{ marginBottom: 14 }}>
              <Icon name="clock" />
              <span>
                试跑{trialRun?.status === "planned" ? "已排队，等待后台领取" : "进行中"}，页面会自动更新。
                <div className="progress-bar indeterminate" style={{ marginTop: 8 }}><i /></div>
              </span>
            </div>
          ) : null}
          {trialRun && trialRun.status === "failed" ? (
            <div className="callout danger" role="alert" style={{ marginBottom: 14 }}>
              <Icon name="alert" />
              <span>试跑失败{trialRun.lastErrorCode ? `（错误码 ${trialRun.lastErrorCode}）` : ""}。检查素材后可以重新试跑。</span>
            </div>
          ) : null}
          {hasTrial ? trial.abilities.map((a) => <DistCard key={a.abilityId} view={a} ability={caps.find((x) => x.abilityId === a.abilityId)} c1={trial.c1} />) : null}
          <div className="card" style={{ marginTop: hasTrial ? 14 : 0 }}>
            <div className="card-head">
              <div>
                <div className="card-title">第 2 页 · 比对</div>
                <div className="card-sub">只对第 1 层留下的 C1 做比对；试跑不触发第 3 层，不产生付费调用</div>
              </div>
              {hasTrial ? <span className="badge green">已比对</span> : <span className="badge amber">待试跑</span>}
            </div>
            <div className="card-pad">
              <div className="section-head">
                <div>
                  <div className="card-title">比对能力</div>
                  <div className="card-sub">按需添加；每个能力先选对比元素，再上传素材</div>
                </div>
                <AddMenu
                  label="添加能力"
                  disabled={dis}
                  items={[
                    { key: "whole", title: "整张图片对比", text: "目标图片与标准图整体比对，按相似度判定是否一致", onPick: () => ed.edit((x) => C.addAbility(x, "whole_image"), { now: true }) },
                    { key: "elem", title: "图片元素对比", text: "检查目标图片中是否出现指定元素，按元素匹配度判定", onPick: () => ed.edit((x) => C.addAbility(x, "image_element"), { now: true }) },
                    { key: "text", title: "图片文字对比（2.0）", text: "1.0 暂不开放", disabled: true, onPick: () => undefined },
                  ]}
                />
              </div>
              <div style={{ marginTop: 12 }}>
                {caps.length === 0 ? (
                  <div className="empty-card">
                    <h3>第 2 页没有比对能力</h3>
                    <p>可以只按第 1 层条件判定，直接进入第 3 页。</p>
                  </div>
                ) : (
                  caps.map((a, n) => <AbilityCard key={a.abilityId} idx={n} ability={a} ed={ed} planId={planId} dis={dis} platform={platform} uploaded={uploaded[a.abilityId] === true} onError={setError} />)
                )}
              </div>
              <ErrorLine error={error} />
              {canWrite ? <div className="wizard-actions">{actions}</div> : null}
            </div>
          </div>
        </div>
        <div className="wizard-side">
          <div className="side-card">
            <div className="side-title">试跑说明</div>
            <div className="kv-row"><span className="k">输入</span><span className="v">圈定留下的 C1</span></div>
            <div className="kv-row"><span className="k">第 3 层</span><span className="v">不触发</span></div>
            <div className="kv-row"><span className="k">费用</span><span className="v">图片匹配不产生付费调用</span></div>
            <p className="hint" style={{ marginTop: 8 }}>试跑由后台领取并运行，运行期间可以离开页面。试跑结果与圈定结果一样按保留期清理。</p>
          </div>
          <div className="side-card">
            <div className="side-title">素材缺失</div>
            <p className="hint">封面 / 头像 / 主页背景未归档或下载失败时，该对象记「未获取成功」，并带原因。头像与主页背景只对抖音可用。</p>
          </div>
        </div>
      </div>
    </>
  );
}

function AbilityCard({ idx, ability: a, ed, planId, dis, platform, uploaded, onError }: { idx: number; ability: Ability; ed: ConfigEditor; planId: string; dis: boolean; platform: string; uploaded: boolean; onError: (e: Err) => void }) {
  const router = useRouter();
  const toast = useToast();
  const file = useRef<HTMLInputElement>(null);
  const [busy, start] = useTransition();
  const isElement = a.kind === "image_element";
  const douyin = platform === "douyin";
  const upload = (f: File) =>
    start(async () => {
      onError(null);
      if (f.size > MAX_IMAGE) return onError({ code: "image_too_large", message: "图片不能超过 10 MiB" });
      if (!(await ed.flush())) return; // 先把这个能力存到草稿，再上传
      const form = new FormData();
      form.set("planId", planId);
      form.set("abilityId", a.abilityId);
      form.set("file", f);
      let r: Awaited<ReturnType<typeof uploadAbilityImage>>;
      try {
        r = await uploadAbilityImage(form);
      } catch {
        r = net;
      }
      if (!r.ok) return onError(r);
      toast(isElement ? "元素图已上传，试跑结果已失效" : "标准图已上传，试跑结果已失效");
      router.refresh();
    });
  const remove = () =>
    start(async () => {
      onError(null);
      if (!(await ed.flush())) return;
      let r: Awaited<ReturnType<typeof removeAbilityImage>>;
      try {
        r = await removeAbilityImage(planId, a.abilityId);
      } catch {
        r = net;
      }
      if (!r.ok) return onError(r);
      router.refresh();
    });
  const setThreshold = (text: string) => C.isThresholdText(text) && ed.edit((x) => C.patchAbility(x, a.abilityId, (y) => ({ ...y, threshold: text })));
  const [raw, setRaw] = useState(a.threshold);
  useEffect(() => setRaw(a.threshold), [a.threshold]);
  const num = Number(a.threshold);
  const pct = Math.max(0, Math.min(100, Number.isFinite(num) ? num * 10 : 0));
  const bump = (d: number) => setThreshold(C.thresholdText(num + d));

  const uploadBox = (
    <div className={`upload ${uploaded ? "has" : ""}`} onClick={() => !dis && !busy && file.current?.click()} role="button" tabIndex={0} aria-label={isElement ? "上传元素图" : "上传标准图"} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && !dis && file.current?.click()}>
      <input ref={file} type="file" accept="image/*" hidden onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
      {uploaded ? (
        <div className="thumb" data-label={isElement ? "元素图 · 已上传" : "标准图 · 已上传"}>
          <div className="thumb-mark"><Icon name="image" /></div>
        </div>
      ) : (
        <>
          <Icon name="upload" />
          <div className="upload-title">{busy ? "上传中…" : isElement ? "上传元素图" : "上传标准图"}</div>
          <div className="upload-hint">≤ 10 MiB · 可解码的图片</div>
        </>
      )}
    </div>
  );

  return (
    <div className="condition capability">
      <CapHead idx={idx} icon={isElement ? "layers" : "image"} name={ABILITY_LABEL[a.kind] ?? "比对能力"} alias={a.alias ?? ""} placeholder="例如：封面视觉规范" disabled={dis} onAlias={(v) => ed.edit((x) => C.patchAbility(x, a.abilityId, (y) => C.aliasOf(y, v)))} onRemove={() => ed.edit((x) => C.removeAbility(x, a.abilityId), { now: true })}>
        <div className="target-picker" role="radiogroup" aria-label="对比元素">
          <span className="target-label">对比元素</span>
          {(["avatar", "cover", "background"] as const).map((t) => {
            const off = !douyin && t !== "cover";
            return (
              <label key={t} className="target-chip" title={off ? "仅抖音可用" : TARGET_LABEL[t]}>
                <input type="radio" name={`target-${a.abilityId}`} checked={a.target === t} disabled={dis || off} onChange={() => ed.edit((x) => C.patchAbility(x, a.abilityId, (y) => C.setTarget(y, t)), { now: true })} />
                <span>{TARGET_LABEL[t]}</span>
              </label>
            );
          })}
        </div>
      </CapHead>
      <div className="insp-body">
        <div>
          {uploadBox}
          {uploaded && !dis ? (
            <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
              <button type="button" className="btn btn-sm" onClick={() => file.current?.click()} disabled={busy}>替换</button>
              <button type="button" className="btn btn-sm" onClick={remove} disabled={busy}>移除</button>
            </div>
          ) : null}
        </div>
        <div className="settings">
          <div className="threshold">
            <div className="th-head">
              <label htmlFor={`th-${a.abilityId}`}>匹配阈值</label>
              <span>SCORE 0–10</span>
            </div>
            <div className="th-row">
              <button type="button" className="step-btn" onClick={() => bump(-0.1)} disabled={dis} aria-label="阈值减 0.10">−</button>
              <input
                id={`th-${a.abilityId}`}
                className="score"
                value={raw}
                disabled={dis}
                inputMode="decimal"
                onChange={(e) => {
                  setRaw(e.target.value);
                  setThreshold(e.target.value);
                }}
                onBlur={() => setRaw(a.threshold)}
                aria-label="匹配阈值"
              />
              <button type="button" className="step-btn" onClick={() => bump(0.1)} disabled={dis} aria-label="阈值加 0.10">+</button>
              <div className="gauge-wrap">
                <div className="gauge"><i style={{ width: `${pct}%` }} /><b style={{ left: `${pct}%` }} /></div>
                <input type="range" className="threshold-range" min={0} max={10} step={0.01} value={Number.isFinite(num) ? num : 0} disabled={dis} aria-label="拖动调整匹配阈值" onChange={(e) => setThreshold(C.thresholdText(Number(e.target.value)))} />
              </div>
            </div>
            <div className="th-scale"><span>0</span><span>5</span><span>10</span></div>
            <p className="th-hint">{a.target === "cover" ? "等于阈值判通过；调整阈值不需要重新试跑。" : "账号图片要求与内容层并行，不依赖内容层；调整阈值不需要重新试跑。"}</p>
          </div>
        </div>
      </div>
    </div>
  );
}

/** 试跑结果：连续 0–10 分按 11 档统计，阈值线以上高亮；每档固定 5 个样例槽位，不足从第一个槽位起。 */
function DistCard({ view, ability, c1 }: { view: TrialAbilityView; ability: Ability | undefined; c1: number }) {
  const [bucket, setBucket] = useState(8);
  const threshold = ability ? Number(ability.threshold) : view.thresholdCents / 100;
  const cut = Math.ceil(threshold);
  const max = Math.max(1, ...view.counts);
  const total = view.counts.reduce((x, y) => x + y, 0);
  const samples = view.samples[bucket] ?? [];
  const unit = view.subject === "content" ? "条内容" : "个账号";
  const title = `${view.alias ? `${view.alias} · ` : ""}${ABILITY_LABEL[view.kind] ?? view.kind} · ${TARGET_LABEL[view.target] ?? view.target}`;
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="card-head">
        <div>
          <div className="card-title">{title}</div>
          <div className="card-sub">连续 0.00–10.00；11 档只用于选阈值与看样例，不改变存储精度 · 对象：第 1 层留下的 {fmt(c1)} 条内容</div>
        </div>
        <span className="num hint">阈值 {ability?.threshold ?? (view.thresholdCents / 100).toFixed(2)}</span>
      </div>
      <div className="card-pad">
        <div className="dist" role="img" aria-label={`分数分布：${view.counts.join("、")}`}>
          {view.counts.map((v, i) => (
            <div key={i} className="dist-col">
              <div className="dist-count">{fmt(v)}</div>
              <div className={`dist-bar ${i >= cut ? "above" : ""}`} style={{ height: `${Math.max(4, Math.round((v / max) * 82))}%` }} />
              <div className="dist-label">{i}</div>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginTop: 10 }}>
          <span className="badge green">高于阈值 {fmt(view.pass)} {unit}</span>
          <span className="badge gray">未获取成功 {fmt(view.unobtained.total)} {unit}</span>
          <span className="hint">共 {fmt(total + view.unobtained.total)} {unit}参与比对</span>
          <span className="inline-field" style={{ marginLeft: "auto" }}>
            <label className="hint" htmlFor={`bk-${view.abilityId}`}>样例档位</label>
            <select id={`bk-${view.abilityId}`} className="select" style={{ width: 88 }} value={bucket} onChange={(e) => setBucket(Number(e.target.value))}>
              {Array.from({ length: 11 }, (_, i) => <option key={i} value={i}>{i}</option>)}
            </select>
          </span>
        </div>
        {Object.keys(view.unobtained.byReason).length ? (
          <div className="kw-list" style={{ marginTop: 8 }}>
            {Object.entries(view.unobtained.byReason).map(([code, n]) => <span key={code} className="kw" style={{ paddingRight: 9 }}>{reasonLabel(code)}&nbsp;<b>{fmt(n)}</b></span>)}
          </div>
        ) : null}
        <div className="samples fixed">
          {Array.from({ length: 5 }, (_, i) => {
            const id = samples[i];
            return (
              <div key={i} className="sample">
                <div className="thumb small">{id ? <Icon name="image" /> : <span className="hint">空</span>}</div>
                <div className="sample-row">
                  <span className="sample-id">{id ? `#${id}` : `样例 ${i + 1}`}</span>
                  <span className="sample-score">{id ? `${bucket} 档` : "—"}</span>
                </div>
              </div>
            );
          })}
        </div>
        {samples.length === 0 ? <div className="hint" style={{ marginTop: 6 }}>该档暂无样例。</div> : null}
      </div>
    </div>
  );
}
