// 学习平台原型入口：路由、事件、弹窗与本地面板。
// 只用于 ui-lab，不进生产构建。

import { state } from "./store.js";
import { COURSES, TAGS, TAG_CATEGORIES, getCourse, ROLE_BRANDS } from "./data.js";
import { esc, icon } from "./ui.js";
import {
  renderCourseList, renderCourseDetail, renderCourseManage, renderCourseForm,
  renderSummary, renderTags, renderPlaceholder,
} from "./pages-g.js";
import { renderLogin } from "./pages-auth.js";

const app = document.getElementById("app");
const modal = document.getElementById("modal");
const modalTitle = document.getElementById("modal-title");
const modalBody = document.getElementById("modal-body");
const modalFoot = document.getElementById("modal-foot");
const toastEl = document.getElementById("toast");

const canManage = () => state.role === "platform_admin" || state.role === "hq_manager";
const canTags = () => state.role === "platform_admin";

function parseRoute() {
  const raw = location.hash.replace(/^#\/?/, "");
  const parts = raw.split("/").filter(Boolean);
  if (!parts.length) return { name: "learning" };
  const [head, second, third] = parts;
  if (head === "login") return { name: "login" };
  if (head === "learning") {
    if (!second) return { name: "learning" };
    if (second === "course") return { name: "course", id: third ?? "c1" };
    if (second === "edit") return { name: "course-edit", id: third };
    if (["manage", "new", "summary", "tags"].includes(second)) return { name: `course-${second}` };
  }
  return { name: head, sub: second };
}

let lastRouteKey = null;

function resetFormFor(route) {
  const fresh = {
    formKind: "video",
    formBrandScope: "specified",
    formBrands: [ROLE_BRANDS[state.role]?.[0] ?? "日立"],
    formTags: [],
    formLevel: "all",
    formTitle: "",
    formDesc: "",
    formError: null,
  };
  if (route.name === "course-new") Object.assign(state, fresh);
  if (route.name === "course-edit") {
    const c = getCourse(route.id);
    if (c) {
      state.formKind = c.kind;
      state.formBrandScope = c.brandScope;
      state.formBrands = c.brands.length ? [...c.brands] : ["日立"];
      state.formTags = [...c.tags];
      state.formLevel = c.level;
      state.formTitle = c.title;
      state.formDesc = c.description;
      state.formError = null;
    }
  }
  state.tagError = null;
}

function renderRaw() {
  const route = parseRoute();
  const key = `${route.name}:${route.id ?? ""}`;
  if (key !== lastRouteKey) {
    resetFormFor(route);
    lastRouteKey = key;
    window.scrollTo(0, 0);
  }

  let html = "";
  switch (route.name) {
    case "login": html = renderLogin(); break;
    case "learning": html = renderCourseList(); break;
    case "course": html = renderCourseDetail(route.id); break;
    case "course-manage": html = renderCourseManage(); break;
    case "course-new": html = renderCourseForm(null); break;
    case "course-edit": html = renderCourseForm(route.id); break;
    case "course-summary": html = renderSummary(); break;
    case "course-tags": html = renderTags(); break;
    case "store":
    case "more":
    case "plans":
    case "judgement":
    case "reports":
    case "accounts":
    case "master":
    case "users":
    case "system":
      html = renderPlaceholder(route.name);
      break;
    default:
      html = renderCourseList();
  }
  app.innerHTML = html;
}

function toast(message) {
  toastEl.textContent = message;
  toastEl.classList.add("show");
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toastEl.classList.remove("show"), 2600);
}

function openModal({ title, body, foot = "" }) {
  modalTitle.textContent = title;
  modalBody.innerHTML = body;
  modalFoot.innerHTML = foot || `<button class="btn" data-action="close-modal">关闭</button>`;
  if (!modal.open) modal.showModal();
}

function closeModal() {
  if (modal.open) modal.close();
}

