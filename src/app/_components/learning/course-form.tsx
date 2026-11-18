"use client";
// 新建 / 编辑课程（design §11，已确认原型 ui-lab/g-learning-min）。
// 新建：先把封面和文件直传到云（服务端不中转），再提交保存；保存即发布。编辑：改基本信息，封面可换；换文件在页面下方「替换文件」。
// 授权边界（品牌是否授权、文件校验）以服务端为准，这里只做展示与少走冤枉路。
import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import {
  createDocumentAction,
  createVideoAction,
  replaceDocumentAction,
  replaceVideoAction,
  requestUploadAction,
  requestVideoUploadAction,
  updateCourseAction,
} from "../../_actions/learning";
import { AUDIENCE_LABEL, AUDIENCE_OPTIONS } from "../../_lib/learning-labels";
import type { ActionResult } from "../../_lib/result";
import { Icon } from "../icon";
import { useToast } from "../toast";
import { TagPicker, type TagCategoryOption } from "./tag-picker";
import { putToOss, uploadToVod } from "./upload";

export interface BrandOption { id: string; name: string; allowed: boolean }
export interface CourseFormInitial {
  courseId: string;
  kind: "video" | "document";
  title: string;
  description: string;
  brandScope: "all" | "specified";
  brandIds: string[];
  audienceLevel: string;
  allowDownload: boolean;
  tagIds: string[];
  coverUrl: string;
}
type Err = { code: string; message: string } | null;

const IMAGE_TYPES = ["image/jpeg", "image/png"];
const DOC_TYPES = ["application/pdf", "image/jpeg", "image/png"];
const mb = (n: number) => `${Math.round(n / 1024 / 1024)} MB`;

function Chip({ active, disabled, onClick, children, lock }: { active: boolean; disabled?: boolean; onClick: () => void; children: React.ReactNode; lock?: boolean }) {
  return (
    <button type="button" className={`chip ${active ? "active" : ""}`} onClick={onClick} disabled={disabled} aria-pressed={active}>
      {lock ? <Icon name="lock" /> : null}
      {children}
    </button>
  );
}

function FilePick({ icon, label, hint, file, accept, onPick, progress, disabled }: { icon: "image" | "file" | "play"; label: string; hint: string; file: File | null; accept: string; onPick: (f: File | null) => void; progress: number | null; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <div className="upload-mini" role="button" tabIndex={0} onClick={() => !disabled && input.current?.click()} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && !disabled && input.current?.click()} aria-label={label}>
        <Icon name={icon} />
        <span>{file ? `${file.name}（${(file.size / 1024 / 1024).toFixed(1)} MB）` : hint}</span>
      </div>
      <input ref={input} type="file" accept={accept} hidden onChange={(e) => onPick(e.target.files?.[0] ?? null)} />
      {progress !== null ? <div className="progress-track" aria-label={`${label}上传进度`}><div className="progress-bar" style={{ width: `${progress}%` }} /></div> : null}
    </>
  );
}

/**
 * 真实 VOD 的实测（2026-11-11）：浏览器分片上传完成后，视频状态仍会在 Uploading 停留几秒到十几秒才进入转码。
 * 所以「保存」遇到 video_uploading 不是失败，等一会儿再确认；最多等约 90 秒，仍未完成才报错（视频与幂等键保留，可重试）。
 */
async function untilUploaded<T>(attempt: () => Promise<ActionResult<T>>, onWait: (waiting: boolean) => void): Promise<ActionResult<T>> {
  let r = await attempt();
  for (let i = 0; i < 30 && !r.ok && r.code === "video_uploading"; i++) {
    onWait(true);
    await new Promise((res) => setTimeout(res, 3000));
    r = await attempt();
  }
  onWait(false);
  return r;
}

const call = async <T,>(fn: () => Promise<ActionResult<T>>): Promise<ActionResult<T>> => {
  try {
    return await fn();
  } catch {
    return { ok: false, code: "network_error", message: "请求没有完成，请检查网络后重试" };
  }
};

