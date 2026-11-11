// g-learning-min 任务 2（G-3，acceptance C2/C3）：标签集合管理。
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { useTestDb } from "../../../tests/harness/db";
import { auditOf, learningEnv, type LearningEnv } from "../../../tests/harness/learning";
import { courseTags, tags } from "../../db/schema";
import { LearningError } from "./errors";
import { createTag, deleteTag, listTags, renameTag } from "./tags";

const t = useTestDb();
let e: LearningEnv;
beforeEach(async () => {
  e = await learningEnv(t);
});

const fails = async (p: Promise<unknown>, status: number, code?: string) => {
  const err = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(err).toBeInstanceOf(LearningError);
  expect((err as LearningError).status).toBe(status);
  if (code) expect((err as LearningError).code).toBe(code);
  return err as LearningError;
};

describe("写操作只给 learning.tag.manage", () => {
  it("hq_manager / branch_manager / store_staff 新建、改名、删除全部 403（C2）", async () => {
    const id = await e.insertTag("已有");
    for (const role of ["hq_manager", "branch_manager", "store_staff"] as const) {
      const ctx = await e.actor(role, { brandIds: [e.org.hisense], branchIds: [e.org.bj], ...(role === "store_staff" ? { staff: e.org.staffA } : {}) });
      await fails(createTag(e.deps, ctx, "新标签"), 403);
      await fails(renameTag(e.deps, ctx, id.toString(), "改名"), 403);
      await fails(deleteTag(e.deps, ctx, id.toString()), 403);
    }
    expect(await t.db.select().from(tags)).toHaveLength(1);
  });

  it("服务身份不能管理标签", async () => {
    const ctx = { ...(await e.actor("platform_admin")), kind: "service" as const, actor: "service:plan-worker", userId: null, role: null };
    await fails(createTag(e.deps, ctx, "x"), 403, "service_principal_forbidden");
  });

  it("超管新建、改名、删除，并留下审计", async () => {
    const admin = await e.actor("platform_admin");
    const created = await createTag(e.deps, admin, "  新员工  ");
    expect(created.name).toBe("新员工"); // 首尾空白去掉
    const renamed = await renameTag(e.deps, admin, created.tagId, "新人培训");
    expect(renamed).toEqual({ tagId: created.tagId, name: "新人培训" });
    await deleteTag(e.deps, admin, created.tagId);
    expect(await t.db.select().from(tags)).toHaveLength(0);

    const [c] = await auditOf(t, "learning_tag_created");
    expect(c).toMatchObject({ actor: admin.actor, actorUserId: admin.userId, outcome: "succeeded", targetType: "tag", targetId: created.tagId });
    expect((await auditOf(t, "learning_tag_renamed"))[0]!.detail).toEqual({ before: "新员工", after: "新人培训" });
    expect((await auditOf(t, "learning_tag_deleted"))[0]!.detail).toEqual({ name: "新人培训" });
  });
});

describe("名称规则", () => {
  it("空、过长、含控制字符被拒；重名 409（大小写不敏感）", async () => {
    const admin = await e.actor("platform_admin");
    await fails(createTag(e.deps, admin, "   "), 400, "tag_name_invalid");
    await fails(createTag(e.deps, admin, "字".repeat(33)), 400, "tag_name_invalid");
    await fails(createTag(e.deps, admin, "a\u0000b"), 400, "tag_name_invalid");
    await fails(createTag(e.deps, admin, 42), 400, "tag_name_invalid");
    await createTag(e.deps, admin, "字".repeat(32)); // 32 个字符恰好可以
    await createTag(e.deps, admin, "AI");
    await fails(createTag(e.deps, admin, "ai"), 409, "tag_exists");
    const other = await createTag(e.deps, admin, "合规");
    await fails(renameTag(e.deps, admin, other.tagId, "AI"), 409, "tag_exists");
  });

  it("不存在的标签：改名 / 删除 404；非法 ID 400", async () => {
    const admin = await e.actor("platform_admin");
    await fails(renameTag(e.deps, admin, "99999", "x"), 404, "tag_not_found");
    await fails(deleteTag(e.deps, admin, "99999"), 404, "tag_not_found");
    await fails(deleteTag(e.deps, admin, "abc"), 400, "invalid_id");
  });
});

describe("删除与引用", () => {
  it("C3：被引用的标签删除 409 并带引用数（含已下架课程），标签与引用都还在", async () => {
    const admin = await e.actor("platform_admin");
    const tagId = await e.insertTag("安全");
    await e.insertCourse({ tagIds: [tagId] });
    await e.insertCourse({ tagIds: [tagId], status: "unpublished" });
    const err = await fails(deleteTag(e.deps, admin, tagId.toString()), 409, "tag_in_use");
    expect(err.detail).toEqual({ referenceCount: 2 });
    expect(await t.db.select().from(tags)).toHaveLength(1);
    expect(await t.db.select().from(courseTags).where(eq(courseTags.tagId, tagId))).toHaveLength(2);
    expect(await auditOf(t, "learning_tag_deleted")).toHaveLength(0); // 没删成就不记删除
  });

  it("改名后课程引用不变", async () => {
    const admin = await e.actor("platform_admin");
    const tagId = await e.insertTag("旧名");
    const courseId = await e.insertCourse({ tagIds: [tagId] });
    await renameTag(e.deps, admin, tagId.toString(), "新名");
    const rows = await t.db.select().from(courseTags);
    expect(rows).toEqual([{ courseId, tagId }]);
  });
});

describe("列表", () => {
  it("所有持有 learning.read 的人可读名称（筛选要用），按名称排序；不含引用数", async () => {
    await e.insertTag("b-合规");
    await e.insertTag("a-新人");
    const staff = await e.actor("store_staff", { brandIds: [e.org.hisense], branchIds: [e.org.bj], staff: e.org.staffA });
    const list = await listTags(e.deps, staff);
    expect(list.map((x) => x.name)).toEqual(["a-新人", "b-合规"]);
    expect(list[0]).not.toHaveProperty("courseCount");
  });

  it("引用数只给标签管理者：withCounts 需要 learning.tag.manage", async () => {
    const tagId = await e.insertTag("安全");
    await e.insertCourse({ tagIds: [tagId] });
    await e.insertTag("空标签");
    const admin = await e.actor("platform_admin");
    expect((await listTags(e.deps, admin, { withCounts: true })).map((x) => [x.name, x.courseCount])).toEqual([["安全", 1], ["空标签", 0]]);
    const hq = await e.actor("hq_manager", { brandIds: [e.org.hisense] });
    await fails(listTags(e.deps, hq, { withCounts: true }), 403);
  });
});
