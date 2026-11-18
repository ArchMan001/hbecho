// g-learning-min 任务 3（G-1 / G-2 / G-5，acceptance B1–B3、C1、C5–C7、I6）：资料课程创建与 OSS 直传校验。
import { beforeEach, describe, expect, it } from "vitest";
import { SAMPLE } from "../../../tests/harness/fake-course-store";
import { useTestDb } from "../../../tests/harness/db";
import { auditOf, learningEnv, type LearningEnv } from "../../../tests/harness/learning";
import { auditEvents, courseBrandScopes, courses, courseTags, tags } from "../../db/schema";
import { AuditWriteError, createAuditWriter, type AuthContext } from "../access-control";
import { createDocumentCourse, requestUpload } from "./courses";
import { LearningError } from "./errors";
import { listCourses, parseListQuery } from "./read";

const t = useTestDb();
let e: LearningEnv;
let admin: AuthContext;
let tagId: bigint;
beforeEach(async () => {
  e = await learningEnv(t, { config: { docMaxBytes: 4096, coverMaxBytes: 2048 } });
  admin = await e.actor("platform_admin");
  tagId = await e.insertTag("新人");
});

const fails = async (p: Promise<unknown>, status: number, code?: string) => {
  const err = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(err).toBeInstanceOf(LearningError);
  expect((err as LearningError).status).toBe(status);
  if (code) expect((err as LearningError).code).toBe(code);
};

/** 走完「取地址 → 浏览器直传」，返回 key。 */
async function upload(ctx: AuthContext, slot: "doc" | "cover", mime: string, bytes: Uint8Array): Promise<string> {
  const ticket = await requestUpload(e.deps, ctx, { slot, mime, size: bytes.byteLength });
  e.store.upload(ticket.key, bytes, mime);
  return ticket.key;
}
const base = async (ctx: AuthContext = admin) => ({
  title: "门店陈列手册",
  description: "新店陈列要点",
  brandScope: { all: true } as const,
  tagIds: [tagId.toString()],
  fileKey: await upload(ctx, "doc", "application/pdf", SAMPLE.pdf),
  coverKey: await upload(ctx, "cover", "image/png", SAMPLE.png),
});

describe("取直传地址", () => {
  it("返回本服务生成的 key；签名绑定 Content-Type 与有效期；不含用户输入", async () => {
    const tk = await requestUpload(e.deps, admin, { slot: "doc", mime: "application/pdf", size: 1000 });
    expect(tk.key).toMatch(/^doc\/[0-9a-f-]{36}\.pdf$/);
    expect(e.store.signedPut).toEqual([{ key: tk.key, contentType: "application/pdf", ttlSeconds: 600 }]);
    expect(tk.maxBytes).toBe(4096);
    expect(tk.uploadUrl).toContain(tk.key);
  });

  it("C5 / C6：.docx、超限、封面用 PDF 都在取地址前被拒", async () => {
    const docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    await fails(requestUpload(e.deps, admin, { slot: "doc", mime: docx, size: 10 }), 400, "file_type_not_allowed");
    await fails(requestUpload(e.deps, admin, { slot: "doc", mime: "application/pdf", size: 4097 }), 400, "file_too_large");
    await fails(requestUpload(e.deps, admin, { slot: "doc", mime: "application/pdf", size: 0 }), 400, "file_too_large");
    await fails(requestUpload(e.deps, admin, { slot: "cover", mime: "application/pdf", size: 10 }), 400, "file_type_not_allowed");
    await fails(requestUpload(e.deps, admin, { slot: "cover", mime: "image/png", size: 2049 }), 400, "file_too_large");
    await fails(requestUpload(e.deps, admin, { slot: "video" as never, mime: "image/png", size: 1 }), 400, "invalid_slot");
    expect(e.store.signedPut).toEqual([]);
  });

  it("没有 learning.manage 的角色 403", async () => {
    for (const role of ["branch_manager", "store_staff"] as const) {
      const ctx = await e.actor(role, { brandIds: [e.org.hisense], branchIds: [e.org.bj], ...(role === "store_staff" ? { staff: e.org.staffA } : {}) });
      await fails(requestUpload(e.deps, ctx, { slot: "doc", mime: "application/pdf", size: 10 }), 403);
    }
  });
});

