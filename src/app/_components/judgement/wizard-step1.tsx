"use client";
// 向导第 1 页 · 圈定：必选的时间窗与内容形态 + 按需添加的文本 / 话题 / 时长能力 + 整层共享的数量要求 N（design §15.1、JP-2）。
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { Config } from "../../../modules/judgement/config";
import type { CircleBrief } from "../../../modules/judgement/views";
import { circleJudgementPlan } from "../../_actions/judgement";
import * as C from "../../_lib/judgement-config";
import { reasonLabel } from "../../_lib/judgement-labels";
import { n as fmt } from "../../_lib/plan-labels";
import { Icon } from "../icon";
import { PageHead } from "../ui";
import { useToast } from "../toast";
import { useConfigEditor } from "./use-config-editor";
import { AddMenu, CapHead, ErrorLine, SaveBadge, WordEditor } from "./wizard-common";

export interface Step1Props {
  planId: string;
  alias: string;
  sub: string;
  version: number;
  initial: Config;
  canWrite: boolean;
  circle: CircleBrief | null;
  rosterNote: string;
}

export function WizardStep1({ planId, alias, sub, version, initial, canWrite, circle, rosterNote }: Step1Props) {
  const ed = useConfigEditor(planId, initial, canWrite);
  const c = ed.config;
  const dis = !canWrite;
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const hasImage = c.kinds.includes("image");

  const doCircle = () =>
    start(async () => {
      setError(null);
      if (!(await ed.flush())) return; // 配置没保存成功：错误已显示在保存状态里，不带着旧配置去圈定
      let r: Awaited<ReturnType<typeof circleJudgementPlan>>;
      try {
        r = await circleJudgementPlan(planId);
      } catch {
        r = { ok: false, code: "network_error", message: "请求没有完成，请检查网络后重试" };
      }
      if (!r.ok) return setError({ code: r.code, message: r.message });
      toast(`已圈定：${fmt(r.data.c1)} 条内容进入下一层`);
      router.refresh();
    });

  const circled = circle !== null && !ed.busy;
  const primary = circled ? (
    <>
      <button type="button" className="btn" onClick={doCircle} disabled={dis || pending}>
        <Icon name="refresh" /> 重新圈定
      </button>
      <Link className="btn btn-primary" href={`/judgement/${planId}/wizard/2`}>
        进入第 2 页 <Icon name="arrowRight" />
      </Link>
    </>
  ) : (
    <button type="button" className="btn btn-primary" onClick={doCircle} disabled={dis || pending || ed.busy} aria-busy={pending}>
      <Icon name="check" /> {pending ? "圈定中…" : "确认圈定"}
    </button>
  );

  type Item = { kind: "text"; i: number } | { kind: "tag"; i: number } | { kind: "duration" };
  const items: Item[] = [...c.layer1.text.map((_, i) => ({ kind: "text" as const, i })), ...c.layer1.hashtags.map((_, i) => ({ kind: "tag" as const, i })), ...(c.layer1.duration ? [{ kind: "duration" as const }] : [])];

  /** 整层共享的数量要求 N：每张文本 / 话题卡片都显示同一个值。 */
  const quantity = (
    <div className="req-field inline">
      <label>数量要求（整层共享）</label>
      <div className="req-line">
        <span>至少</span>
        <input
          className="input"
          type="number"
          min={1}
          max={1000}
          value={c.layer1.quantity?.n ?? ""}
          placeholder="—"
          disabled={dis}
          aria-label="至少命中条数"
          onChange={(e) => {
            const v = e.target.value;
            ed.edit((x) => C.setQuantity(x, v === "" ? undefined : Math.min(1000, Math.max(1, Math.floor(Number(v)) || 1))));
          }}
        />
        <span className="unit">条内容命中</span>
        <span className="req-note">留空 = 不限；同层条件先同时满足，再按点赞取前 N 条</span>
      </div>
    </div>
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
            {canWrite ? primary : <span className="badge gray">只读</span>}
          </>
        }
      />
      <div className="wizard-grid">
        <div>
          {circled ? <CircleCard circle={circle} /> : null}
          <div className="card" style={{ marginTop: circled ? 14 : 0 }}>
            <div className="card-head">
              <div>
                <div className="card-title">第 1 页 · 圈定</div>
                <div className="card-sub">只使用名单、当前归属与列表 / 主页字段；不调详情、评论、图片或模型</div>
              </div>
              {circled ? <span className="badge green">已圈定</span> : <span className="badge amber">草稿</span>}
            </div>
            <div className="card-pad">
              <div className="condition plan-conditions" style={{ background: "var(--surface-sunken)" }}>
                <div className="condition-head">
                  <div className="condition-title">计划级条件（必选）</div>
                  <span className="hint">时间窗与内容形态始终生效</span>
                </div>
                <div className="date-range">
                  <label className="date-part">
                    <span className="date-cap">起</span>
                    <input className="date-input" type="date" value={c.window.from} disabled={dis} aria-label="时间窗开始" onChange={(e) => e.target.value && ed.edit((x) => C.setWindow(x, "from", e.target.value))} />
                  </label>
                  <span className="date-sep">→</span>
                  <label className="date-part">
                    <span className="date-cap">止</span>
                    <input className="date-input" type="date" value={c.window.to ?? ""} disabled={dis} aria-label="时间窗结束" onChange={(e) => ed.edit((x) => C.setWindow(x, "to", e.target.value))} />
                  </label>
                </div>
                <div className="date-note">北京时间自然日，闭区间；创建时沿用活动计划起止日，之后独立；止留空 = 到执行冻结时刻。</div>
                <div className="field" style={{ marginTop: 14, marginBottom: 0 }}>
                  <label>内容形态</label>
                  <div className="kind-options">
                    <label className="kind-option">
                      <input type="checkbox" checked={c.kinds.includes("video")} disabled={dis} onChange={(e) => ed.edit((x) => C.toggleKind(x, "video", e.target.checked))} />
                      <span className="kind-icon"><Icon name="play" /></span>
                      <span><b>视频</b><small>抖音 / 小红书视频内容</small></span>
                    </label>
                    <label className="kind-option">
                      <input type="checkbox" checked={hasImage} disabled={dis} onChange={(e) => ed.edit((x) => C.toggleKind(x, "image", e.target.checked))} />
                      <span className="kind-icon"><Icon name="image" /></span>
                      <span><b>图文</b><small>图片 + 文字；形态未知按未获取成功计</small></span>
                    </label>
                  </div>
                </div>
              </div>

              <div className="section-head" style={{ margin: "20px 0 12px" }}>
                <div>
                  <div className="card-title">第 1 层能力</div>
                  <div className="card-sub">按需添加；同一条内容必须满足全部已添加能力</div>
                </div>
                <AddMenu
                  label="添加能力"
                  disabled={dis}
                  items={[
                    { key: "text", title: "文本识别", text: "标题 / 正文里的关键词，全部或任一命中", onPick: () => ed.edit(C.addText, { now: true }) },
                    { key: "tag", title: "话题识别", text: "话题标签，按归一化后整体相等比较", onPick: () => ed.edit(C.addHashtag, { now: true }) },
                    { key: "dur", title: "视频时长", text: c.layer1.duration ? "已添加" : "最短 / 最长秒数，含边界", disabled: Boolean(c.layer1.duration), onPick: () => ed.edit(C.addDuration, { now: true }) },
                  ]}
                />
              </div>

              {items.length === 0 ? (
                <div className="empty-card">
                  <h3>还没有添加筛选能力</h3>
                  <p>只按时间窗与内容形态圈定；需要时点「添加能力」。</p>
                </div>
              ) : null}

              {items.map((it, n) => {
                if (it.kind === "text") {
                  const x = c.layer1.text[it.i]!;
                  return (
                    <div key={`t${it.i}`} className="condition capability">
                      <CapHead idx={n} icon="file" name="文本识别" alias={x.alias ?? ""} placeholder="例如：主推卖点文本" disabled={dis} onAlias={(v) => ed.edit((s) => C.patchText(s, it.i, (t) => C.aliasOf(t, v)))} onRemove={() => ed.edit((s) => C.removeText(s, it.i), { now: true })} />
                      <div className="insp-body single">
                        <div className="settings">
                          <div className="cap-grid ability-row">
                            <div className="field">
                              <label>文本位置</label>
                              <div className="toggle-group">
                                {(["title", "body"] as const).map((f) => (
                                  <label key={f} className="toggle">
                                    <input
                                      type="checkbox"
                                      checked={x.fields.includes(f)}
                                      disabled={dis}
                                      onChange={(e) => ed.edit((s) => C.patchText(s, it.i, (t) => ({ ...t, fields: e.target.checked ? [...t.fields.filter((y) => y !== f), f] : t.fields.length > 1 ? t.fields.filter((y) => y !== f) : t.fields })))}
                                    />
                                    <span>{f === "title" ? "标题" : "正文"}</span>
                                  </label>
                                ))}
                              </div>
                            </div>
                            <div className="field">
                              <label>组合方式</label>
                              <select className="select" value={x.mode} disabled={dis} onChange={(e) => ed.edit((s) => C.patchText(s, it.i, (t) => ({ ...t, mode: e.target.value as "any" | "all" })))}>
                                <option value="any">任一词命中</option>
                                <option value="all">全部词命中</option>
                              </select>
                            </div>
                            {quantity}
                          </div>
                          <WordEditor label="关键词" words={x.keywords} disabled={dis} placeholder="输入关键词，回车添加" onAdd={(v) => ed.edit((s) => C.patchText(s, it.i, (t) => ({ ...t, keywords: C.addKeyword(t.keywords, v) })), { now: true })} onRemove={(v) => ed.edit((s) => C.patchText(s, it.i, (t) => ({ ...t, keywords: t.keywords.filter((k) => k !== v) })), { now: true })} />
                        </div>
                      </div>
                    </div>
                  );
                }
                if (it.kind === "tag") {
                  const x = c.layer1.hashtags[it.i]!;
                  return (
                    <div key={`h${it.i}`} className="condition capability">
                      <CapHead idx={n} icon="tag" name="话题识别" alias={x.alias ?? ""} placeholder="例如：活动话题" disabled={dis} onAlias={(v) => ed.edit((s) => C.patchHashtag(s, it.i, (t) => C.aliasOf(t, v)))} onRemove={() => ed.edit((s) => C.removeHashtag(s, it.i), { now: true })} />
                      <div className="insp-body single">
                        <div className="settings">
                          <div className="cap-grid ability-row two">
                            <div className="field">
                              <label>组合方式</label>
                              <select className="select" value={x.mode} disabled={dis} onChange={(e) => ed.edit((s) => C.patchHashtag(s, it.i, (t) => ({ ...t, mode: e.target.value as "any" | "all" })))}>
                                <option value="any">任一话题</option>
                                <option value="all">全部话题</option>
                              </select>
                            </div>
                            {quantity}
                          </div>
                          <WordEditor label="话题" prefix="#" words={x.values} disabled={dis} placeholder="输入话题，不用带 #" onAdd={(v) => ed.edit((s) => C.patchHashtag(s, it.i, (t) => ({ ...t, values: C.addKeyword(t.values, v) })), { now: true })} onRemove={(v) => ed.edit((s) => C.patchHashtag(s, it.i, (t) => ({ ...t, values: t.values.filter((k) => k !== v) })), { now: true })} />
                          <div className="hint">话题按归一化后整体相等比较，不做子串：「618」不匹配「618大促」。</div>
                        </div>
                      </div>
                    </div>
                  );
                }
                const d = c.layer1.duration!;
                return (
                  <div key="dur" className="condition capability">
                    <CapHead idx={n} icon="clock" name="视频时长" alias={d.alias ?? ""} placeholder="例如：主推视频时长" disabled={dis} onAlias={(v) => ed.edit((s) => C.patchDuration(s, (t) => C.aliasOf(t, v)))} onRemove={() => ed.edit(C.removeDuration, { now: true })}>
                      <span className="hint" style={{ margin: 0 }}>{d.minSeconds ?? 0}–{d.maxSeconds ?? "不限"} 秒</span>
                    </CapHead>
                    <div className="insp-body single">
                      <div className="settings">
                        <div className="cap-grid two">
                          {(["minSeconds", "maxSeconds"] as const).map((b) => (
                            <div key={b} className="field">
                              <label>{b === "minSeconds" ? "最短（秒）" : "最长（秒）"}</label>
                              <input className="input" type="number" min={0} value={d[b] ?? ""} disabled={dis || hasImage} onChange={(e) => ed.edit((s) => C.patchDuration(s, (t) => C.setDurationBound(t, b, e.target.value)))} />
                            </div>
                          ))}
                        </div>
                        <div className="hint">含边界；单位未知或状态缺失按未获取成功计，真实 0 秒有效。</div>
                        {hasImage ? <div className="callout warn"><Icon name="alert" /><span>含图文时不能配置视频时长：请取消「图文」，或删除这张卡片。</span></div> : null}
                      </div>
                    </div>
                  </div>
                );
              })}
              <ErrorLine error={error} />
              {pending ? <div className="progress-bar indeterminate" style={{ marginTop: 12 }}><i /></div> : null}
              {canWrite ? <div className="wizard-actions">{primary}</div> : null}
            </div>
          </div>
        </div>
        <div className="wizard-side">
          <div className="side-card">
            <div className="side-title">名单与范围</div>
            <p className="hint">{rosterNote}</p>
            <p className="hint" style={{ marginTop: 8 }}>名单项里的组织字段只是加入当时的快照，仅用于可见范围；执行时按账号当前归属计算。</p>
          </div>
          <div className="side-card">
            <div className="side-title">圈定说明</div>
            <p className="hint">圈定不触发任何外部调用：不调采集、不补算、不读图、不调模型。它只读名单、当前归属与已有的文本信号。</p>
            <p className="hint" style={{ marginTop: 8 }}>重新圈定会替换上一次的圈定结果；圈定结果按保留期清理。</p>
          </div>
        </div>
      </div>
    </>
  );
}

