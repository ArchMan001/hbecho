// g-learning-min 任务 9（G-10，acceptance F3、F5、F6）：资料下载与下载审计（B 的出口 10）。
import { beforeEach, describe, expect, it } from "vitest";
import { useTestDb } from "../../../tests/harness/db";
import { auditOf, learningEnv, type LearningEnv } from "../../../tests/harness/learning";
import { auditEvents } from "../../db/schema";
import { MAX_SIGNED_LINK_TTL_SECONDS } from "../access-control";
import { downloadDocument } from "./download";
import { LearningError } from "./errors";
import { getCourse } from "./read";

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
};
const events = () => auditOf(t, "egress.learning_download");

describe("正常下载", () => {
  it("F5：返回短期附件链接；审计含操作者、课程 ID、文件标识、时间、结果", async () => {
    const staff = await e.actor("store_staff", { staff: e.org.staffA });
    const fileKey = "doc/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.pdf";
    const id = await e.insertCourse({ title: "陈列/手册:2026", brandIds: [e.org.hisense], fileKey });

    const link = await downloadDocument(e.deps, staff, id.toString());
    expect(link.fileName).toBe("陈列_手册_2026.pdf");
    expect(link.url).toContain(fileKey);
    expect(link.expiresAt).toBe(new Date(e.env.clock.now().getTime() + 300_000).toISOString());
    expect(e.store.signedGet).toEqual([{ key: fileKey, ttlSeconds: 300, downloadName: "陈列_手册_2026.pdf" }]);

    const rows = await events();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: staff.actor, actorUserId: staff.userId, outcome: "succeeded", reasonCode: "egress_allowed", targetType: "course", targetId: id.toString() });
    expect(rows[0]!.occurredAt).toEqual(e.env.clock.now());
    expect(rows[0]!.detail).toMatchObject({ exit: 10, capability: "learning.read", resource: "learning_course", fileId: fileKey });
  });

  it("有效期取配置与出口框架上限的较小值", async () => {
    const id = await e.insertCourse({});
    const long = { ...e.deps, config: { ...e.deps.config, downloadUrlTtlSeconds: 86_400 } };
    await downloadDocument(long, await e.actor("platform_admin"), id.toString());
    expect(e.store.signedGet[0]!.ttlSeconds).toBe(MAX_SIGNED_LINK_TTL_SECONDS);
  });

  it("按适用级别：门店专员能下载 all 级别，下载 branch_and_above 被拒", async () => {
    const staff = await e.actor("store_staff", { staff: e.org.staffA });
    const open = await e.insertCourse({});
    const restricted = await e.insertCourse({ audienceLevel: "branch_and_above" });
    await downloadDocument(e.deps, staff, open.toString());
    await fails(downloadDocument(e.deps, staff, restricted.toString()), 403);
  });
});

describe("拒绝", () => {
  it("F6 / B7：范围外 403，只记拒绝，没有成功记录，也没签链接", async () => {
    const hitachiStaff = await e.actor("store_staff", { staff: e.org.staffB });
    const id = await e.insertCourse({ brandIds: [e.org.hisense] });
    await fails(downloadDocument(e.deps, hitachiStaff, id.toString()), 403, "out_of_scope");
    const rows = await events();
    expect(rows.map((r) => r.outcome)).toEqual(["denied"]);
    expect(rows[0]).toMatchObject({ actor: hitachiStaff.actor, reasonCode: "out_of_scope", targetId: id.toString() });
    expect(e.store.signedGet).toEqual([]);
  });

  it("F3：下架与归档的课不可下载（即使是总部也一样）", async () => {
    const admin = await e.actor("platform_admin");
    const off = await e.insertCourse({ status: "unpublished" });
    const gone = await e.insertCourse({ status: "archived" });
    await fails(downloadDocument(e.deps, admin, off.toString()), 403);
    await fails(downloadDocument(e.deps, admin, gone.toString()), 403);
    expect((await events()).map((r) => r.outcome)).toEqual(["denied", "denied"]);
    expect(e.store.signedGet).toEqual([]);
  });

  it("没有 learning.read、服务身份：403；不存在的课：404；非法 ID：400", async () => {
    const staff = await e.actor("store_staff", { staff: e.org.staffA });
    const id = await e.insertCourse({});
    await fails(downloadDocument(e.deps, { ...staff, capabilities: new Set() }, id.toString()), 403);
    await fails(downloadDocument(e.deps, { ...staff, capabilities: new Set() }, "999999"), 403); // 没有动作权限的人探不到存在性
    const svc = { ...(await e.actor("platform_admin")), kind: "service" as const, actor: "service:plan-worker", userId: null, role: null };
    await fails(downloadDocument(e.deps, svc, id.toString()), 403, "service_principal_forbidden");
    await fails(downloadDocument(e.deps, staff, "999999"), 404, "course_not_found");
    await fails(downloadDocument(e.deps, staff, "x"), 400, "invalid_id");
    expect(e.store.signedGet).toEqual([]);
  });

  it("视频课没有原件：范围内 409，且不记下载成功；范围外仍是 403（不借此探课程类型）", async () => {
    const hq = await e.actor("hq_manager", { brandIds: [e.org.hisense] });
    const other = await e.actor("hq_manager", { brandIds: [e.org.hitachi] });
    const id = await e.insertCourse({ kind: "video", vodVideoId: "v1", vodVideoStatus: "normal", coverKey: "cover/x.jpg", fileKey: null, fileMime: null, fileSize: null, brandIds: [e.org.hisense] });
    await fails(downloadDocument(e.deps, hq, id.toString()), 409, "not_a_document");
    await fails(downloadDocument(e.deps, other, id.toString()), 403);
    expect((await events()).map((r) => r.outcome)).toEqual(["denied"]);
  });
});

describe("预览不是下载", () => {
  it("读详情不产生下载审计", async () => {
    const staff = await e.actor("store_staff", { staff: e.org.staffA });
    const id = await e.insertCourse({});
    await getCourse(e.deps, staff, id.toString());
    expect(await events()).toEqual([]);
  });
});

describe("签名失败", () => {
  it("守卫已放行但链接没签出来：补一条失败记录，返回 503，不泄露底层错误", async () => {
    const staff = await e.actor("store_staff", { staff: e.org.staffA });
    const id = await e.insertCourse({});
    e.store.failSignGet = true;
    await fails(downloadDocument(e.deps, staff, id.toString()), 503, "sign_failed");
    expect((await events()).map((r) => [r.outcome, r.reasonCode]).sort()).toEqual([["failed", "sign_failed"], ["succeeded", "egress_allowed"]]);
    // 重试成功后产生一条新的成功记录
    e.store.failSignGet = false;
    e.env.clock.advance(5000);
    await downloadDocument(e.deps, staff, id.toString());
    expect((await events()).filter((r) => r.outcome === "succeeded")).toHaveLength(2);
  });
});

describe("审计只增不改", () => {
  it("下载成功的审计在 audit_events 里是追加写入", async () => {
    const admin = await e.actor("platform_admin");
    const id = await e.insertCourse({});
    await downloadDocument(e.deps, admin, id.toString());
    e.env.clock.advance(2000);
    await downloadDocument(e.deps, admin, id.toString());
    expect(await t.db.select().from(auditEvents)).toHaveLength(2);
  });
});