function go(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

function captureForm() {
  const title = document.getElementById("course-title");
  const desc = document.getElementById("course-desc");
  if (title) state.formTitle = title.value;
  if (desc) state.formDesc = desc.value;
}

/* ---------- 事件 ---------- */

document.addEventListener("click", (event) => {
  if (state.openPanel && !event.target.closest(".hf")) {
    state.openPanel = null;
    render();
  }
  const actionEl = event.target.closest("[data-action]");
  if (actionEl) {
    event.preventDefault();
    handleAction(actionEl);
    return;
  }
  const hrefEl = event.target.closest("[data-href]");
  if (hrefEl) go(hrefEl.dataset.href);
  const manageFilter = event.target.closest("[data-manage-filter]");
  if (manageFilter) {
    state.manageFilter[manageFilter.dataset.manageFilter] = manageFilter.dataset.value;
    render();
  }
});

document.addEventListener("input", (event) => {
  const el = event.target;
  if (el.matches("[data-course-search]")) state.courseDraft = el.value;
  if (el.matches("#course-title")) state.formTitle = el.value;
  if (el.matches("#course-desc")) state.formDesc = el.value;
});

document.addEventListener("change", (event) => {
  const el = event.target;
  if (el.matches("[data-demo-role]")) {
    captureForm();
    state.role = el.value;
    render();
    return;
  }
  if (el.matches("[data-demo-state]")) {
    state.demoState = el.value;
    render();
    return;
  }
  if (el.matches("[data-form-level]")) {
    state.formLevel = el.value;
    render();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && event.target.matches("[data-course-search]")) {
    state.courseQuery = event.target.value.trim();
    render();
  }
});

// 两栏标签选择器：悬停左栏切换右栏，只改 DOM，不重渲染
document.addEventListener("mouseover", (event) => {
  const lv = event.target.closest("[data-pane-level]");
  if (!lv || lv.classList.contains("on")) return;
  const id = lv.dataset.panePicker;
  state.tagPane[id] = lv.dataset.paneLevel;
  document.querySelectorAll(`[data-pane-picker="${id}"]`).forEach((n) => {
    n.classList.toggle("on", n.dataset.paneLevel === lv.dataset.paneLevel || n.dataset.paneOf === lv.dataset.paneLevel);
  });
});

document.addEventListener("submit", (event) => {
  if (event.target.closest("[data-login-form]")) {
    event.preventDefault();
    go("#/learning");
    return;
  }
  const form = event.target.closest("form[data-form]");
  if (!form) return;
  event.preventDefault();
  handleForm(form.dataset.form, form);
});

modal.addEventListener("click", (event) => {
  if (event.target === modal) closeModal();
});

/* ---------- 动作 ---------- */

function handleAction(el) {
  const action = el.dataset.action;
  const id = el.dataset.id;
  switch (action) {
    case "toggle-demo":
      state.demoOpen = !state.demoOpen;
      render();
      break;
    case "notify":
      toast("通知：2 门课程已更新（原型）");
      break;
    case "account-menu":
      openModal({
        title: "账号菜单",
        body: `
          <div class="list-row"><div style="flex:1"><div class="cell-main">修改密码</div><div class="cell-sub">其他会话将失效，当前会话保留。</div></div><button class="btn btn-sm" data-action="toast-password">打开</button></div>
          <div class="list-row"><div style="flex:1"><div class="cell-main">退出登录</div><div class="cell-sub">只结束当前会话。</div></div><button class="btn btn-sm" data-action="toast-logout">退出</button></div>
        `,
      });
      break;
    case "toast-password":
    case "toast-logout":
      closeModal();
      toast("原型：账号动作在实现时接入访问控制模块");
      break;
    case "retry":
      render();
      toast("已重新加载（原型）");
      break;
    case "close-modal":
      closeModal();
      break;
    case "hf-pin":
      // 桌面端靠悬停/聚焦展开；只有触屏（无 hover）才用点击固定展开
      if (window.matchMedia("(hover: none)").matches) {
        state.openPanel = state.openPanel === el.dataset.id ? null : el.dataset.id;
        render();
      }
      break;
    case "hf-toggle": {
      const { key, value, mode } = el.dataset;
      const cur = state[key];
      const group = el.dataset.set ? el.dataset.set.split("|") : [value];
      const has = cur.includes(value);
      state[key] = mode === "single"
        ? [...cur.filter((v) => !group.includes(v)), ...(has ? [] : [value])]
        : has ? cur.filter((v) => v !== value) : [...cur, value];
      render();
      break;
    }
    case "hf-clear": {
      const set = el.dataset.set.split("|");
      state[el.dataset.key] = state[el.dataset.key].filter((v) => !set.includes(v));
      render();
      break;
    }
    case "course-search": {
      state.courseQuery = state.courseDraft.trim();
      render();
      break;
    }
    case "toggle-in-progress":
      state.onlyInProgress = !state.onlyInProgress;
      render();
      break;
    case "toggle-filters":
      state.filtersOpen = !state.filtersOpen;
      render();
      break;
    case "clear-course-filter":
      state.courseQuery = "";
      state.courseDraft = "";
      state.courseTags = [];
      state.courseBrands = [];
      state.courseKinds = [];
      state.onlyInProgress = false;
      render();
      break;
    case "play-course":
      toast("原型：已获取短期播放凭证，从上次位置继续播放");
      break;
    case "download-course":
      toast("原型：已下载原件，并记录下载审计");
      break;
    case "course-status": {
      const course = getCourse(id);
      if (course) {
        course.status = el.dataset.status;
        course.updatedAt = "2026-11-10";
        render();
        toast(course.status === "published" ? "已重新上架；学员立即可见（原型）" : "已下架；学员列表不再出现，直链返回无权访问（原型）");
      }
      break;
    }
    case "set-kind":
      captureForm();
      state.formKind = el.dataset.kind;
      render();
      break;
    case "set-brand-scope":
      captureForm();
      state.formBrandScope = el.dataset.scope;
      render();
      break;
    case "toggle-brand": {
      captureForm();
      const brand = el.dataset.brand;
      if (!ROLE_BRANDS[state.role].includes(brand)) break;
      state.formBrands = state.formBrands.includes(brand)
        ? state.formBrands.filter((b) => b !== brand)
        : [...state.formBrands, brand];
      render();
      break;
    }
    case "toggle-tag": {
      captureForm();
      const tag = el.dataset.tag;
      state.formTags = state.formTags.includes(tag)
        ? state.formTags.filter((t) => t !== tag)
        : [...state.formTags, tag];
      state.formError = null;
      render();
      break;
    }
    case "mock-upload":
      toast("原型：已选择文件并通过格式与大小校验");
      break;
    case "summary-brand":
      state.summaryBrand = el.dataset.brand;
      render();
      break;
    case "toggle-course-tag": {
      const tag = el.dataset.tag;
      state.courseTags = state.courseTags.includes(tag)
        ? state.courseTags.filter((t) => t !== tag)
        : [...state.courseTags, tag];
      render();
      break;
    }
    case "add-category": {
      const input = document.getElementById("new-category");
      const name = String(input?.value ?? "").trim();
      if (!name) {
        state.tagError = "一级标签名称不能为空。";
      } else if (TAG_CATEGORIES.some((c) => c.name === name)) {
        state.tagError = `一级标签「${name}」已存在。`;
      } else {
        TAG_CATEGORIES.push({ id: `cat-${Date.now()}`, name, tags: [] });
        state.tagError = null;
        render();
        toast(`已新建一级标签「${name}」（原型）`);
        break;
      }
      render();
      break;
    }
    case "rename-category": {
      const cat = TAG_CATEGORIES.find((c) => c.id === el.dataset.category);
      if (!cat) break;
      openModal({
        title: "重命名一级标签",
        body: `
          <div class="field"><label for="rename-category">一级标签名称</label><input class="input" id="rename-category" maxlength="32" value="${esc(cat.name)}" /></div>
          <p class="hint" style="margin-top:10px">只改显示名，不影响它下面的二级标签与课程引用。</p>
        `,
        foot: `<button class="btn" data-action="close-modal">取消</button><button class="btn btn-primary" data-action="confirm-rename-category" data-category="${cat.id}">保存</button>`,
      });
      break;
    }
    case "confirm-rename-category": {
      const cat = TAG_CATEGORIES.find((c) => c.id === el.dataset.category);
      const input = document.getElementById("rename-category");
      const next = String(input?.value ?? "").trim();
      if (!cat) break;
      if (!next) { toast("一级标签名称不能为空"); break; }
      if (TAG_CATEGORIES.some((c) => c !== cat && c.name === next)) { toast(`一级标签「${next}」已存在`); break; }
      cat.name = next;
      closeModal();
      render();
      toast("一级标签已改名；二级标签与课程引用不变（原型）");
      break;
    }
    case "delete-category": {
      const idx = TAG_CATEGORIES.findIndex((c) => c.id === el.dataset.category);
      if (idx < 0) break;
      const cat = TAG_CATEGORIES[idx];
      if (cat.tags.length) {
        toast(`还有 ${cat.tags.length} 个二级标签，不能删除`);
        break;
      }
      TAG_CATEGORIES.splice(idx, 1);
      render();
      toast("空的一级标签已删除（原型）");
      break;
    }
    case "add-tag": {
      const cat = TAG_CATEGORIES.find((c) => c.id === document.getElementById("new-tag-cat")?.value);
      if (!cat) break;
      const name = String(document.getElementById("new-tag-name")?.value ?? "").trim();
      if (!name) {
        state.tagError = "二级标签名称不能为空。";
      } else if (cat.tags.includes(name)) {
        state.tagError = `「${cat.name}」下已有二级标签「${name}」。`;
      } else {
        cat.tags.push(name);
        state.tagError = null;
        render();
        toast(`已在「${cat.name}」下新建二级标签「${name}」（原型）`);
        break;
      }
      render();
      break;
    }
    case "rename-tag": {
      const tag = el.dataset.tag;
      const categoryId = el.dataset.category;
      openModal({
        title: "重命名二级标签",
        body: `
          <div class="field"><label for="rename-tag">二级标签名称</label><input class="input" id="rename-tag" maxlength="32" value="${esc(tag)}" /></div>
          <p class="hint" style="margin-top:10px">改名原地生效，不需要迁移课程引用；同一一级标签下不能重名。</p>
        `,
        foot: `<button class="btn" data-action="close-modal">取消</button><button class="btn btn-primary" data-action="confirm-rename-tag" data-tag="${esc(tag)}" data-category="${esc(categoryId)}">保存</button>`,
      });
      break;
    }
    case "confirm-rename-tag": {
      const oldName = el.dataset.tag;
      const cat = TAG_CATEGORIES.find((c) => c.id === el.dataset.category);
      const input = document.getElementById("rename-tag");
      const next = String(input?.value ?? "").trim();
      if (!cat) break;
      if (!next) { toast("二级标签名称不能为空"); break; }
      if (next !== oldName && cat.tags.includes(next)) { toast(`「${cat.name}」下已有标签「${next}」`); break; }
      const idx = cat.tags.indexOf(oldName);
      if (idx >= 0) {
        cat.tags[idx] = next;
        COURSES.forEach((c) => {
          c.tags = c.tags.map((t) => (t === oldName ? next : t));
        });
      }
      closeModal();
      render();
      toast("二级标签已改名；课程引用不变（原型）");
      break;
    }
    case "delete-tag": {
      const tag = el.dataset.tag;
      const cat = TAG_CATEGORIES.find((c) => c.id === el.dataset.category);
      if (!cat) break;
      const used = COURSES.filter((c) => c.tags.includes(tag)).length;
      if (used > 0) {
        toast(`被 ${used} 门课程引用，不能删除`);
        break;
      }
      cat.tags = cat.tags.filter((t) => t !== tag);
      render();
      toast("二级标签已删除（原型）");
      break;
    }
    default:
      toast("原型：该动作在实现时接入学习模块");
  }
}

function handleForm(name) {
  if (name !== "save-course") return;
  captureForm();
  if (!state.formTitle.trim()) {
    state.formError = "标题不能为空。";
    render();
    return;
  }
  if (state.formBrandScope === "specified" && state.formBrands.length === 0) {
    state.formError = "品牌范围必选：勾选至少一个品牌，或选择「全部品牌」。";
    render();
    return;
  }
  if (state.formTags.length === 0) {
    state.formError = "至少选择一个标签；课程未选标签不能保存。";
    render();
    return;
  }
  state.formError = null;

  const uploader = { platform_admin: "刘学奎", hq_manager: "王敏", branch_manager: "李强", store_staff: "张三" }[state.role];
  const fields = {
    title: state.formTitle.trim(),
    description: state.formDesc.trim(),
    kind: state.formKind,
    brandScope: state.formBrandScope,
    brands: state.formBrandScope === "all" ? [] : [...state.formBrands],
    level: state.formLevel,
    tags: [...state.formTags],
    status: "published",
    updatedAt: "2026-11-10",
  };

  const editMatch = location.hash.match(/^#\/learning\/edit\/(.+)$/);
  const editing = editMatch ? getCourse(editMatch[1]) : null;
  if (editing) {
    Object.assign(editing, fields);
    if (editing.kind === "video" && !editing.duration) {
      editing.duration = "—";
      editing.durationSec = 0;
      editing.vodStatus = "transcoding";
    }
  } else {
    COURSES.unshift({
      id: `c${Date.now()}`,
      coverTone: "teal",
      uploader,
      duration: state.formKind === "video" ? "12:00" : "",
      durationSec: state.formKind === "video" ? 720 : 0,
      vodStatus: "normal",
      fileType: state.formKind === "document" ? "PDF" : "",
      fileSize: state.formKind === "document" ? "2.4 MB" : "",
      ...fields,
    });
  }

  go("#/learning/manage");
  toast(editing ? "已保存；学员侧立即生效（原型）" : "已保存并发布；范围内学员立即可见（原型）");
}

/* 重渲染会让指针下的下拉面板丢失 :hover；记住指针所在的面板和列表滚动位置，渲染后补回 */
let hoverHf = null;
document.addEventListener("mousemove", (e) => {
  const h = e.target.closest?.(".hf") ?? null;
  document.querySelectorAll(".hf.hover-keep").forEach((x) => { if (x !== h) x.classList.remove("hover-keep"); });
  hoverHf = h?.dataset.hfId ?? null;
});
function render() {
  const scrolls = {};
  document.querySelectorAll(".hf").forEach((h) => {
    const l = h.querySelector(".hf-list:not(.hidden)");
    if (l) scrolls[h.dataset.hfId] = [...h.querySelectorAll(".hf-list")].map((x) => x.scrollTop);
  });
  renderRaw();
  Object.entries(scrolls).forEach(([id, tops]) => {
    document.querySelectorAll(`.hf[data-hf-id="${id}"] .hf-list`).forEach((x, i) => { x.scrollTop = tops[i] ?? 0; });
  });
  if (hoverHf) document.querySelector(`.hf[data-hf-id="${hoverHf}"]`)?.classList.add("hover-keep");
}

window.addEventListener("hashchange", render);
render();
