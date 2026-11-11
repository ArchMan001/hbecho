// learning 模块的纯函数与 OSS 适配器（离线，无数据库）。
import { describe, expect, it } from "vitest";
import type { DataScope } from "../access-control";
import { DEFAULT_LEARNING_CONFIG } from "./config";
import { LearningError } from "./errors";
import { downloadFileName, hasMagic, keyMatches, newKey } from "./files";
import { parseId } from "./ids";
import { attachmentDisposition, OssCourseStore, type CourseOssClientLike } from "./oss-course-store";
import { parseListQuery } from "./read";
import { allowedAudience, courseVisible, type CourseVisibilityRef } from "./visibility";

const scope = (brands: bigint[] | "all", level: 1 | 2 | 3): DataScope => ({
  brands: brands === "all" ? "all" : new Set(brands),
  branches: "all",
  self: { kind: "none" },
  level,
});
const ref = (over: Partial<CourseVisibilityRef> = {}): CourseVisibilityRef => ({ status: "published", brandScope: "specified", brandIds: [1n], audienceLevel: "all", ...over });

describe("可见范围（对象判断）", () => {
  it("人员级别 → 适用级别只在一处映射", () => {
    expect(allowedAudience(1)).toEqual(["all"]);
    expect(allowedAudience(2)).toEqual(["all", "branch_and_above"]);
    expect(allowedAudience(3)).toEqual(["all", "branch_and_above", "hq_and_above"]);
  });
  it("全部品牌课对任何品牌可见；指定集合只对交集可见", () => {
    expect(courseVisible(scope([9n], 1), ref({ brandScope: "all", brandIds: [] }))).toBe(true);
    expect(courseVisible(scope([1n], 1), ref())).toBe(true);
    expect(courseVisible(scope([2n, 3n], 3), ref())).toBe(false);
    expect(courseVisible(scope([1n, 2n], 3), ref({ brandIds: [2n, 7n] }))).toBe(true);
  });
  it("适用级别：branch_and_above 对门店不可见，hq_and_above 对分公司不可见", () => {
    expect(courseVisible(scope([1n], 1), ref({ audienceLevel: "branch_and_above" }))).toBe(false);
    expect(courseVisible(scope([1n], 2), ref({ audienceLevel: "branch_and_above" }))).toBe(true);
    expect(courseVisible(scope([1n], 2), ref({ audienceLevel: "hq_and_above" }))).toBe(false);
    expect(courseVisible(scope([1n], 3), ref({ audienceLevel: "hq_and_above" }))).toBe(true);
  });
  it("下架与归档不可见；空范围什么都不可见；平台级看全部品牌", () => {
    expect(courseVisible(scope([1n], 3), ref({ status: "unpublished" }))).toBe(false);
    expect(courseVisible(scope([1n], 3), ref({ status: "archived" }))).toBe(false);
    expect(courseVisible(scope([], 3), ref({ brandScope: "all", brandIds: [] }))).toBe(false);
    expect(courseVisible(scope("all", 3), ref({ brandIds: [42n] }))).toBe(true);
  });
});