function CircleCard({ circle }: { circle: CircleBrief }) {
  const reasons = Object.entries(circle.byReason).sort((a, b) => b[1] - a[1]);
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <div className="card-title">圈定结果</div>
          <div className="card-sub">同步运算，没有外部调用</div>
        </div>
        <span className="badge green">已圈定</span>
      </div>
      <div className="card-pad">
        <div className="stat-grid" style={{ marginBottom: 12 }}>
          <div className="stat"><div className="stat-label">圈定内容（C1）</div><div className="stat-value">{fmt(circle.c1)}</div><div className="stat-hint">第 1 层通过</div></div>
          <div className="stat"><div className="stat-label">参与专员</div><div className="stat-value">{fmt(circle.participants)}</div><div className="stat-hint">执行时冻结名单</div></div>
          <div className="stat"><div className="stat-label">参与内容</div><div className="stat-value">{fmt(circle.contents)}</div><div className="stat-hint">窗口内、形态符合</div></div>
          <div className="stat"><div className="stat-label">未获取成功</div><div className="stat-value">{fmt(circle.unobtained)}</div><div className="stat-hint">不计入不达标</div></div>
        </div>
        <div className="hint" style={{ marginBottom: 6 }}>未获取成功的原因</div>
        <div className="kw-list">
          {reasons.length === 0 ? <span className="hint">没有未获取成功的内容。</span> : reasons.map(([code, count]) => <span key={code} className="kw" style={{ paddingRight: 9 }}>{reasonLabel(code)}&nbsp;<b className="num">{fmt(count)}</b></span>)}
        </div>
        <div className="wizard-actions" style={{ justifyContent: "flex-start" }}>
          <button type="button" className="btn" disabled title="圈定结果的下载由 E 的导出提供（需要 report.export），E 上线后在这里接入">
            <Icon name="download" /> 下载圈定结果（E 导出）
          </button>
        </div>
      </div>
    </div>
  );
}