describe("是否允许下载（G-D50）", () => {
  it("创建时可关闭下载，审计记录该值；不给就是允许；非布尔值被拒", async () => {
    await createDocumentCourse(e.deps, admin, { ...(await base()), allowDownload: false });
    const [row] = await t.db.select().from(courses);
    expect(row!.allowDownload).toBe(false);
    const [ev] = await auditOf(t, "learning_course_created");
    expect(ev!.detail).toMatchObject({ allowDownload: false });
    await fails(createDocumentCourse(e.deps, admin, { ...(await base()), allowDownload: "no" as never }), 400, "invalid_input");
  });
});
describe("创建成功", () => {
  it("C1：保存即发布，学员列表立即可见；全部品牌不写品牌范围行", async () => {
    const { courseId } = await createDocumentCourse(e.deps, admin, await base());
    const [row] = await t.db.select().from(courses);
    expect(row).toMatchObject({ kind: "document", status: "published", brandScope: "all", audienceLevel: "all", allowDownload: true, fileMime: "application/pdf", fileSize: SAMPLE.pdf.byteLength, createdBy: admin.userId, unpublishedAt: null });
    expect(row!.coverKey).toMatch(/^cover\//);
    expect(row!.courseId.toString()).toBe(courseId);
    expect(await t.db.select().from(courseBrandScopes)).toEqual([]);
    expect(await t.db.select().from(courseTags)).toEqual([{ courseId: row!.courseId, tagId }]);

    const staff = await e.actor("store_staff", { brandIds: [e.org.hisense], branchIds: [e.org.bj], staff: e.org.staffA });
    const list = await listCourses(e.deps, staff, parseListQuery(new URLSearchParams()));
    expect(list.items.map((i) => i.courseId)).toEqual([courseId]);
  });

  it("指定品牌写品牌范围行；审计记下关键字段但不含文件内容", async () => {
    const cover = await upload(admin, "cover", "image/png", SAMPLE.png);
    const { courseId } = await createDocumentCourse(e.deps, admin, {
      ...(await base()),
      brandScope: { brandIds: [e.org.hisense.toString(), e.org.hitachi.toString(), e.org.hisense.toString()] }, // 重复项去重
      audienceLevel: "branch_and_above",
      coverKey: cover,
    });
    const scopes = await t.db.select().from(courseBrandScopes);
    expect(scopes.map((s) => s.brandId).sort()).toEqual([e.org.hisense, e.org.hitachi].sort());
    const [row] = await t.db.select().from(courses);
    expect(row).toMatchObject({ brandScope: "specified", audienceLevel: "branch_and_above", coverKey: cover });

    const [ev] = await auditOf(t, "learning_course_created");
    expect(ev).toMatchObject({ actor: admin.actor, outcome: "succeeded", targetType: "course", targetId: courseId });
    expect(ev!.detail).toMatchObject({ title: "门店陈列手册", kind: "document", brandScope: "specified", audienceLevel: "branch_and_above", fileMime: "application/pdf", coverKey: cover });
    expect(JSON.stringify(ev!.detail)).not.toContain("%PDF");
  });

  it("图片资料（JPG / PNG）同样可以作为资料课", async () => {
    const jpg = await upload(admin, "doc", "image/jpeg", SAMPLE.jpg);
    const png = await upload(admin, "doc", "image/png", SAMPLE.png);
    await createDocumentCourse(e.deps, admin, { ...(await base()), fileKey: jpg });
    await createDocumentCourse(e.deps, admin, { ...(await base()), fileKey: png });
    expect((await t.db.select().from(courses)).map((c) => c.fileMime).sort()).toEqual(["image/jpeg", "image/png"]);
  });
});

describe("品牌范围与权限（G-2）", () => {
  it("B1：既没选品牌也没勾全部品牌 → 400，不落库，也不动已上传的对象", async () => {
    const b = await base();
    await fails(createDocumentCourse(e.deps, admin, { ...b, brandScope: {} }), 400, "invalid_input");
    await fails(createDocumentCourse(e.deps, admin, { ...b, brandScope: { brandIds: [] } }), 400, "invalid_input");
    await fails(createDocumentCourse(e.deps, admin, { ...b, brandScope: { all: true, brandIds: ["1"] } }), 400, "invalid_input"); // 二选一
    const { brandScope: _drop, ...noScope } = b;
    await fails(createDocumentCourse(e.deps, admin, noScope), 400, "invalid_input");
    expect(await t.db.select().from(courses)).toEqual([]);
  });

  it("B2 / B3：hq_manager 勾未授权品牌 403；可选自己授权的品牌，也可选全部品牌", async () => {
    const hq = await e.actor("hq_manager", { brandIds: [e.org.hisense] });
    await fails(createDocumentCourse(e.deps, hq, { ...(await base(hq)), brandScope: { brandIds: [e.org.hitachi.toString()] } }), 403, "brand_out_of_scope");
    await fails(createDocumentCourse(e.deps, hq, { ...(await base(hq)), brandScope: { brandIds: [e.org.hisense.toString(), e.org.hitachi.toString()] } }), 403, "brand_out_of_scope");
    await createDocumentCourse(e.deps, hq, { ...(await base(hq)), brandScope: { brandIds: [e.org.hisense.toString()] } });
    await createDocumentCourse(e.deps, hq, { ...(await base(hq)), brandScope: { all: true } });
    expect(await t.db.select().from(courses)).toHaveLength(2);
  });

  it("没有 learning.manage 的角色创建 403", async () => {
    const bm = await e.actor("branch_manager", { brandIds: [e.org.hisense], branchIds: [e.org.bj] });
    await fails(createDocumentCourse(e.deps, bm, await base(admin)), 403);
    expect(await t.db.select().from(courses)).toEqual([]);
  });

  it("品牌或标签不存在 → 400", async () => {
    await fails(createDocumentCourse(e.deps, admin, { ...(await base()), brandScope: { brandIds: ["424242"] } }), 400, "brand_not_found");
    await fails(createDocumentCourse(e.deps, admin, { ...(await base()), tagIds: ["424242"] }), 400, "tag_not_found");
  });
});

describe("必填项（G-1）", () => {
  it("缺标题、简介、标签、文件，或字段多余 → 400", async () => {
    const b = await base();
    for (const bad of [{ title: "  " }, { title: undefined }, { description: "" }, { description: undefined }, { tagIds: [] }, { tagIds: undefined }, { fileKey: undefined }, { coverKey: undefined }, { audienceLevel: "everyone" }, { kind: "video" }]) {
      await fails(createDocumentCourse(e.deps, admin, { ...b, ...bad }), 400, "invalid_input");
    }
    expect(await t.db.select().from(courses)).toEqual([]);
  });
});

describe("上传校验（G-5）：失败就删对象、不建行", () => {
  it("C7 / I6：.exe 改名成 .pdf，魔数不符 → 400，对象被删；另一份真 PDF 正常", async () => {
    const fake = await upload(admin, "doc", "application/pdf", SAMPLE.exe);
    await fails(createDocumentCourse(e.deps, admin, { ...(await base()), fileKey: fake }), 400, "file_content_mismatch");
    expect(e.store.deleted).toEqual([fake]);
    expect(e.store.objects.has(fake)).toBe(false);
    expect(await t.db.select().from(courses)).toEqual([]);

    await createDocumentCourse(e.deps, admin, await base());
    expect(await t.db.select().from(courses)).toHaveLength(1);
  });

  it("上传后对象超限（直传绕过了声明大小）→ 400 并删除", async () => {
    const key = (await requestUpload(e.deps, admin, { slot: "doc", mime: "application/pdf", size: 100 })).key;
    const bytes = new Uint8Array(5000); // 上限 4096
    bytes.set(SAMPLE.pdf);
    e.store.upload(key, bytes, "application/pdf");
    await fails(createDocumentCourse(e.deps, admin, { ...(await base()), fileKey: key }), 400, "file_too_large");
    expect(e.store.deleted).toEqual([key]);
  });

  it("对象的 Content-Type 与签发时的扩展名不一致 → 400 并删除", async () => {
    const key = (await requestUpload(e.deps, admin, { slot: "doc", mime: "application/pdf", size: 100 })).key;
    e.store.upload(key, SAMPLE.png, "image/png"); // 内容和类型自洽，但不是当初签发的 pdf
    await fails(createDocumentCourse(e.deps, admin, { ...(await base()), fileKey: key }), 400, "file_type_mismatch");
    expect(e.store.deleted).toEqual([key]);
  });

  it("对象的 Content-Type 不在白名单 → 400 并删除", async () => {
    const key = (await requestUpload(e.deps, admin, { slot: "doc", mime: "application/pdf", size: 100 })).key;
    e.store.upload(key, SAMPLE.pdf, "text/html");
    await fails(createDocumentCourse(e.deps, admin, { ...(await base()), fileKey: key }), 400, "file_type_not_allowed");
    expect(e.store.deleted).toEqual([key]);
  });

  it("还没有上传就提交 → 400（没有对象可删）", async () => {
    const key = (await requestUpload(e.deps, admin, { slot: "doc", mime: "application/pdf", size: 100 })).key;
    await fails(createDocumentCourse(e.deps, admin, { ...(await base()), fileKey: key }), 400, "upload_missing");
    expect(await t.db.select().from(courses)).toEqual([]);
  });

  it("封面校验失败：删封面、不建行，资料文件保留以便重试", async () => {
    const doc = await upload(admin, "doc", "application/pdf", SAMPLE.pdf);
    const cover = await upload(admin, "cover", "image/png", SAMPLE.jpg); // 声明 png，内容是 jpg
    await fails(createDocumentCourse(e.deps, admin, { ...(await base()), fileKey: doc, coverKey: cover }), 400, "file_content_mismatch");
    expect(e.store.deleted).toEqual([cover]);
    expect(e.store.objects.has(doc)).toBe(true);
    // 重新上传封面后用同一个资料文件即可成功
    const cover2 = await upload(admin, "cover", "image/png", SAMPLE.png);
    await createDocumentCourse(e.deps, admin, { ...(await base()), fileKey: doc, coverKey: cover2 });
    expect(await t.db.select().from(courses)).toHaveLength(1);
  });

  it("客户端回传的 key 必须是本服务签发的形态", async () => {
    for (const bad of ["doc/../cover/x.pdf", "hbecho-media/ods/a.pdf", "doc/a.pdf", "cover/00000000-0000-0000-0000-000000000000.png"]) {
      e.store.upload(bad, SAMPLE.pdf, "application/pdf");
      await fails(createDocumentCourse(e.deps, admin, { ...(await base()), fileKey: bad }), 400, "invalid_key");
      expect(e.store.deleted).not.toContain(bad); // 形态不对的 key 不是我们的对象，不动它
    }
  });

  it("已被别的课程占用的对象 → 409，且不会被删（否则会毁掉那门课的文件）", async () => {
    const b = await base();
    await createDocumentCourse(e.deps, admin, b);
    await fails(createDocumentCourse(e.deps, admin, b), 409, "file_already_used");
    expect(e.store.deleted).toEqual([]);
    expect(e.store.objects.has(b.fileKey)).toBe(true);
    expect(await t.db.select().from(courses)).toHaveLength(1);
  });
});

describe("审计尽力而为（G-D24、acceptance I3）", () => {
  it("I3：审计写入失败 → 业务照常成功，对象保留，并触发告警", async () => {
    const b = await base();
    const alerts: unknown[] = [];
    const deps = { ...e.deps, audit: { write: async () => Promise.reject(new AuditWriteError("注入的审计写入失败")) }, alert: (a: unknown) => void alerts.push(a) };
    const { courseId } = await createDocumentCourse(deps, admin, { ...b, brandScope: { brandIds: [e.org.hisense.toString()] } });
    expect((await t.db.select().from(courses)).map((c) => c.courseId.toString())).toEqual([courseId]);
    expect(await t.db.select().from(courseBrandScopes)).toHaveLength(1);
    expect(await t.db.select().from(courseTags)).toHaveLength(1);
    expect(e.store.deleted).toEqual([]); // 课程已建，文件不能删
    expect(alerts).toEqual([{ code: "audit_write_failed", eventType: "learning_course_created" }]);
  });

  it("I3（真实审计写入器）：audit_events 写不进去 → 业务成功，写入器记错误日志并累加失败计数", async () => {
    const logged: unknown[] = [];
    const brokenDb = new Proxy(t.db, { get: (target, prop, r) => (prop === "insert" ? (table: unknown) => (table === auditEvents ? { values: () => { throw new Error("audit table down"); } } : target.insert(table as never)) : Reflect.get(target, prop, r)) }) as typeof t.db;
    const audit = createAuditWriter({ db: brokenDb, clock: e.env.clock, logger: { error: (...a: unknown[]) => void logged.push(a) } as never });
    const b = await base();
    await createDocumentCourse({ ...e.deps, audit }, admin, b);
    expect(await t.db.select().from(courses)).toHaveLength(1);
    expect(audit.lowRiskFailures()).toBe(1);
    expect(JSON.stringify(logged)).toContain("audit.low_risk_write_failed");
  });
});

describe("失败不留残渣", () => {
  it("事务内失败（引用在校验后被改动）→ 不建行，已通过校验的对象删除", async () => {
    const b = await base();
    // 校验之后、提交之前标签被删：外键拒绝，整体回滚
    const real = e.deps.db;
    const racing = new Proxy(real, {
      get: (target, prop, r) =>
        prop === "transaction"
          ? async (fn: never) => {
              await t.db.delete(tags);
              return (target.transaction as never as (f: never) => Promise<unknown>)(fn);
            }
          : Reflect.get(target, prop, r),
    }) as typeof real;
    await fails(createDocumentCourse({ ...e.deps, db: racing }, admin, b), 409, "reference_changed");
    expect(await t.db.select().from(courses)).toEqual([]);
    expect([...e.store.deleted].sort()).toEqual([b.coverKey, b.fileKey].sort());
  });
});