describe("文件类型与对象 key", () => {
  it("魔数：PDF / JPEG / PNG 各认各的，改名文件不通过", () => {
    expect(hasMagic("application/pdf", new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]))).toBe(true);
    expect(hasMagic("application/pdf", new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]))).toBe(false); // exe 改名 .pdf
    expect(hasMagic("image/jpeg", new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe(true);
    expect(hasMagic("image/png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d]))).toBe(true);
    expect(hasMagic("image/png", new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe(false);
    expect(hasMagic("image/png", new Uint8Array([0x89, 0x50]))).toBe(false); // 太短
    expect(hasMagic("text/plain", new Uint8Array([0x61]))).toBe(false);
  });
  it("服务端生成的 key 通过形态校验；别的形态（含路径穿越、别的前缀）不通过", () => {
    expect(keyMatches("doc", newKey("doc", "application/pdf"))).toBe(true);
    expect(keyMatches("cover", newKey("cover", "image/png"))).toBe(true);
    expect(keyMatches("doc", newKey("cover", "image/png"))).toBe(false);
    expect(keyMatches("doc", "doc/../cover/x.pdf")).toBe(false);
    expect(keyMatches("doc", "hbecho-media/ods/abc.pdf")).toBe(false);
    expect(keyMatches("cover", "cover/00000000-0000-0000-0000-000000000000.pdf")).toBe(false);
  });
  it("下载文件名去掉路径与控制字符", () => {
    expect(downloadFileName('a/b\\c:"d"\n', "pdf")).toBe("a_b_c__d__.pdf");
    expect(downloadFileName("  ", "png")).toBe("course.png");
  });
});

describe("ID 与列表查询串", () => {
  it("ID 严格按十进制字符串解析，不经 Number", () => {
    expect(parseId("9223372036854775807", "x")).toBe(9223372036854775807n);
    for (const bad of ["0", "-1", "01", "1.5", "9223372036854775808", "", 12, null, "1e3"]) expect(() => parseId(bad, "x")).toThrow(LearningError);
  });
  it("多个 tag 参数被拒绝（不静默取第一个）", () => {
    expect(() => parseListQuery(new URLSearchParams("tag=1&tag=2"))).toThrow(/单个标签/);
  });
  it("缺省值与上限", () => {
    expect(parseListQuery(new URLSearchParams(""))).toEqual({ limit: 20, offset: 0 });
    expect(parseListQuery(new URLSearchParams("q= 安全 &tag=7&inProgress=1&limit=100&offset=40"))).toEqual({ q: "安全", tagId: 7n, inProgress: true, limit: 100, offset: 40 });
    expect(() => parseListQuery(new URLSearchParams("limit=101"))).toThrow(LearningError);
    expect(() => parseListQuery(new URLSearchParams("limit=0"))).toThrow(LearningError);
    expect(() => parseListQuery(new URLSearchParams("inProgress=yes"))).toThrow(LearningError);
    expect(() => parseListQuery(new URLSearchParams("tag=abc"))).toThrow(LearningError);
  });
});

describe("上限配置", () => {
  it("G-D44：资料 50 MiB、封面 5 MiB", () => {
    expect(DEFAULT_LEARNING_CONFIG.docMaxBytes).toBe(52_428_800);
    expect(DEFAULT_LEARNING_CONFIG.coverMaxBytes).toBe(5_242_880);
  });
});

describe("OssCourseStore（注入假客户端）", () => {
  function fakeClient() {
    const calls: Array<{ op: string; args: unknown[] }> = [];
    const objects = new Map<string, Buffer>([["doc/a.pdf", Buffer.from("%PDF-1.4 hello")]]);
    const notFound = Object.assign(new Error("secret-bearing message AccessKeyId=LTAIxxxx"), { code: "NoSuchKey", status: 404 });
    const client: CourseOssClientLike = {
      async head(name) {
        calls.push({ op: "head", args: [name] });
        const o = objects.get(name);
        if (!o) throw notFound;
        return { res: { headers: { "content-length": String(o.length), "content-type": "application/pdf" } } };
      },
      async get(name, options) {
        calls.push({ op: "get", args: [name, options] });
        const o = objects.get(name);
        if (!o) throw notFound;
        return { content: o.subarray(0, 8) };
      },
      async delete(name) {
        calls.push({ op: "delete", args: [name] });
        if (!objects.delete(name)) throw notFound;
      },
      signatureUrl(name, options) {
        calls.push({ op: "signatureUrl", args: [name, options] });
        return `https://signed.test/${name}`;
      },
    };
    return { client, calls };
  }
  const store = (client: CourseOssClientLike) => new OssCourseStore({ accessKeyId: "x", accessKeySecret: "y", region: "oss-cn-beijing", bucket: "hbecho-course", client });

  it("PUT 签名绑定 Content-Type；GET 带附件文件名", async () => {
    const { client, calls } = fakeClient();
    const s = store(client);
    await s.signedPutUrl("doc/a.pdf", "application/pdf", 600);
    await s.signedGetUrl("doc/a.pdf", 300, { downloadName: "安全 手册.pdf" });
    expect(calls[0]!.args[1]).toEqual({ expires: 600, method: "PUT", "Content-Type": "application/pdf" });
    const get = calls[1]!.args[1] as { response: Record<string, string>; method: string };
    expect(get.method).toBe("GET");
    expect(get.response["content-disposition"]).toBe(attachmentDisposition("安全 手册.pdf"));
    expect(get.response["content-disposition"]).toContain("filename*=UTF-8''%E5%AE%89%E5%85%A8%20%E6%89%8B%E5%86%8C.pdf");
    expect(get.response["content-disposition"]).not.toMatch(/filename="[^"]*[^\x20-\x7e]/);
  });
  it("head / getRange：存在时返回元数据与前 N 字节，不存在返回 null", async () => {
    const { client, calls } = fakeClient();
    const s = store(client);
    expect(await s.head("doc/a.pdf")).toEqual({ size: 14, contentType: "application/pdf" });
    expect(await s.head("doc/none.pdf")).toBeNull();
    expect(Buffer.from((await s.getRange("doc/a.pdf", 0, 7))!).toString()).toBe("%PDF-1.4");
    expect((calls.find((c) => c.op === "get")!.args[1] as { headers: Record<string, string> }).headers.Range).toBe("bytes=0-7");
    expect(await s.getRange("doc/none.pdf", 0, 7)).toBeNull();
  });
  it("delete 幂等；其它错误不带原始 message（可能夹带凭证）", async () => {
    const { client } = fakeClient();
    const s = store(client);
    await s.delete("doc/a.pdf");
    await s.delete("doc/a.pdf"); // 已不存在，不抛
    const broken: CourseOssClientLike = { ...client, delete: async () => { throw Object.assign(new Error("AccessKeyId=LTAIxxxx"), { code: "AccessDenied" }); } };
    await expect(store(broken).delete("doc/a.pdf")).rejects.toThrow("OSS delete 失败（AccessDenied）");
  });
});
