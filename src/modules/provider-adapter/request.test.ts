import { describe, expect, it } from "vitest";
import { buildRequest } from "./request";

const text = (b: Uint8Array | null) => new TextDecoder().decode(b!);

describe("buildRequest（Adapter 输入合同）", () => {
  it("同步主页请求：POST /openapi/v1/media_user_info?async=false，body 只有 url", () => {
    const r = buildRequest({ action: "media_user_info", mode: "synchronous", locator: "https://v.douyin.com/x/" });
    expect(r.method).toBe("POST");
    expect(r.path).toBe("/openapi/v1/media_user_info");
    expect(r.query).toEqual({ async: "false" });
    expect(text(r.body)).toBe('{"url":"https://v.douyin.com/x/"}');
  });

  it("异步模式只改 query，不写死 async（R13.4）", () => {
    const r = buildRequest({ action: "media_user_info", mode: "asynchronous", locator: "x" });
    expect(r.query).toEqual({ async: "true" });
  });

  it("列表请求默认整数游标 0", () => {
    const r = buildRequest({ action: "user_video_list", mode: "synchronous", locator: "x" });
    expect(r.path).toBe("/openapi/v1/user_video_list");
    expect(text(r.body)).toBe('{"url":"x","max_cursor":0}');
  });

  it("游标类型原样发出：字符串带引号、整数不带，超大整数不丢精度（R10.4）", () => {
    const body = (cursor: Parameters<typeof buildRequest>[0]["cursor"]) =>
      text(buildRequest({ action: "user_video_list", mode: "synchronous", locator: "x", cursor }).body);
    expect(body({ kind: "string", value: "6a5098aa000000001603fb07" })).toBe('{"url":"x","max_cursor":"6a5098aa000000001603fb07"}');
    expect(body({ kind: "string", value: "0" })).toBe('{"url":"x","max_cursor":"0"}');
    expect(body({ kind: "integer", lexeme: "1782701295000" })).toBe('{"url":"x","max_cursor":1782701295000}');
    expect(body({ kind: "integer", lexeme: "9007199254740993" })).toBe('{"url":"x","max_cursor":9007199254740993}');
  });

  it("详情请求：POST /openapi/v1/media_stats_number，body 只有内容 url", () => {
    const r = buildRequest({ action: "media_stats_number", mode: "synchronous", locator: "https://www.douyin.com/video/76" });
    expect(r.path).toBe("/openapi/v1/media_stats_number");
    expect(r.query).toEqual({ async: "false" });
    expect(text(r.body)).toBe('{"url":"https://www.douyin.com/video/76"}');
  });
  it("评论请求：路径是 /openapi/v1/media/comments/list，首页游标整数 0，reply_pages=-1（不取回复）", () => {
    const r = buildRequest({ action: "post_comments_list", mode: "synchronous", locator: "https://www.xiaohongshu.com/explore/abc" });
    expect(r.path).toBe("/openapi/v1/media/comments/list");
    expect(text(r.body)).toBe('{"url":"https://www.xiaohongshu.com/explore/abc","max_cursor":0,"reply_pages":-1}');
  });
  it("评论翻页：上一页返回的字符串游标原样回发，不转整数；科学计数法游标同理", () => {
    const body = (cursor: Parameters<typeof buildRequest>[0]["cursor"], action: "post_comments_list" | "user_video_list" = "post_comments_list") =>
      text(buildRequest({ action, mode: "asynchronous", locator: "x", cursor }).body);
    expect(body({ kind: "string", value: "20" })).toBe('{"url":"x","max_cursor":"20","reply_pages":-1}');
    expect(body({ kind: "string", value: "1.785394950371E12" }, "user_video_list")).toBe('{"url":"x","max_cursor":"1.785394950371E12"}');
  });
  it("no_more 哨兵不是游标，不能进入请求", () => {
    expect(() => buildRequest({ action: "user_video_list", mode: "synchronous", locator: "x", cursor: { kind: "no_more" } as never })).toThrow();
  });
  it("locator 中的引号、换行与非 ASCII 被正确转义并以 UTF-8 编码", () => {
    const r = buildRequest({ action: "media_user_info", mode: "synchronous", locator: '日立"中央"\n空调' });
    expect(JSON.parse(text(r.body))).toEqual({ url: '日立"中央"\n空调' });
  });

  it("请求对象不含认证头：secret 只能由 transport 配置注入", () => {
    const r = buildRequest({ action: "media_user_info", mode: "synchronous", locator: "x" });
    expect(Object.keys(r).sort()).toEqual(["body", "method", "path", "query"]);
  });

  it("非法游标（absent / null / invalid）不能作为请求游标", () => {
    // 类型层面已排除；运行时防御：传入越权值时抛出，而不是静默改成 0
    expect(() =>
      buildRequest({ action: "user_video_list", mode: "synchronous", locator: "x", cursor: { kind: "null" } as never }),
    ).toThrow();
  });
});
