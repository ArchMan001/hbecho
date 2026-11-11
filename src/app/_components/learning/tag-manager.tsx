"use client";
// 标签管理（仅平台超管）：新建、改名、删除；被引用的标签删除会被拒绝并显示引用数。
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { createTagAction, deleteTagAction, renameTagAction } from "../../_actions/learning";
import type { ActionResult } from "../../_lib/result";
import { ConfirmAction, Dialog } from "../dialog";
import { Icon } from "../icon";
import { useToast } from "../toast";

export interface TagRow { tagId: string; name: string; courseCount: number }
type Err = { code: string; message: string; hint?: string | undefined } | null;

export function TagManager({ tags }: { tags: TagRow[] }) {
  const router = useRouter();
  const toast = useToast();
  const [name, setName] = useState("");
  const [error, setError] = useState<Err>(null);
  const [pending, start] = useTransition();
  const [renaming, setRenaming] = useState<TagRow | null>(null);
  const [newName, setNewName] = useState("");
  const [renameError, setRenameError] = useState<Err>(null);

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
        className="filter-bar"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          run(() => createTagAction(name), "标签已创建", setError, () => setName(""));
        }}
      >
        <label className="course-search">
          <Icon name="tag" />
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="新标签名称，最多 32 字" maxLength={32} aria-label="新标签名称" />
        </label>
        <button type="submit" className="btn btn-primary btn-sm" disabled={pending || name.trim() === ""}>
          <Icon name="plus" /> 新建标签
        </button>
        <span className="filter-note">改名原地生效，不需要迁移课程引用。</span>
      </form>
      {error ? (
        <div className="callout warn" role="alert" style={{ margin: "12px 0" }}>
          <Icon name="alert" />
          <span>{error.message}（错误码 {error.code}）</span>
        </div>
      ) : null}

      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>标签</th><th className="right">引用课程</th><th className="right">操作</th></tr>
          </thead>
          <tbody>
            {tags.map((t) => (
              <tr key={t.tagId}>
                <td><span className="tag">{t.name}</span></td>
                <td className="right num">{t.courseCount}</td>
                <td className="right nowrap">
                  <button type="button" className="btn btn-sm" onClick={() => { setRenaming(t); setNewName(t.name); setRenameError(null); }}>改名</button>{" "}
                  <ConfirmAction
                    label="删除"
                    title={`删除标签「${t.name}」`}
                    confirmLabel="删除标签"
                    danger
                    action={deleteTagAction.bind(null, t.tagId)}
                    doneMessage="标签已删除"
                  >
                    {t.courseCount > 0
                      ? <p>这个标签正被 {t.courseCount} 门课程使用，<strong>不能删除</strong>。请先在这些课程里取消选择，或改名。</p>
                      : <p>删除后不可恢复。没有课程在使用它。</p>}
                  </ConfirmAction>
                </td>
              </tr>
            ))}
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
              onClick={() => renaming && run(() => renameTagAction(renaming.tagId, newName), "标签已改名", setRenameError, () => setRenaming(null))}
            >
              {pending ? "处理中…" : "保存新名称"}
            </button>
          </>
        }
      >
        <div className="field">
          <label htmlFor="rename-tag">新名称</label>
          <input id="rename-tag" className="input" value={newName} maxLength={32} onChange={(e) => setNewName(e.target.value)} />
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
