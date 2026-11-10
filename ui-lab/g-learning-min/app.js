// 学习平台原型入口：路由、事件、弹窗与本地面板。
// 只用于 ui-lab，不进生产构建。

import { state } from "./store.js";
import { COURSES, TAGS, TAG_USAGE, getCourse, ROLE_BRANDS } from "./data.js";
import { esc, icon } from "./ui.js";
import {
  renderCourseList, renderCourseDetail, renderCourseManage, renderCourseForm,
  renderSummary, renderTags, renderPlaceholder,
} from "./pages-g.js";

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

function render() {
  const route = parseRoute();
  const key = `${route.name}:${route.id ?? ""}`;
  if (key !== lastRouteKey) {
    resetFormFor(route);
    lastRouteKey = key;
    window.scrollTo(0, 0);
  }

  let html = "";
  switch (route.name) {
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
  const search = document.querySelector("[data-course-search]");
  if (search && state.courseQuery) {
    search.focus();
    search.setSelectionRange(search.value.length, search.value.length);
  }
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
  if (el.matches("[data-course-search]")) {
    state.courseQuery = el.value;
    render();
  }
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
  if (el.matches("[data-course-tag]")) {
    state.courseTag = el.value;
    render();
    return;
  }
  if (el.matches("[data-form-level]")) {
    state.formLevel = el.value;
    render();
  }
});

document.addEventListener("submit", (event) => {
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
      state.courseTag = "all";
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
    case "add-tag": {
      const input = document.getElementById("new-tag");
      const name = String(input?.value ?? "").trim();
      if (!name) {
        state.tagError = "标签名称不能为空。";
      } else if (TAGS.includes(name)) {
        state.tagError = `标签「${name}」已存在。`;
      } else {
        TAGS.push(name);
        TAG_USAGE[name] = 0;
        state.tagError = null;
        render();
        toast(`已新建标签「${name}」（原型）`);
        break;
      }
      render();
      break;
    }
    case "rename-tag": {
      const tag = el.dataset.tag;
      openModal({
        title: "重命名标签",
        body: `
          <div class="field"><label for="rename-tag">标签名称</label><input class="input" id="rename-tag" maxlength="32" value="${esc(tag)}" /></div>
          <p class="hint" style="margin-top:10px">改名原地生效，不需要迁移课程引用；名称不能与现有标签重复。</p>
        `,
        foot: `<button class="btn" data-action="close-modal">取消</button><button class="btn btn-primary" data-action="confirm-rename-tag" data-tag="${esc(tag)}">保存</button>`,
      });
      break;
    }
    case "confirm-rename-tag": {
      const oldName = el.dataset.tag;
      const input = document.getElementById("rename-tag");
      const next = String(input?.value ?? "").trim();
      if (!next) {
        toast("标签名称不能为空");
        break;
      }
      if (next !== oldName && TAGS.includes(next)) {
        toast(`标签「${next}」已存在`);
        break;
      }
      const idx = TAGS.indexOf(oldName);
      if (idx >= 0) {
        TAGS[idx] = next;
        TAG_USAGE[next] = TAG_USAGE[oldName] ?? 0;
        delete TAG_USAGE[oldName];
        COURSES.forEach((c) => {
          c.tags = c.tags.map((t) => (t === oldName ? next : t));
        });
      }
      closeModal();
      render();
      toast("标签已改名；课程引用不变（原型）");
      break;
    }
    case "delete-tag": {
      const tag = el.dataset.tag;
      const used = TAG_USAGE[tag] ?? 0;
      if (used > 0) {
        toast(`被 ${used} 门课程引用，不能删除`);
        break;
      }
      const idx = TAGS.indexOf(tag);
      if (idx >= 0) TAGS.splice(idx, 1);
      delete TAG_USAGE[tag];
      render();
      toast("标签已删除（原型）");
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

window.addEventListener("hashchange", render);
render();