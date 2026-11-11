// learning 模块的纯函数与 OSS 适配器（离线，无数据库）。
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { DataScope } from "../access-control";
import { DEFAULT_LEARNING_CONFIG } from "./config";
import { LearningError } from "./errors";
import { LearningConfigError, parseLearningEnv } from "./runtime";
import { downloadFileName, hasMagic, keyMatches, newKey } from "./files";
import { parseId } from "./ids";
import { attachmentDisposition, OssCourseStore, type CourseOssClientLike } from "./oss-course-store";
import { parseListQuery } from "./read";
import { createVodClient, type VodSdkLike } from "./vod-aliyun";
import { mapVodStatus, VOD_ENDPOINT, VOD_REGION, VOD_TEMPLATE_GROUP_ID } from "./vod";
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
      async getStream(name) {
        calls.push({ op: "getStream", args: [name] });
        const o = objects.get(name);
        if (!o) throw notFound;
        return { stream: Readable.from([o]), res: { headers: { "content-length": String(o.length) } } };
      },
      async list() {
        return { objects: [] };
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
  it("getObject：流式返回对象与大小；不存在返回 null", async () => {
    const { client } = fakeClient();
    const s = store(client);
    const o = await s.getObject("doc/a.pdf");
    expect(o?.size).toBe(14);
    expect(await new Response(o!.body).text()).toBe("%PDF-1.4 hello");
    expect(await s.getObject("doc/none.pdf")).toBeNull();
  });
  it("region 两种写法都接受", async () => {
    const { normalizeOssRegion } = await import("./oss-course-store");
    expect([normalizeOssRegion("cn-beijing"), normalizeOssRegion("oss-cn-beijing")]).toEqual(["oss-cn-beijing", "oss-cn-beijing"]);
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

describe("VOD 适配器（注入假 SDK）", () => {
  const sdk = (over: Partial<VodSdkLike> = {}) => {
    const calls: Array<{ op: string; arg: unknown }> = [];
    const rec = <T,>(op: string, out: T) => async (arg: unknown) => (calls.push({ op, arg }), out);
    const s: VodSdkLike = {
      createUploadVideo: rec("create", { body: { videoId: "v1", uploadAddress: "addr", uploadAuth: "auth" } }) as VodSdkLike["createUploadVideo"],
      getVideoInfo: rec("info", { body: { video: { status: "Normal", duration: 12.2, size: 99 } } }) as VodSdkLike["getVideoInfo"],
      getVideoPlayAuth: rec("play", { body: { playAuth: "pa" } }) as VodSdkLike["getVideoPlayAuth"],
      deleteVideo: rec("delete", {}) as VodSdkLike["deleteVideo"],
      updateVideoInfo: rec("update", {}) as VodSdkLike["updateVideoInfo"],
      getVideoList: rec("list", { body: { total: 1, videoList: { video: [{ videoId: "v9", creationTime: "2026-11-10T01:02:03Z" }] } } }) as VodSdkLike["getVideoList"],
      ...over,
    };
    return { s, calls };
  };

  it("D1：取上传凭证时带转码模板组 3ca24a90…（VOD 默认 NoTranscode，不传就不转码）；地域与 endpoint 是写进代码的 cn-beijing 常量", async () => {
    const { s, calls } = sdk();
    await createVodClient(s).createUpload({ title: "t", fileName: "a.mp4", fileSize: 5 });
    expect(calls[0]!.arg).toEqual({ title: "t", fileName: "a.mp4", fileSize: 5, templateGroupId: "3ca24a90956dbbfa16f1f6cf2fe6ad3a" });
    expect(VOD_TEMPLATE_GROUP_ID).toBe("3ca24a90956dbbfa16f1f6cf2fe6ad3a");
    expect([VOD_REGION, VOD_ENDPOINT]).toEqual(["cn-beijing", "vod.cn-beijing.aliyuncs.com"]);
  });
  it("状态映射：Normal→normal，Uploading→uploading，失败类→failed，其余与未知→transcoding（不可播但会继续轮询）", () => {
    expect(["Normal", "Uploading", "UploadFail", "TranscodeFail", "Blocked", "UploadSucc", "Transcoding", "Checking", "Whatever", undefined].map(mapVodStatus)).toEqual([
      "normal", "uploading", "failed", "failed", "failed", "transcoding", "transcoding", "transcoding", "transcoding", "transcoding",
    ]);
  });
  it("getVideo：时长向上取整；不存在返回 null；其它错误只带错误码", async () => {
    expect(await createVodClient(sdk().s).getVideo("v1")).toEqual({ status: "normal", durationSec: 13, sizeBytes: 99 });
    const missing = sdk({ getVideoInfo: async () => { throw Object.assign(new Error("secret"), { code: "InvalidVideo.NotFound" }); } });
    expect(await createVodClient(missing.s).getVideo("v1")).toBeNull();
    const broken = sdk({ getVideoInfo: async () => { throw Object.assign(new Error("AccessKeyId=LTAIxxxx"), { code: "Throttling.User" }); } });
    await expect(createVodClient(broken.s).getVideo("v1")).rejects.toThrow("VOD GetVideoInfo 失败（Throttling.User）");
  });
  it("deleteVideo 幂等；播放凭证缺失视为失败；列表按创建时间截止并翻页", async () => {
    const gone = sdk({ deleteVideo: async () => { throw Object.assign(new Error("x"), { code: "InvalidVideo.NotFound" }); } });
    await createVodClient(gone.s).deleteVideo("v1");
    const empty = sdk({ getVideoPlayAuth: async () => ({ body: {} }) });
    await expect(createVodClient(empty.s).getPlayAuth("v1")).rejects.toThrow("VOD GetVideoPlayAuth 失败");
    const { s, calls } = sdk();
    expect(await createVodClient(s).listVideosBefore(new Date("2026-11-10T00:00:00.123Z"))).toEqual([{ videoId: "v9", createdAt: new Date("2026-11-10T01:02:03Z") }]);
    expect(calls[0]!.arg).toEqual({ endTime: "2026-11-10T00:00:00Z", pageNo: 1, pageSize: 100, sortBy: "CreationTime:Asc" });
  });
});

describe("装配配置", () => {
  it("缺少凭证 / 地域时只报键名，不带任何值", () => {
    expect(() => parseLearningEnv({})).toThrow(LearningConfigError);
    try {
      parseLearningEnv({ OSS_ACCESS_KEY_ID: "id-secret-value" });
    } catch (e) {
      expect((e as LearningConfigError).keys).toEqual(["HBECHO_LEARNING_ACCESS_KEY_SECRET", "HBECHO_COURSE_OSS_REGION"]);
      expect((e as Error).message).not.toContain("id-secret-value");
    }
  });
  it("专用凭证优先，缺省回退到 OSS_*；桶缺省 hbecho-course", () => {
    const cfg = parseLearningEnv({ OSS_ACCESS_KEY_ID: "a", OSS_ACCESS_KEY_SECRET: "b", OSS_REGION: "cn-beijing", HBECHO_LEARNING_ACCESS_KEY_ID: "x" });
    expect(cfg).toMatchObject({ accessKeyId: "x", accessKeySecret: "b", region: "cn-beijing", bucket: "hbecho-course" });
    expect(parseLearningEnv({ HBECHO_LEARNING_ACCESS_KEY_ID: "a", HBECHO_LEARNING_ACCESS_KEY_SECRET: "b", HBECHO_COURSE_OSS_REGION: "oss-cn-beijing", HBECHO_COURSE_OSS_BUCKET: "other" }).bucket).toBe("other");
  });
});