export function CourseForm({ brands, categories, limits, initial }: { brands: BrandOption[]; categories: TagCategoryOption[]; limits: { docMaxBytes: number; coverMaxBytes: number; videoMaxBytes: number; videoMaxMinutes: number }; initial?: CourseFormInitial }) {
  const editing = initial !== undefined;
  const router = useRouter();
  const toast = useToast();
  const [kind, setKind] = useState<"video" | "document">(initial?.kind ?? "video");
  const [title, setTitle] = useState(initial?.title ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [scope, setScope] = useState<"all" | "specified">(initial?.brandScope ?? "specified");
  const [brandIds, setBrandIds] = useState<string[]>(initial?.brandIds ?? []);
  const [level, setLevel] = useState(initial?.audienceLevel ?? "all");
  const [allowDownload, setAllowDownload] = useState(initial?.allowDownload ?? true);
  const [tagIds, setTagIds] = useState<string[]>(initial?.tagIds ?? []);
  const [cover, setCover] = useState<File | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [pCover, setPCover] = useState<number | null>(null);
  const [pFile, setPFile] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<Err>(null);
  // 同一次填写里重试沿用同一个幂等键，避免重复建课（design §4.1）；文件换了才换键
  const idem = useRef<string>(crypto.randomUUID().replace(/-/g, ""));
  // 已经直传成功的对象：保存失败（比如没选标签）重试时不必重新上传大文件
  const done = useRef<{ cover?: { file: File; key: string }; doc?: { file: File; key: string }; video?: { file: File; videoId: string } }>({});

  const toggle = (list: string[], set: (v: string[]) => void, id: string) => set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  const fail = (e: { code: string; message: string }) => {
    setError(e);
    setBusy(false);
  };

  const uploadCover = async (): Promise<string | null> => {
    if (!cover) return null;
    if (done.current.cover?.file === cover) return done.current.cover.key;
    if (!IMAGE_TYPES.includes(cover.type)) throw { code: "file_type_not_allowed", message: "封面只支持 JPG、PNG" };
    if (cover.size > limits.coverMaxBytes) throw { code: "file_too_large", message: `封面不能超过 ${mb(limits.coverMaxBytes)}` };
    const t = await call(() => requestUploadAction("cover", cover.type, cover.size));
    if (!t.ok) throw t;
    setPCover(0);
    await putToOss(t.data, cover, setPCover).catch(() => Promise.reject({ code: "upload_failed", message: "封面上传失败，请检查网络后重试" }));
    done.current.cover = { file: cover, key: t.data.key };
    return t.data.key;
  };

  const submitNew = async () => {
    if (!cover) return fail({ code: "cover_required", message: "请上传封面（JPG / PNG）" });
    if (!file) return fail({ code: "file_required", message: kind === "video" ? "请选择视频文件" : "请选择资料文件" });
    if (scope === "specified" && brandIds.length === 0) return fail({ code: "brand_required", message: "请选择品牌，或选「全部品牌」" });
    if (tagIds.length === 0) return fail({ code: "tag_required", message: "请至少选择一个标签" });
    const brandScope = scope === "all" ? { all: true as const } : { brandIds };
    try {
      if (kind === "document") {
        if (!DOC_TYPES.includes(file.type)) return fail({ code: "file_type_not_allowed", message: "资料只支持 PDF、JPG、PNG" });
        if (file.size > limits.docMaxBytes) return fail({ code: "file_too_large", message: `资料不能超过 ${mb(limits.docMaxBytes)}` });
        const coverKey = await uploadCover();
        let key = done.current.doc?.file === file ? done.current.doc.key : null;
        if (!key) {
          const t = await call(() => requestUploadAction("doc", file.type, file.size));
          if (!t.ok) throw t;
          setPFile(0);
          await putToOss(t.data, file, setPFile).catch(() => Promise.reject({ code: "upload_failed", message: "文件上传失败，请检查网络后重试" }));
          key = t.data.key;
          done.current.doc = { file, key };
        }
        const r = await call(() => createDocumentAction({ title, description, audienceLevel: level, allowDownload, brandScope, tagIds, fileKey: key, coverKey }));
        if (!r.ok) {
          if (/^(file_|upload_|invalid_key)/.test(r.code)) done.current = {}; // 服务端已删掉失败的对象，下次重新传
          throw r;
        }
        toast("课程已发布，学员列表立即可见");
        router.push("/learning/manage");
        return;
      }
      if (!/\.mp4$/i.test(file.name)) return fail({ code: "file_type_not_allowed", message: "视频只支持 MP4 格式（H.264 / AAC）" });
      if (file.size > limits.videoMaxBytes) return fail({ code: "file_too_large", message: `视频不能超过 ${(limits.videoMaxBytes / 1024 ** 3).toFixed(0)} GB` });
      const coverKey = await uploadCover();
      let videoId = done.current.video?.file === file ? done.current.video.videoId : null;
      if (!videoId) {
        const t = await call(() => requestVideoUploadAction(title, file.name, file.size));
        if (!t.ok) throw t;
        setPFile(0);
        await uploadToVod(t.data, file, setPFile).catch(() => Promise.reject({ code: "upload_failed", message: "视频上传失败，请检查网络后重试" }));
        videoId = t.data.videoId;
        done.current.video = { file, videoId };
      }
      const r = await untilUploaded(() => call(() => createVideoAction({ title, description, audienceLevel: level, brandScope, tagIds, videoId, coverKey }, idem.current)), setWaiting);
      if (!r.ok) {
        if (/^(file_|upload_|video_|invalid_key)/.test(r.code)) {
          done.current = {};
          idem.current = crypto.randomUUID().replace(/-/g, "");
        }
        throw r;
      }
      toast(r.data.replayed ? "课程已存在（重复提交已合并）" : "课程已发布；视频转码完成后学员即可播放");
      router.push("/learning/manage");
    } catch (e) {
      fail({ code: (e as { code?: string }).code ?? "unknown", message: (e as { message?: string }).message ?? "保存失败，请稍后重试" });
    }
  };

  const submitEdit = async () => {
    if (!initial) return;
    if (scope === "specified" && brandIds.length === 0) return fail({ code: "brand_required", message: "请选择品牌，或选「全部品牌」" });
    if (tagIds.length === 0) return fail({ code: "tag_required", message: "请至少选择一个标签" });
    try {
      const coverKey = await uploadCover();
      const patch: Record<string, unknown> = { title, description, audienceLevel: level, brandScope: scope === "all" ? { all: true } : { brandIds }, tagIds, ...(kind === "document" ? { allowDownload } : {}) };
      if (coverKey) patch.coverKey = coverKey;
      const r = await call(() => updateCourseAction(initial.courseId, patch));
      if (!r.ok) {
        if (/^(file_|upload_|invalid_key)/.test(r.code)) done.current = {};
        throw r;
      }
      toast(r.data.changed.length ? "已保存，立即生效" : "没有需要保存的修改");
      router.push("/learning/manage");
      router.refresh();
    } catch (e) {
      fail({ code: (e as { code?: string }).code ?? "unknown", message: (e as { message?: string }).message ?? "保存失败，请稍后重试" });
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    await (editing ? submitEdit() : submitNew());
    setBusy(false);
    setPCover(null);
    setPFile(null);
  };

  return (
    <form className="card card-pad wizard-main" onSubmit={submit} noValidate>
      {!editing ? (
        <div className="field">
          <label>课程类型 *</label>
          <div className="kind-switch" role="radiogroup" aria-label="课程类型">
            <button type="button" role="radio" aria-checked={kind === "video"} className={`kind-option ${kind === "video" ? "active" : ""}`} onClick={() => { setKind("video"); setFile(null); }}>
              <Icon name="play" /> 视频{kind === "video" ? <span className="option-check"><Icon name="check" /></span> : null}
            </button>
            <button type="button" role="radio" aria-checked={kind === "document"} className={`kind-option ${kind === "document" ? "active" : ""}`} onClick={() => { setKind("document"); setFile(null); }}>
              <Icon name="file" /> 资料{kind === "document" ? <span className="option-check"><Icon name="check" /></span> : null}
            </button>
          </div>
          <span className="hint">视频走点播服务，资料支持 PDF / JPG / PNG；单课程单内容，保存后不能改类型。</span>
        </div>
      ) : null}

      <div className="form-grid" style={{ marginTop: editing ? 0 : 16 }}>
        <div className="field span-2">
          <label htmlFor="course-title">标题 *</label>
          <input className="input" id="course-title" maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例如：日立家装水机安装规范" />
        </div>
        <div className="field span-2">
          <label htmlFor="course-desc">简介 *</label>
          <textarea className="textarea" id="course-desc" maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="说明课程内容与适用场景（纯文本）。" />
        </div>
        <div className="field">
          <label>品牌范围 *</label>
          <div className="brand-options">
            <button type="button" className={`brand-option ${scope === "all" ? "active" : ""}`} onClick={() => setScope("all")}>
              <strong>全部品牌</strong>
              <span>新品牌上线后自动可见</span>
              {scope === "all" ? <span className="option-check"><Icon name="check" /></span> : null}
            </button>
            <button type="button" className={`brand-option ${scope === "specified" ? "active" : ""}`} onClick={() => setScope("specified")}>
              <strong>指定品牌</strong>
              <span>只对勾选的品牌可见</span>
              {scope === "specified" ? <span className="option-check"><Icon name="check" /></span> : null}
            </button>
          </div>
          {scope === "all" ? (
            <div className="callout warn" style={{ marginTop: 8 }}>
              <Icon name="alert" />
              <span>「全部品牌」会让将来新增的品牌自动看到这门课；品牌列表缓存最多 5 分钟。下架是全局的。</span>
            </div>
          ) : null}
        </div>
        <div className="field">
          <label htmlFor="course-level">适用人员级别 *</label>
          <select className="select" id="course-level" value={level} onChange={(e) => setLevel(e.target.value)}>
            {AUDIENCE_OPTIONS.map((k) => (
              <option key={k} value={k}>{AUDIENCE_LABEL[k]}</option>
            ))}
          </select>
          <span className="hint">与品牌范围取交集；门店专员只能看到「全部人员」的课程。</span>
        </div>
        {kind === "document" ? (
          <div className="field">
            <label>是否允许下载 *</label>
            <div className="brand-options" role="radiogroup" aria-label="是否允许下载">
              <button type="button" role="radio" aria-checked={allowDownload} className={`brand-option ${allowDownload ? "active" : ""}`} onClick={() => setAllowDownload(true)}>
                <strong>允许下载</strong>
                <span>学员可在线查看，也可下载原件</span>
                {allowDownload ? <span className="option-check"><Icon name="check" /></span> : null}
              </button>
              <button type="button" role="radio" aria-checked={!allowDownload} className={`brand-option ${!allowDownload ? "active" : ""}`} onClick={() => setAllowDownload(false)}>
                <strong>不允许下载</strong>
                <span>只能在线查看，没有下载入口</span>
                {!allowDownload ? <span className="option-check"><Icon name="check" /></span> : null}
              </button>
            </div>
            <span className="hint">对所有人一样。不能阻止截屏或录屏；关闭下载后随时可以改回。</span>
          </div>
        ) : null}
        <div className={`field span-2 ${scope === "all" ? "is-muted" : ""}`}>
          <label>指定品牌{scope === "all" ? "（全部品牌不需要选择）" : " *"}</label>
          <div className="brand-picks">
            {brands.map((b) => (
              <Chip key={b.id} active={scope === "specified" && brandIds.includes(b.id)} disabled={!b.allowed || scope === "all"} lock={!b.allowed} onClick={() => toggle(brandIds, setBrandIds, b.id)}>
                {b.name}
              </Chip>
            ))}
          </div>
          <span className="hint">总部只能选自己授权的品牌，或直接选「全部品牌」；不能逐个勾选未授权的品牌。</span>
        </div>
        <div className="field span-2">
          <label>标签 *（可多选；学员筛选时单选）</label>
          {categories.every((c) => c.tags.length === 0) ? (
            <span className="hint">还没有标签，请联系平台管理员先创建。</span>
          ) : (
            <TagPicker categories={categories} selected={tagIds} onToggle={(id) => toggle(tagIds, setTagIds, id)} />
          )}
          <span className="hint">标签集合由平台管理员维护；这里只能选择，不能新建。</span>
        </div>
        <div className="field">
          <label>封面 *{editing ? "（不换就不用选）" : ""}</label>
          <FilePick icon="image" label="选择封面" hint={`上传封面（JPG / PNG，≤ ${mb(limits.coverMaxBytes)}）`} file={cover} accept="image/jpeg,image/png" onPick={setCover} progress={pCover} disabled={busy} />
          {editing && initial ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={initial.coverUrl} alt="当前封面" style={{ marginTop: 8, maxWidth: 160, borderRadius: 8 }} />
          ) : null}
        </div>
        {!editing ? (
          <div className="field">
            <label>{kind === "video" ? "视频文件 *" : "资料文件 *"}</label>
            <FilePick
              icon={kind === "video" ? "play" : "file"}
              label="选择文件"
              hint={kind === "video" ? `MP4（H.264 / AAC），≤ ${(limits.videoMaxBytes / 1024 ** 3).toFixed(0)} GB、≤ ${limits.videoMaxMinutes} 分钟` : `PDF / JPG / PNG，≤ ${mb(limits.docMaxBytes)}`}
              file={file}
              accept={kind === "video" ? "video/mp4,.mp4" : "application/pdf,image/jpeg,image/png"}
              onPick={setFile}
              progress={pFile}
              disabled={busy}
            />
          </div>
        ) : null}
      </div>

      {error ? (
        <div className="callout danger" role="alert" style={{ marginTop: 16 }}>
          <Icon name="alert" />
          <span>
            {error.message}（错误码 {error.code}）
          </span>
        </div>
      ) : null}
      <div className="callout" style={{ marginTop: 16 }}>
        <Icon name="shield" />
        <span>保存前会校验权限、品牌与文件；保存成功后学员列表立即可见。</span>
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
        <button type="button" className="btn" onClick={() => router.push("/learning/manage")} disabled={busy}>取消</button>
        <button className="btn btn-primary" type="submit" disabled={busy}>
          <Icon name="check" /> {waiting ? "正在确认视频上传结果…" : busy ? "保存中…" : editing ? "保存修改" : "保存并发布"}
        </button>
      </div>
    </form>
  );
}

/** 编辑页的「替换文件」：直接覆盖，不保留旧版本，学习进度不清零，不可回滚。 */
export function ReplaceFile({ courseId, kind, limits }: { courseId: string; kind: "video" | "document"; limits: { docMaxBytes: number; videoMaxBytes: number } }) {
  const router = useRouter();
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<Err>(null);

  const go = async () => {
    if (!file || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (kind === "document") {
        if (!DOC_TYPES.includes(file.type)) throw { code: "file_type_not_allowed", message: "资料只支持 PDF、JPG、PNG" };
        if (file.size > limits.docMaxBytes) throw { code: "file_too_large", message: `资料不能超过 ${mb(limits.docMaxBytes)}` };
        const t = await call(() => requestUploadAction("doc", file.type, file.size));
        if (!t.ok) throw t;
        setProgress(0);
        await putToOss(t.data, file, setProgress).catch(() => Promise.reject({ code: "upload_failed", message: "文件上传失败，请检查网络后重试" }));
        const r = await call(() => replaceDocumentAction(courseId, { fileKey: t.data.key }));
        if (!r.ok) throw r;
      } else {
        if (!/\.mp4$/i.test(file.name)) throw { code: "file_type_not_allowed", message: "视频只支持 MP4 格式（H.264 / AAC）" };
        if (file.size > limits.videoMaxBytes) throw { code: "file_too_large", message: "视频超出大小上限" };
        const t = await call(() => requestVideoUploadAction(file.name, file.name, file.size));
        if (!t.ok) throw t;
        setProgress(0);
        await uploadToVod(t.data, file, setProgress).catch(() => Promise.reject({ code: "upload_failed", message: "视频上传失败，请检查网络后重试" }));
        const r = await untilUploaded(() => call(() => replaceVideoAction(courseId, { videoId: t.data.videoId })), setWaiting);
        if (!r.ok) throw r;
      }
      toast("文件已替换，学员立即看到新内容");
      setFile(null);
      router.refresh();
    } catch (e) {
      setError({ code: (e as { code?: string }).code ?? "unknown", message: (e as { message?: string }).message ?? "替换失败，请稍后重试" });
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  return (
    <div className="card card-pad" style={{ marginTop: 16 }}>
      <div className="rail-kicker">替换文件</div>
      <p className="hint" style={{ margin: "6px 0 12px" }}>直接覆盖，不保留旧版本、<strong>无法回滚</strong>；学习进度不清零。替换错了只能再传一次，上传前请自己确认内容。</p>
      <FilePick icon={kind === "video" ? "play" : "file"} label="选择新文件" hint={kind === "video" ? "选择新的 MP4 视频" : "选择新的 PDF / JPG / PNG"} file={file} accept={kind === "video" ? "video/mp4,.mp4" : "application/pdf,image/jpeg,image/png"} onPick={setFile} progress={progress} disabled={busy} />
      {error ? (
        <div className="callout danger" role="alert" style={{ marginTop: 12 }}>
          <Icon name="alert" />
          <span>{error.message}（错误码 {error.code}）</span>
        </div>
      ) : null}
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
        <button type="button" className="btn" onClick={go} disabled={!file || busy}>
          <Icon name="upload" /> {waiting ? "正在确认视频上传结果…" : busy ? "替换中…" : "替换文件"}
        </button>
      </div>
    </div>
  );
}
