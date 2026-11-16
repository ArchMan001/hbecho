"use client";
// 向导第 3 页 · 理解与执行：按需添加音频 ASR 判定 / 评论要求，然后「确认执行」= 发布草稿并执行（design §14 第 2 项）。
import type { Config } from "../../../modules/judgement/config";
import type { CircleBrief } from "../../../modules/judgement/views";
import * as C from "../../_lib/judgement-config";
import { BLOCKER } from "../../_lib/judgement-labels";
import { n as fmt } from "../../_lib/plan-labels";
import { Icon } from "../icon";
import { Callout, PageHead } from "../ui";
import { ExecuteButton, RollbackButton } from "./dialogs";
import { useConfigEditor } from "./use-config-editor";
import { AddMenu, CapHead, SaveBadge, WordEditor } from "./wizard-common";

export interface Step3Props {
  planId: string;
  alias: string;
  sub: string;
  version: number;
  initial: Config;
  canWrite: boolean;
  circle: CircleBrief | null;
  publish: { ready: boolean; blockers: string[] } | null;
  rollbackLabel: string | null;
}

export function WizardStep3({ planId, alias, sub, version, initial, canWrite, circle, publish, rollbackLabel }: Step3Props) {
  const ed = useConfigEditor(planId, initial, canWrite);
  const c = ed.config;
  const dis = !canWrite;
  const asr = c.contentRequirement?.layer3;
  const cm = c.commentRequirement;
  const blockers = publish?.blockers ?? [];
  const confirm = (
    <ExecuteButton
      info={{ planId, alias, draftVersion: version, publishedVersion: null, contents: circle?.contents ?? null, participants: circle?.participants ?? null, hasAsr: Boolean(asr) }}
      disabled={dis || ed.busy || publish === null}
      blockers={ed.busy ? [] : blockers}
    />
  );
  const actions = (
    <>
      {canWrite && rollbackLabel ? <RollbackButton planId={planId} label={rollbackLabel} /> : null}
      {canWrite ? confirm : <span className="badge gray">只读</span>}
    </>
  );
  const ratio = cm?.method.type === "ratio";

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
          <div className="card">
            <div className="card-head">
              <div>
                <div className="card-title">第 3 页 · 理解与执行</div>
                <div className="card-sub">确认执行即发布新版本；评论只对通过前两层的内容采集</div>
              </div>
              {publish?.ready ? <span className="badge green">可执行</span> : <span className="badge amber">{publish ? "有阻塞项" : "待确认"}</span>}
            </div>
            <div className="card-pad">
              <div className="section-head">
                <div>
                  <div className="card-title">第 3 层能力</div>
                  <div className="card-sub">按需添加；没有能力时第 3 页视为空配置</div>
                </div>
                <AddMenu
                  label="添加能力"
                  disabled={dis}
                  items={[
                    { key: "asr", title: "音频 ASR 判定", text: asr ? "已添加" : "口播转写 + 大模型判定（付费调用）", disabled: Boolean(asr), onPick: () => ed.edit(C.addAsr, { now: true }) },
                    { key: "cm", title: "评论要求", text: cm ? "已添加" : "对通过前两层的内容的一级评论做关键词判定", disabled: Boolean(cm), onPick: () => ed.edit(C.addComment, { now: true }) },
                  ]}
                />
              </div>
              <div style={{ marginTop: 12 }}>
                {asr ? (
                  <div className="condition capability">
                    <CapHead idx={0} icon="sparkles" name="音频 ASR" alias={asr.alias ?? ""} placeholder="例如：口播卖点判定" disabled={dis} onAlias={(v) => ed.edit((x) => C.setAsrAlias(x, v))} onRemove={() => ed.edit(C.removeAsr, { now: true })} />
                    <div className="insp-body single">
                      <div className="settings">
                        <div className="field" style={{ marginBottom: 0 }}>
                          <label htmlFor="asr-text">判定标准</label>
                          <textarea id="asr-text" className="textarea" rows={3} maxLength={2000} value={asr.standardText} disabled={dis} placeholder="例如：口播要提到品牌名，并说明活动优惠。" onChange={(e) => ed.edit((x) => C.setAsrText(x, e.target.value))} />
                          <div className="hint">1–2000 字；每个计划最多一个音频判定项；用固定提示词 + 该标准 + 模型版本判定，不做多轮对话。</div>
                        </div>
                        {blockers.includes("not_executable") ? <Callout icon="alert" tone="warn">音频理解当前不可用：含第 3 层的计划不能发布，也不会发起付费调用。</Callout> : null}
                      </div>
                    </div>
                  </div>
                ) : null}
                {cm ? (
                  <div className="condition capability">
                    <CapHead idx={asr ? 1 : 0} icon="file" name="评论要求" alias={cm.alias ?? ""} placeholder="例如：安装与售后评论" disabled={dis} onAlias={(v) => ed.edit((x) => C.patchComment(x, (r) => C.aliasOf(r, v)))} onRemove={() => ed.edit(C.removeComment, { now: true })} />
                    <div className="insp-body single">
                      <div className="settings">
                        <div className="cap-grid three">
                          <div className="field">
                            <label>组合方式</label>
                            <select className="select" value={cm.mode} disabled={dis} onChange={(e) => ed.edit((x) => C.patchComment(x, (r) => ({ ...r, mode: e.target.value as "any" | "all" })))}>
                              <option value="any">任一词命中</option>
                              <option value="all">全部词命中</option>
                            </select>
                          </div>
                          <div className="field">
                            <label>评论达标方式</label>
                            <select className="select" value={cm.method.type} disabled={dis} onChange={(e) => ed.edit((x) => C.patchComment(x, (r) => ({ ...r, method: C.methodOf(e.target.value as C.Method["type"], r.method) })))}>
                              <option value="at_least_n">至少 N 条</option>
                              <option value="all">全部通过</option>
                              <option value="any">任一条通过</option>
                              <option value="ratio">比例阈值</option>
                            </select>
                          </div>
                          <div className="field">
                            <label>{ratio ? "比例（%）" : "N（条）"}</label>
                            {cm.method.type === "at_least_n" ? (
                              <input className="input" type="number" min={1} value={cm.method.n} disabled={dis} onChange={(e) => ed.edit((x) => C.patchComment(x, (r) => ({ ...r, method: { type: "at_least_n", n: Math.max(1, Math.floor(Number(e.target.value)) || 1) } })))} />
                            ) : cm.method.type === "ratio" ? (
                              <input className="input" type="number" min={0.01} max={100} step={0.01} value={cm.method.bp / 100} disabled={dis} onChange={(e) => ed.edit((x) => C.patchComment(x, (r) => ({ ...r, method: { type: "ratio", bp: Math.min(10000, Math.max(1, Math.round(Number(e.target.value) * 100) || 1)) } })))} />
                            ) : (
                              <input className="input" value="—" disabled aria-label="该方式不需要数值" />
                            )}
                          </div>
                        </div>
                        <WordEditor label="评论关键词" words={cm.keywords} disabled={dis} placeholder="输入关键词，回车添加" onAdd={(v) => ed.edit((x) => C.patchComment(x, (r) => ({ ...r, keywords: C.addKeyword(r.keywords, v) })), { now: true })} onRemove={(v) => ed.edit((x) => C.patchComment(x, (r) => ({ ...r, keywords: r.keywords.filter((k) => k !== v) })), { now: true })} />
                        <div className="hint">评论只对通过第 1、2 层的内容采集；不保存评论原文与作者；覆盖不全的缺口计入未获取成功。</div>
                      </div>
                    </div>
                  </div>
                ) : null}
                {!asr && !cm ? (
                  <div className="empty-card">
                    <h3>第 3 页没有额外能力</h3>
                    <p>数量要求已在第 1 层能力里配置，可以直接确认执行。</p>
                  </div>
                ) : null}
              </div>
              <div className="card card-pad" style={{ background: "var(--surface-sunken)", borderStyle: "dashed", marginTop: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                  <span className="hint">将执行</span>
                  <b className="num">{circle ? `${fmt(circle.contents)} 条内容 · ${fmt(circle.participants)} 名参与专员` : "—"}</b>
                </div>
                <div className="hint" style={{ marginTop: 4 }}>执行期间名单冻结；采集等待有上限；1.0 不展示费用预估。</div>
              </div>
              {blockers.length && !ed.busy ? (
                <div className="callout danger" role="alert" style={{ marginTop: 12 }}>
                  <Icon name="alert" />
                  <span>现在不能确认执行：{blockers.map((b) => BLOCKER[b] ?? b).join("；")}</span>
                </div>
              ) : null}
              {canWrite ? <div className="wizard-actions">{actions}</div> : null}
            </div>
          </div>
        </div>
        <div className="wizard-side">
          <div className="side-card">
            <div className="side-title">确认执行 = 发布</div>
            <p className="hint">存在草稿时，确认执行把草稿发布为新版本并开始执行；没有草稿时，在详情页「重新执行」对最近已发布版本再跑一次，不升版。</p>
            <div className="kv-row" style={{ marginTop: 8 }}><span className="k">当前草稿</span><span className="v">v{version}</span></div>
            <div className="kv-row"><span className="k">发布后</span><span className="v">v{version}（不可变）</span></div>
            <div className="kv-row"><span className="k">旧版本结果</span><span className="v">保留可查</span></div>
          </div>
          <div className="side-card">
            <div className="side-title">第 3 页的门槛</div>
            <p className="hint">含音频判定且该能力不可用时，发布与开始执行都会被拒并列出阻塞项；执行中途丢失能力才记未获取成功。</p>
          </div>
        </div>
      </div>
    </>
  );
}
