// 学习平台页面：学习中心、课程详情、课程管理、新建/编辑、学习汇总、标签管理。
// 只渲染；动作由 app.js 统一接管。

import { state } from "./store.js";
import {
  BRANDS, TAGS, COURSES, TAG_USAGE, SUMMARY, ROLE_BRANDS, LEVELS,
  COURSE_STATUS, VOD_STATUS, KIND, brandScopeLabel, levelLabel, canRead, isPlayable,
  progressFor, getCourse,
} from "./data.js";
import {
  icon, esc, badge, renderShell, stateAware, emptyState, deniedState,
  dataCell, filterToggle,
} from "./ui.js";

const canManage = (role = state.role) => role === "platform_admin" || role === "hq_manager";
const canSummary = (role = state.role) => canManage(role);
const canTags = (role = state.role) => role === "platform_admin";

function clock(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function learningTabs(active) {
  const items = [
    ["center", "学习中心", true, "#/learning"],
    ["manage", "课程管理", canManage(), "#/learning/manage"],
    ["summary", "学习汇总", canSummary(), "#/learning/summary"],
    ["tags", "标签管理", canTags(), "#/learning/tags"],
  ].filter(([, , ok]) => ok);
  return `
    <div class="tabs learning-tabs" role="tablist" aria-label="学习页面">
      ${items.map(([key, label, , href]) => `<a class="tab ${active === key ? "active" : ""}" href="${href}">${esc(label)}</a>`).join("")}
    </div>
  `;
}

function shell(active, breadcrumb, content) {
  return renderShell({ activeNav: "learning", breadcrumb: ["工作区", "学习", ...breadcrumb], content });
}

function deniedPage(title, text) {
  return `
    <div class="page-head"><div><h1 class="page-title">${esc(title)}</h1></div></div>
    ${deniedState(text)}
  `;
}

/* ---------- 学习中心 ---------- */

function visibleCourses(role = state.role) {
  return COURSES.filter((c) => canRead(c, role) && isPlayable(c));
}

function courseCard(course) {
  const progress = progressFor(course.id, state.role);
  const kind = KIND[course.kind];
  const meta = course.kind === "video" ? `视频 · ${course.duration}` : `${course.fileType} · ${course.fileSize}`;
  const watchedPercent = progress && course.durationSec ? Math.min(100, Math.round((progress.positionSec / course.durationSec) * 100)) : 0;
  return `
    <a class="course-card" href="#/learning/course/${course.id}">
      <div class="course-cover is-${course.kind}">
        <span class="course-kind">${icon(kind.icon)}</span>
        <span class="course-duration">${course.kind === "video" ? esc(course.duration) : esc(course.fileType)}</span>
        ${watchedPercent > 0 ? `<span class="course-cover-progress" style="width:${watchedPercent}%"></span>` : ""}
      </div>
      <div class="course-body">
        <div class="course-title">${esc(course.title)}</div>
        <div class="course-desc">${esc(course.description)}</div>
        <div class="course-tags">${course.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div>
        <div class="course-meta">
          <span>${esc(meta)}</span>
          <span>更新 ${esc(course.updatedAt)}</span>
        </div>
        ${progress ? `<div class="course-progress">${icon("play")}<span>在学 · 最近学习 ${esc(progress.lastLearnedAt)}</span>${course.kind === "video" && progress.positionSec > 0 ? `<span class="course-resume">从 ${clock(progress.positionSec)} 继续</span>` : ""}</div>` : ""}
      </div>
    </a>
  `;
}

export function renderCourseList() {
  const all = visibleCourses();
  const query = state.courseQuery.trim();
  let rows = all.filter((c) =>
    (state.courseTag === "all" || c.tags.includes(state.courseTag)) &&
    (!query || c.title.includes(query))
  );
  if (state.onlyInProgress) rows = rows.filter((c) => progressFor(c.id, state.role));

  const inProgressCount = all.filter((c) => progressFor(c.id, state.role)).length;
  const filtersActive = (state.courseTag !== "all" ? 1 : 0) + (state.onlyInProgress ? 1 : 0) + (query ? 1 : 0);

  const empty = emptyState({
    title: query || state.courseTag !== "all" || state.onlyInProgress ? "没有符合条件的课程" : "本品牌还没有课程",
    text: query || state.courseTag !== "all" || state.onlyInProgress
      ? "换个关键词或标签；也可以清空筛选。"
      : canManage() ? "课程由总部维护；可以先新建一门课。" : "等总部发布课程后会出现在这里。",
    action: canManage() ? '<a class="btn btn-primary" href="#/learning/new">新建课程</a>' : "",
  });

  const content = `
    <div class="page-head">
      <div>
        <h1 class="page-title">学习中心</h1>
        <p class="page-sub">只显示你品牌范围内的已发布课程；可以按标签筛选或搜索标题。</p>
      </div>
    </div>
    ${learningTabs("center")}
    ${filterToggle(filtersActive)}
    <section class="filter-card learning-filter ${state.filtersOpen ? "open" : ""}" aria-label="课程筛选">
      <div class="filter-line">
        <label class="course-search">${icon("search")}<input type="search" placeholder="搜索课程标题" aria-label="搜索课程标题" data-course-search value="${esc(state.courseQuery)}" /></label>
        <label class="filter-select"><span>标签</span>
          <select data-course-tag>
            <option value="all" ${state.courseTag === "all" ? "selected" : ""}>全部标签</option>
            ${TAGS.map((t) => `<option value="${esc(t)}" ${state.courseTag === t ? "selected" : ""}>${esc(t)}</option>`).join("")}
          </select>
        </label>
        <button type="button" class="chip ${state.onlyInProgress ? "active" : ""}" data-action="toggle-in-progress">只看在学${inProgressCount ? ` · ${inProgressCount}` : ""}</button>
        ${filtersActive ? `<button type="button" class="btn btn-sm btn-ghost" data-action="clear-course-filter">清空</button>` : ""}
      </div>
    </section>
    <div class="result-bar">
      <span>共 <strong>${state.demoState === "empty" ? 0 : rows.length}</strong> 门课程</span>
      <span class="hint">按最近更新排序</span>
    </div>
    ${stateAware(rows.length ? `<div class="course-grid">${rows.map(courseCard).join("")}</div>` : empty, { empty })}
  `;
  return shell("center", ["学习中心"], content);
}

export function renderCourseDetail(id) {
  const course = getCourse(id);
  if (!course || !canRead(course, state.role)) {
    return shell("center", ["学习中心", "课程"], deniedState("课程不存在、已下架，或不在你的品牌范围内。请联系平台管理员确认你的品牌与人员范围。"));
  }
  const progress = progressFor(course.id, state.role);
  const notPlayable = course.kind === "video" && course.vodStatus !== "normal";
  const kind = KIND[course.kind];

  const player = course.kind === "video" ? `
    <div class="player ${notPlayable ? "is-disabled" : ""}" ${notPlayable ? "" : 'data-action="play-course" data-id="' + course.id + '"'}>
      <div class="player-cover">
        ${notPlayable
          ? `<div class="player-state">${icon(course.vodStatus === "failed" ? "alert" : "clock")}<strong>${course.vodStatus === "failed" ? "转码失败，暂不可播放" : "转码中，暂不可播放"}</strong><span>${course.vodStatus === "failed" ? "维护者需要替换文件后才能播放。" : "课程已发布，转码完成后自动可播。"}</span></div>`
          : `<span class="player-btn">${icon("play")}</span>`}
      </div>
      <div class="player-bar"><div class="player-progress" style="width:${progress && course.durationSec ? Math.min(100, Math.round((progress.positionSec / course.durationSec) * 100)) : 0}%"></div></div>
      <div class="player-foot">
        <span>${notPlayable ? "转码完成后自动可播" : progress && progress.positionSec > 0 ? `上次看到 ${clock(progress.positionSec)} / ${esc(course.duration)}` : esc(course.duration)}</span>
        <span>${notPlayable ? "暂不可播放" : "点击播放，不自动播放"}</span>
      </div>
    </div>
  ` : `
    <div class="doc-preview">
      ${course.fileType === "PDF" ? `
        <div class="pdf-sheet">
          <div class="pdf-head">${esc(course.title)}</div>
          <div class="pdf-lines">${Array.from({ length: 9 }).map((_, i) => `<span style="width:${72 + ((i * 7) % 24)}%"></span>`).join("")}</div>
          <div class="pdf-foot">第 1 页 / 共 6 页</div>
        </div>
      ` : `
        <div class="image-sheet">${icon("image")}<span>${esc(course.fileType)} 预览</span></div>
      `}
    </div>
  `;

  const downloadNote = course.kind === "document"
    ? `<div class="callout" style="margin-top:14px">${icon("shield")}<span>预览与下载是两个动作：预览不记审计，下载会记录谁、何时、哪门课与文件标识。微信内不能触发下载，按钮会改为「复制链接，在浏览器打开」。</span></div>`
    : "";

  const content = `
    <a class="back-link" href="#/learning">${icon("arrowLeft")} 返回学习中心</a>
    <div class="page-head">
      <div>
        <div style="display:flex;align-items:center;gap:9px;flex-wrap:wrap">
          <h1 class="page-title">${esc(course.title)}</h1>
          <span class="tag">${esc(kind.label)}</span>
          ${!isPlayable(course) ? badge(VOD_STATUS[course.vodStatus]?.label ?? "不可播放", VOD_STATUS[course.vodStatus]?.tone ?? "gray") : ""}
        </div>
        <p class="page-sub">${esc(brandScopeLabel(course))} · ${esc(levelLabel(course.level))} · 更新 ${esc(course.updatedAt)} · 上传者 ${esc(course.uploader)}</p>
      </div>
      <div class="page-actions">
        ${course.kind === "document" ? `<button type="button" class="btn" data-action="download-course" data-id="${course.id}">${icon("download")} 下载原件</button>` : ""}
        ${course.kind === "video" && !notPlayable ? `<button type="button" class="btn btn-primary" data-action="play-course" data-id="${course.id}">${icon("play")} ${progress && progress.positionSec > 0 ? `从 ${clock(progress.positionSec)} 继续` : "开始学习"}</button>` : ""}
      </div>
    </div>
    <div class="detail-grid">
      <div class="card detail-main">
        <div class="card-pad">
          ${player}
          <div class="course-tags" style="margin-top:16px">${course.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div>
          <p class="course-detail-desc">${esc(course.description)}</p>
          <div class="info-grid" style="margin-top:18px">
            <div><div class="info-label">类型</div><div class="info-value">${esc(kind.label)}</div></div>
            <div><div class="info-label">${course.kind === "video" ? "时长" : "文件大小"}</div><div class="info-value num">${course.kind === "video" ? esc(course.duration) : esc(course.fileSize)}</div></div>
            <div><div class="info-label">上传者</div><div class="info-value">${esc(course.uploader)}</div></div>
            <div><div class="info-label">品牌范围</div><div class="info-value">${esc(brandScopeLabel(course))}</div></div>
            <div><div class="info-label">适用人员</div><div class="info-value">${esc(levelLabel(course.level))}</div></div>
            <div><div class="info-label">最近更新</div><div class="info-value num">${esc(course.updatedAt)}</div></div>
          </div>
          ${downloadNote}
        </div>
      </div>
      <aside class="detail-rail" aria-label="学习进度">
        <div class="rail-card">
          <div class="rail-kicker">我的进度</div>
          <div class="rail-title">${progress ? (course.kind === "video" && progress.positionSec > 0 ? `看到 ${clock(progress.positionSec)}` : "已开始学习") : "还没开始"}</div>
          <div class="rail-list">
            <div class="rail-row"><span>最近学习</span><strong class="num">${progress ? esc(progress.lastLearnedAt) : "—"}</strong></div>
            ${course.kind === "video" ? `<div class="rail-row"><span>累计观看</span><strong class="num">${clock(progress?.watchedSec ?? 0)}</strong></div><div class="rail-row"><span>播放次数</span><strong class="num">${progress?.playCount ?? 0}</strong></div>` : ""}
          </div>
          <div class="rail-text">学习进度按账号记录，换设备以服务端记录为准；本课程不设完成标记。</div>
        </div>
      </aside>
    </div>
  `;
  return shell("center", ["学习中心", course.title], content);
}

/* ---------- 课程管理 ---------- */

function manageable(course, role = state.role) {
  if (role === "platform_admin") return true;
  if (!canManage(role)) return false;
  return course.brandScope === "all" || course.brands.every((b) => ROLE_BRANDS[role].includes(b));
}

export function renderCourseManage() {
  if (!canManage()) {
    return shell("manage", ["课程管理"], deniedPage("课程管理", "课程管理需要「维护课程与资料」权限；请联系平台管理员或总部管理员补充授权。"));
  }
  const all = COURSES.filter((c) => manageable(c));
  const rows = all.filter((c) =>
    (state.manageFilter.status === "all" || c.status === state.manageFilter.status) &&
    (state.manageFilter.kind === "all" || c.kind === state.manageFilter.kind)
  );
  const activeFilters = (state.manageFilter.status !== "all" ? 1 : 0) + (state.manageFilter.kind !== "all" ? 1 : 0);

  const statusCell = (c) => {
    const s = COURSE_STATUS[c.status];
    const vod = c.kind === "video" && c.vodStatus !== "normal"
      ? ` ${badge(VOD_STATUS[c.vodStatus]?.label ?? "不可播放", VOD_STATUS[c.vodStatus]?.tone ?? "gray")}`
      : "";
    return `<span class="status-pair">${badge(s.label, s.tone)}${vod}</span>`;
  };

  const chip = (group, value, label, current) =>
    `<button type="button" class="chip ${current === value ? "active" : ""}" data-manage-filter="${group}" data-value="${value}">${esc(label)}</button>`;

  const empty = emptyState({
    title: activeFilters ? "没有符合条件的课程" : "还没有课程",
    text: activeFilters ? "换个状态或类型筛选。" : "新建第一门课程；保存即对范围内学员可见。",
    action: activeFilters ? "" : '<a class="btn btn-primary" href="#/learning/new">新建课程</a>',
  });

  const content = `
    <div class="page-head">
      <div>
        <h1 class="page-title">课程管理</h1>
        <p class="page-sub">保存即发布；替换文件直接覆盖、不保留旧版本；下架满 30 天自动归档并删除媒体。</p>
      </div>
      <div class="page-actions">
        <a class="btn btn-primary" href="#/learning/new">${icon("plus")} 新建课程</a>
      </div>
    </div>
    ${learningTabs("manage")}
    ${filterToggle(activeFilters)}
    <section class="filter-card learning-filter ${state.filtersOpen ? "open" : ""}" aria-label="课程筛选">
      <div class="filter-line"><span class="filter-label">状态</span>
        ${[["all", "全部状态"], ["published", "已发布"], ["unpublished", "已下架"], ["archived", "已归档"]].map(([v, l]) => chip("status", v, l, state.manageFilter.status)).join("")}
      </div>
      <div class="filter-line"><span class="filter-label">类型</span>
        ${[["all", "全部类型"], ["video", "视频"], ["document", "资料"]].map(([v, l]) => chip("kind", v, l, state.manageFilter.kind)).join("")}
      </div>
    </section>
    <div class="result-bar">
      <span>共 <strong>${state.demoState === "empty" ? 0 : rows.length}</strong> 门课程</span>
      <span class="hint">含已下架、已归档与转码中的课程；学员侧只显示已发布且可播放的。</span>
    </div>
    ${stateAware(rows.length ? `
      <div class="table-wrap">
        <table>
          <thead><tr><th>课程</th><th>类型</th><th>品牌范围</th><th>适用人员</th><th>标签</th><th>状态</th><th>更新时间</th><th class="right">操作</th></tr></thead>
          <tbody>
            ${rows.map((c) => `
              <tr>
                <td>${dataCell(c.title, `上传者 ${c.uploader}`)}</td>
                <td>${badge(KIND[c.kind].label, "plain")}</td>
                <td>${esc(brandScopeLabel(c))}</td>
                <td>${esc(levelLabel(c.level))}</td>
                <td class="nowrap">${c.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join(" ")}</td>
                <td class="nowrap">${statusCell(c)}</td>
                <td class="num nowrap">${esc(c.updatedAt)}</td>
                <td class="right nowrap">
                  ${c.status === "archived" ? '<span class="cell-sub">不可编辑</span>' : `
                    <a class="btn btn-sm" href="#/learning/edit/${c.id}">编辑</a>
                    ${c.status === "published"
                      ? `<button class="btn btn-sm" data-action="course-status" data-id="${c.id}" data-status="unpublished">下架</button>`
                      : `<button class="btn btn-sm" data-action="course-status" data-id="${c.id}" data-status="published">上架</button>`}
                  `}
                </td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
      <div class="pagination">
        <span>第 1 / ${Math.max(1, Math.ceil(rows.length / 20))} 页 · 每页 20 条</span>
        <div class="pagination-actions">
          <button type="button" class="btn btn-sm" disabled>上一页</button>
          <button type="button" class="btn btn-sm" disabled>下一页</button>
        </div>
      </div>
    ` : empty)}
  `;
  return shell("manage", ["课程管理"], content);
}

/* ---------- 新建 / 编辑 ---------- */

function allowedBrands() {
  return ROLE_BRANDS[state.role];
}

export function renderCourseForm(id) {
  if (!canManage()) {
    return shell("manage", ["课程管理", "新建课程"], deniedPage("新建课程", "课程管理需要「维护课程与资料」权限。"));
  }
  const editing = Boolean(id);
  const course = editing ? getCourse(id) : null;
  if (editing && !course) {
    return shell("manage", ["课程管理", "编辑课程"], deniedState("课程不存在，或不在你的维护范围内。"));
  }
  const kind = state.formKind;
  const brands = allowedBrands();
  const allSelected = state.formBrandScope === "all";

  const content = `
    <a class="back-link" href="#/learning/manage">${icon("arrowLeft")} 返回课程管理</a>
    <div class="page-head">
      <div>
        <h1 class="page-title">${editing ? "编辑课程" : "新建课程"}</h1>
        <p class="page-sub">保存即发布，没有草稿与审核；品牌范围、人员级别、标签与文件决定学员能否看到。</p>
      </div>
    </div>
    ${learningTabs("manage")}
    <div class="wizard-layout">
      <form class="card card-pad wizard-main" data-form="save-course">
        <div class="field">
          <label>课程类型 *</label>
          <div class="kind-switch" role="radiogroup" aria-label="课程类型">
            <button type="button" class="kind-option ${kind === "video" ? "active" : ""}" data-action="set-kind" data-kind="video">${icon("play")} 视频${kind === "video" ? `<span class="option-check">${icon("check")}</span>` : ""}</button>
            <button type="button" class="kind-option ${kind === "document" ? "active" : ""}" data-action="set-kind" data-kind="document">${icon("file")} 资料${kind === "document" ? `<span class="option-check">${icon("check")}</span>` : ""}</button>
          </div>
          <span class="hint">视频走 VOD，资料支持 PDF / JPG / PNG；单课程单内容。</span>
        </div>
        <div class="form-grid" style="margin-top:16px">
          <div class="field span-2">
            <label for="course-title">标题 *</label>
            <input class="input" id="course-title" maxlength="200" value="${esc(state.formTitle ?? course?.title ?? "")}" placeholder="例如：日立家装水机安装规范" />
          </div>
          <div class="field span-2">
            <label for="course-desc">简介</label>
            <textarea class="textarea" id="course-desc" maxlength="2000" placeholder="说明课程内容与适用场景。">${esc(state.formDesc ?? course?.description ?? "")}</textarea>
          </div>
          <div class="field">
            <label>品牌范围 *</label>
            <div class="brand-options">
              <button type="button" class="brand-option ${allSelected ? "active" : ""}" data-action="set-brand-scope" data-scope="all">
                <strong>全部品牌</strong><span>新品牌上线后自动可见</span>${allSelected ? `<span class="option-check">${icon("check")}</span>` : ""}
              </button>
              <button type="button" class="brand-option ${!allSelected ? "active" : ""}" data-action="set-brand-scope" data-scope="specified">
                <strong>指定品牌</strong><span>只对勾选的品牌可见</span>${!allSelected ? `<span class="option-check">${icon("check")}</span>` : ""}
              </button>
            </div>
          </div>
          <div class="field">
            <label>适用人员级别 *</label>
            <select class="select" data-form-level>
              ${Object.entries(LEVELS).map(([key, l]) => `<option value="${key}" ${state.formLevel === key ? "selected" : ""}>${esc(l.label)}</option>`).join("")}
            </select>
            <span class="hint">与品牌范围取交集；门店专员只能看到「全部人员」的课程。</span>
          </div>
          <div class="field span-2 ${allSelected ? "is-muted" : ""}">
            <label>指定品牌${allSelected ? "（全部品牌不需要选择）" : " *"}</label>
            <div class="brand-picks">
              ${BRANDS.map((b) => {
                const allowed = brands.includes(b);
                const picked = state.formBrands.includes(b);
                return `<button type="button" class="chip ${picked && !allSelected ? "active" : ""}" ${allowed && !allSelected ? 'data-action="toggle-brand"' : "disabled"} data-brand="${esc(b)}">${!allowed ? icon("lock") : ""}${esc(b)}</button>`;
              }).join("")}
            </div>
            <span class="hint">总部只能选自己授权品牌，或直接选「全部品牌」；不能逐个勾选未授权品牌。</span>
          </div>
          <div class="field span-2">
            <label>标签 *（可多选，筛选时单选）</label>
            <div class="brand-picks">
              ${TAGS.map((t) => `<button type="button" class="chip ${state.formTags.includes(t) ? "active" : ""}" data-action="toggle-tag" data-tag="${esc(t)}">${esc(t)}</button>`).join("")}
            </div>
            <span class="hint">标签集合由超管维护；这里只能选择，不能新建。</span>
          </div>
          <div class="field">
            <label>封面 *</label>
            <div class="upload-mini" data-action="mock-upload" role="button" tabindex="0">
              ${icon("image")}
              <span>上传封面（≤ 5 MB）</span>
            </div>
          </div>
          <div class="field">
            <label>${kind === "video" ? "视频文件 *" : "资料文件 *"}</label>
            <div class="upload-mini" data-action="mock-upload" role="button" tabindex="0">
              ${icon(kind === "video" ? "play" : "file")}
              <span>${kind === "video" ? "MP4 / H.264，≤ 2 GB、≤ 60 分钟" : "PDF / JPG / PNG，≤ 50 MB"}</span>
            </div>
          </div>
        </div>
        ${state.formError ? `<div class="callout warn" style="margin-top:16px">${icon("alert")}<span>${esc(state.formError)}</span></div>` : ""}
        <div class="callout" style="margin-top:16px">${icon("shield")}<span>保存前会校验能力、品牌与文件；视频超出上限在取上传凭证前就被拒绝。保存成功后学员列表立即可见。</span></div>
        <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:18px">
          <a class="btn" href="#/learning/manage">取消</a>
          <button class="btn btn-primary" type="submit">${icon("check")} 保存并发布</button>
        </div>
      </form>
      <aside class="wizard-rail" aria-label="发布说明">
        <div class="rail-card">
          <div class="rail-kicker">发布</div>
          <div class="rail-title">保存即发布</div>
          <div class="rail-text">没有草稿与审核；品牌、人员级别、标签与文件任一不满足就拒绝保存。</div>
        </div>
        <div class="rail-card">
          <div class="rail-kicker">替换</div>
          <div class="rail-title">直接覆盖</div>
          <div class="rail-text">替换文件不保留旧版本，学习进度不清零；若新视频更短，续播位置截断到新时长内。</div>
        </div>
        <div class="rail-card">
          <div class="rail-kicker">可见性</div>
          <div class="rail-title">品牌 × 人员级别</div>
          <div class="rail-text">全部品牌是动态语义：新品牌上线后自动可见。指定品牌不随品牌新增而扩展。</div>
        </div>
      </aside>
    </div>
  `;
  return shell("manage", ["课程管理", editing ? "编辑课程" : "新建课程"], content);
}

/* ---------- 学习汇总 ---------- */

export function renderSummary() {
  if (!canSummary()) {
    return shell("summary", ["学习汇总"], deniedPage("学习汇总", "学习汇总只有总部与平台超管可见；请联系平台管理员开通学习汇总权限。"));
  }
  const brands = state.role === "platform_admin" ? BRANDS : ROLE_BRANDS[state.role];
  const brand = state.summaryBrand === "all" || brands.includes(state.summaryBrand) ? state.summaryBrand : "all";
  const s = SUMMARY[brand] ?? SUMMARY.all;
  const scopeText = brand === "all" ? "合计（已去重）" : brand;

  const content = `
    <div class="page-head">
      <div>
        <h1 class="page-title">学习汇总</h1>
        <p class="page-sub">累计总量；不提供按人、门店或课程的明细，也不提供导出。</p>
      </div>
    </div>
    ${learningTabs("summary")}
    <div class="summary-band" aria-label="汇总口径">
      <div>
        <div class="summary-title">${esc(scopeText)} · 累计</div>
        <div class="summary-sub">含已下架课程的历史；课程数只算已发布且可播放。数据截止 ${esc(s.asOf)}。</div>
      </div>
      <div class="summary-metrics">
        <div class="summary-metric"><span>${s.courses}</span><small>课程数</small></div>
        <div class="summary-metric"><span>${s.learners.toLocaleString("zh-CN")}</span><small>学习人数</small></div>
        <div class="summary-metric"><span>${s.hours.toLocaleString("zh-CN")}</span><small>累计观看（小时）</small></div>
        <div class="summary-metric"><span>${s.plays.toLocaleString("zh-CN")}</span><small>累计播放（次）</small></div>
      </div>
    </div>
    <div class="filter-bar">
      <span class="filter-note" style="margin-left:0">范围</span>
      <button type="button" class="chip ${brand === "all" ? "active" : ""}" data-action="summary-brand" data-brand="all">全部品牌${brand === "all" ? "（已去重）" : ""}</button>
      ${brands.map((b) => `<button type="button" class="chip ${brand === b ? "active" : ""}" data-action="summary-brand" data-brand="${esc(b)}">${esc(b)}</button>`).join("")}
    </div>
    <div class="note-list" aria-label="汇总口径">
      <div class="note-item">${icon("clock")}<span><strong>累计只增不减：</strong>学习人数、累计观看与播放次数统计所有课程（含已下架）；只有课程数只算已发布且可播放。</span></div>
      <div class="note-item">${icon("users")}<span><strong>学习人数按登录账号去重：</strong>换门店会重建账号，同一自然人可能计两次；合计已去重，单品牌之间不可直接相加。</span></div>
      <div class="note-item">${icon("play")}<span><strong>播放次数 = 开始播放的次数：</strong>续播重新打开也计一次，暂停后继续不计；它不等于观看人数。</span></div>
      <div class="note-item">${icon("alert")}<span><strong>观看时长来自播放心跳：</strong>不含资料预览；锁屏与切后台不计时，宁少算不高估，<strong>不能作为考核依据</strong>。</span></div>
    </div>
  `;
  return shell("summary", ["学习汇总"], content);
}

/* ---------- 标签管理 ---------- */

export function renderTags() {
  if (!canTags()) {
    return shell("tags", ["标签管理"], deniedPage("标签管理", "标签集合只有平台超管可以维护；请联系平台管理员处理。"));
  }
  const rows = TAGS.map((name) => ({ name, used: TAG_USAGE[name] ?? 0 }));
  const content = `
    <div class="page-head">
      <div>
        <h1 class="page-title">标签管理</h1>
        <p class="page-sub">标签是超管维护的预设集合；课程只能选择，不能新建。被引用的标签不能删除。</p>
      </div>
    </div>
    ${learningTabs("tags")}
    <div class="filter-bar">
      <label class="course-search">${icon("tag")}<input type="text" id="new-tag" placeholder="新标签名称，最多 32 字" maxlength="32" aria-label="新标签名称" /></label>
      <button type="button" class="btn btn-primary btn-sm" data-action="add-tag">${icon("plus")} 新建标签</button>
      <span class="filter-note">改名原地生效，不需要迁移课程引用。</span>
    </div>
    ${state.tagError ? `<div class="callout warn" style="margin:12px 0">${icon("alert")}<span>${esc(state.tagError)}</span></div>` : ""}
    <div class="table-wrap">
      <table>
        <thead><tr><th>标签</th><th class="right">引用课程</th><th class="right">操作</th></tr></thead>
        <tbody>
          ${rows.map((t) => `
            <tr>
              <td><span class="tag">${esc(t.name)}</span></td>
              <td class="right num">${t.used}</td>
              <td class="right nowrap">
                <button class="btn btn-sm" data-action="rename-tag" data-tag="${esc(t.name)}">改名</button>
                <button class="btn btn-sm" data-action="delete-tag" data-tag="${esc(t.name)}">删除</button>
              </td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
    <div class="callout" style="margin-top:14px">${icon("shield")}<span>删除被引用的标签会被拒绝并返回引用数；课程未选任何标签不能保存。</span></div>
  `;
  return shell("tags", ["标签管理"], content);
}

/* ---------- 其它导航占位 ---------- */

export function renderPlaceholder(key) {
  const titles = {
    plans: "活动计划", judgement: "判定计划", reports: "报表与看板", accounts: "账号与监控",
    master: "主数据", users: "用户与权限", system: "系统", store: "我的考核", more: "更多",
  };
  const title = titles[key] ?? "页面";
  const content = `
    <div class="page-head"><div><h1 class="page-title">${esc(title)}</h1><p class="page-sub">不在本次学习平台原型范围。</p></div></div>
    <div class="card"><div class="state"><div class="state-icon">${icon("layers")}</div><div class="state-title">不在本次原型范围</div><p class="state-text">本次原型只覆盖 G 学习平台 1.0 的页面；该页面按各自 spec 的界面一节另行设计与确认。</p><a class="btn" href="#/learning">回到学习中心</a></div></div>
  `;
  return renderShell({ activeNav: key, breadcrumb: ["工作区", title], content });
}