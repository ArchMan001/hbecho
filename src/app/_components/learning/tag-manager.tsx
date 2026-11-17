"use client";
// 标签管理（仅平台超管）：两级——一级标签、二级标签。新建、改名、删除；
// 被课程引用的二级标签、还有二级标签的一级标签都不能删除，并显示原因。
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  createTagAction,
  createTagCategoryAction,
  deleteTagAction,
  deleteTagCategoryAction,
  renameTagAction,
  renameTagCategoryAction,
} from "../../_actions/learning";
import type { ActionResult } from "../../_lib/result";
import { ConfirmAction, Dialog } from "../dialog";
import { Icon } from "../icon";
import { useToast } from "../toast";

export interface TagRow { tagId: string; name: string; courseCount: number }
export interface CategoryRow { categoryId: string; name: string; courseCount: number; tags: TagRow[] }
type Err = { code: string; message: string; hint?: string | undefined } | null;
type Renaming = { kind: "category" | "tag"; id: string; name: string } | null;

export function TagManager({ categories }: { categories: CategoryRow[] }) {
  const router = useRouter();
  const toast = useToast();
  const [categoryName, setCategoryName] = useState("");
  const [tagCategoryId, setTagCategoryId] = useState(categories[0]?.categoryId ?? "");
  const [tagName, setTagName] = useState("");
  const [error, setError] = useState<Err>(null);
  const [pending, start] = useTransition();
  const [renaming, setRenaming] = useState<Renaming>(null);
  const [newName, setNewName] = useState("");
  const [renameError, setRenameError] = useState<Err>(null);
  // 当前选中的一级标签被删掉后，回退到第一个
  const selectedCategory = categories.some((c) => c.categoryId === tagCategoryId) ? tagCategoryId : (categories[0]?.categoryId ?? "");

  const run = (fn: () => Promise<ActionResult<unknown>>, done: string, onFail: (e: Err) => void, onOk: () => void) =>
    start(async () => {
      let r: ActionResult<unknown>;
      try {
        r = await fn();
      } catch {
        r = { ok: false, code: "network_error", message: "请求没有完成，请检查网络后重试" };
      }
      if (!r.ok) return onFail({ code: r.code, message: r.message, hint: r.hint });
      toast(done);
      onOk();
      router.refresh();
    });

  return (
    <>
      <form
        className="tag-add-row"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          run(() => createTagCategoryAction(categoryName), "一级标签已创建", setError, () => setCategoryName(""));
        }}
      >
        <label className="course-search">
          <Icon name="tag" />
          <input type="text" value={categoryName} onChange={(e) => setCategoryName(e.target.value)} placeholder="新标签名称，最多 32 字" maxLength={32} aria-label="新一级标签名称" />
        </label>
        <button type="submit" className="btn btn-primary btn-sm" disabled={pending || categoryName.trim() === ""}>
          <Icon name="plus" /> 新建一级标签
        </button>
      </form>
      <form
        className="tag-add-row"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          run(() => createTagAction(selectedCategory, tagName), "二级标签已创建", setError, () => setTagName(""));
        }}
      >
        <select className="select" value={selectedCategory} onChange={(e) => setTagCategoryId(e.target.value)} aria-label="所属一级标签" style={{ width: "auto", minWidth: 160 }} disabled={categories.length === 0}>
          {categories.map((c) => <option key={c.categoryId} value={c.categoryId}>{c.name}</option>)}
        </select>
        <label className="course-search">
          <Icon name="tag" />
          <input type="text" value={tagName} onChange={(e) => setTagName(e.target.value)} placeholder="新标签名称，最多 32 字" maxLength={32} aria-label="新二级标签名称" />
        </label>
        <button type="submit" className="btn btn-primary btn-sm" disabled={pending || tagName.trim() === "" || selectedCategory === ""}>
          <Icon name="plus" /> 新建二级标签
        </button>
      </form>
      {error ? (
        <div className="callout warn" role="alert" style={{ margin: "12px 0" }}>
          <Icon name="alert" />
          <span>{error.message}（错误码 {error.code}）</span>
        </div>
      ) : null}
      <div className="table-wrap">
        <table className="tag-table">
          <thead>
            <tr><th>一级标签</th><th>二级标签</th><th className="right">引用课程数</th><th className="right">操作</th></tr>
          </thead>
          <tbody>
            {categories.map((c) => {
              const head = (
                <td className="merged" rowSpan={Math.max(1, c.tags.length)}>
                  <div className="cell-main">{c.name}</div>
                  <div className="cell-sub">{c.tags.length} 个二级标签 · 引用 {c.courseCount} 门课程</div>
                  <div className="row-actions">
                    <button type="button" className="btn btn-sm" onClick={() => { setRenaming({ kind: "category", id: c.categoryId, name: c.name }); setNewName(c.name); setRenameError(null); }}>改名</button>
                    {c.tags.length > 0 ? (
                      <button type="button" className="btn btn-sm" disabled title="一级标签下还有二级标签，先删除或移走它们">删除</button>
                    ) : (
                      <ConfirmAction label="删除" title={`删除一级标签「${c.name}」`} confirmLabel="删除一级标签" danger action={deleteTagCategoryAction.bind(null, c.categoryId)} doneMessage="一级标签已删除">
                        <p>这个一级标签下没有二级标签，删除后不可恢复。</p>
                      </ConfirmAction>
                    )}
                  </div>
                </td>
              );
              if (c.tags.length === 0) {
                return (
                  <tr key={c.categoryId}>
                    {head}
                    <td colSpan={3}><span className="hint">还没有二级标签；在上面选择这个一级标签后新建。</span></td>
                  </tr>
                );
              }
              return c.tags.map((t, i) => (
                <tr key={t.tagId}>
                  {i === 0 ? head : null}
                  <td><span className="tag">{t.name}</span></td>
                  <td className="right num">{t.courseCount}</td>
                  <td className="right nowrap">
                    <button type="button" className="btn btn-sm" onClick={() => { setRenaming({ kind: "tag", id: t.tagId, name: t.name }); setNewName(t.name); setRenameError(null); }}>改名</button>{" "}
                    <ConfirmAction label="删除" title={`删除二级标签「${t.name}」`} confirmLabel="删除标签" danger action={deleteTagAction.bind(null, t.tagId)} doneMessage="二级标签已删除">
                      {t.courseCount > 0
                        ? <p>这个标签正被 {t.courseCount} 门课程使用，<strong>不能删除</strong>。请先在这些课程里取消选择，或改名。</p>
                        : <p>删除后不可恢复。没有课程在使用它。</p>}
                    </ConfirmAction>
                  </td>
                </tr>
              ));
            })}
          </tbody>
        </table>
      </div>
      <Dialog
        open={renaming !== null}
        title={`改名「${renaming?.name ?? ""}」`}
        onClose={() => setRenaming(null)}
        foot={
          <>
            <button type="button" className="btn" onClick={() => setRenaming(null)} disabled={pending}>取消</button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={pending || newName.trim() === ""}
              onClick={() =>
                renaming &&
                run(
                  () => (renaming.kind === "category" ? renameTagCategoryAction(renaming.id, newName) : renameTagAction(renaming.id, newName)),
                  renaming.kind === "category" ? "一级标签已改名" : "二级标签已改名",
                  setRenameError,
                  () => setRenaming(null),
                )
              }
            >
              {pending ? "处理中…" : "保存新名称"}
            </button>
          </>
        }
      >
        <div className="field">
          <label htmlFor="rename-tag">新名称</label>
          <input id="rename-tag" className="input" value={newName} maxLength={32} onChange={(e) => setNewName(e.target.value)} />
          <span className="hint">改名原地生效，不影响课程引用。</span>
        </div>
        {renameError ? (
          <div className="callout danger" role="alert" style={{ marginTop: 12 }}>
            <Icon name="alert" />
            <span>{renameError.message}（错误码 {renameError.code}）</span>
          </div>
        ) : null}
      </Dialog>
    </>
  );
}
