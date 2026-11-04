import { describe, expect, it } from "vitest";
import { bytesOf, decodedData, envelope } from "../../../tests/harness/decode-helpers";
import { loadFixtureBytes } from "../../../tests/harness/fixtures";
import { decodeVideoList } from "./decode-video-list";

const count = <T>(xs: T[], key: (x: T) => string) =>
  xs.reduce<Record<string, number>>((m, x) => ((m[key(x)] = (m[key(x)] ?? 0) + 1), m), {});

describe("抖音 user_video_list fixture（raw3，20 条）", () => {
  const outcome = decodeVideoList("douyin", loadFixtureBytes("raw3.douyin.user_video_list"));
  const d = decodedData(outcome);

  it("返回的 20 条全部解出，不按任何本地 limit 截断", () => {
    expect(d.entries).toHaveLength(20);
    expect(d.entries.map((e) => e.position)).toEqual([...Array(20).keys()]);
  });

  it("action 三元组分列且一致；has_more 归一为布尔", () => {
    if (outcome.outcome !== "decoded") throw new Error("expected decoded");
    expect(outcome.exchange).toEqual({
      requested: "user_video_list",
      expectedResponse: "user_video_list",
      actualResponse: { state: "value", value: "user_video_list" },
    });
    expect(d.hasMore).toEqual({ state: "value", value: true });
  });

  it("max_cursor 保持整数类型与原文（v2 cursor_envelope 的 integer/lexeme）", () => {
    expect(d.maxCursor).toEqual({ kind: "integer", lexeme: "1782701295000" });
  });

  it("作者：19 条 HITACHI1，1 条异作者 HITACHI2023，均在 douyin.user_id 命名空间", () => {
    const authors = count(d.entries, (e) => (e.author.id.state === "value" ? e.author.id.value : "?"));
    expect(authors).toEqual({ HITACHI1: 19, HITACHI2023: 1 });
    expect(new Set(d.entries.map((e) => e.author.namespace))).toEqual(new Set(["douyin.user_id"]));
  });

  it("每条同时带 sec_uid，作为同一 payload 内的第二官方标识；异作者的 sec_uid 不同", () => {
    const bySec = new Map<string, Set<string>>();
    for (const e of d.entries) {
      if (e.author.id.state !== "value" || e.authorSecUid?.state !== "value") throw new Error("缺 sec_uid");
      (bySec.get(e.author.id.value) ?? bySec.set(e.author.id.value, new Set()).get(e.author.id.value)!).add(
        e.authorSecUid.value,
      );
    }
    expect([...bySec.get("HITACHI1")!]).toHaveLength(1);
    expect([...bySec.get("HITACHI2023")!]).toHaveLength(1);
    expect(bySec.get("HITACHI1")!.values().next().value).not.toBe(bySec.get("HITACHI2023")!.values().next().value);
  });

  it("post_id 是 19 位文本原文；发布时间为毫秒", () => {
    expect(d.entries[0]!.postId).toEqual({ state: "value", value: "7680127373081070848" });
    expect(d.entries[0]!.publishedAtMs).toEqual({ state: "value", value: 1788169004000n });
  });

  it("列表播放数一律 unsupported（接口返回的 0 不是有效观测）；其余指标的真实 0 保持 value（R5.6）", () => {
    for (const e of d.entries) expect(e.metrics.play).toEqual({ state: "unsupported" });
    expect(d.entries[0]!.metrics.like).toEqual({ state: "value", value: 0n });
    expect(d.entries[0]!.metrics.share).toEqual({ state: "value", value: 0n });
  });

  it("有视频素材 → content_kind=video；绝不输出 mixed", () => {
    expect(new Set(d.entries.map((e) => e.contentKind))).toEqual(new Set(["video"]));
  });

  it("封面：保留 3 个候选，归档引用固定第 2 条（540 宽）", () => {
    for (const e of d.entries) {
      expect(e.cover.candidates).toHaveLength(3);
      expect(e.cover.selection).toBe("second_of_array");
      expect(e.cover.selected).toBe(e.cover.candidates[1]);
    }
    expect(d.entries[0]!.cover.selected).toContain("540:q75");
  });
});

describe("小红书 user_video_list fixture（raw3，21 条）", () => {
  const d = decodedData(decodeVideoList("xiaohongshu", loadFixtureBytes("raw3.xiaohongshu.user_video_list")));

  it("21 条全部解出", () => {
    expect(d.entries).toHaveLength(21);
  });

  it("max_cursor 保持字符串类型与原文", () => {
    expect(d.maxCursor).toEqual({ kind: "string", value: "6a5098aa000000001603fb07" });
    expect(d.hasMore).toEqual({ state: "value", value: true });
  });

  it("作者全部是 5decba2300000000010007e1，命名空间 xiaohongshu.content.user_id，无 sec_uid 概念", () => {
    for (const e of d.entries) {
      expect(e.author).toEqual({
        namespace: "xiaohongshu.content.user_id",
        id: { state: "value", value: "5decba2300000000010007e1" },
      });
      expect(e.authorSecUid).toBeNull();
    }
  });

  it("按条目容错：17 条有 text，4 条缺 text 且不影响其他条目", () => {
    const states = count(d.entries, (e) => e.text.state);
    expect(states).toEqual({ value: 17, missing: 4 });
  });

  it("播放数 unsupported（小红书无该字段）；点赞等指标为 value", () => {
    for (const e of d.entries) {
      expect(e.metrics.play).toEqual({ state: "unsupported" });
      expect(e.metrics.like.state).toBe("value");
    }
    expect(d.entries[0]!.metrics.like).toEqual({ state: "value", value: 308n });
  });

  it("content_kind：4 条有视频 → video，其余 17 条 → image", () => {
    expect(count(d.entries, (e) => e.contentKind)).toEqual({ video: 4, image: 17 });
  });

  it("封面 cover 是单个字符串：直接作为封面引用，不是『第 2 条』", () => {
    for (const e of d.entries) {
      expect(e.cover.candidates).toHaveLength(1);
      expect(e.cover.selection).toBe("single_string");
      expect(e.cover.selected).toBe(e.cover.candidates[0]);
    }
  });
});

describe("合成场景：列表整体语义", () => {
  const list = (resultJson: string) => decodeVideoList("douyin", envelope("user_video_list", resultJson));

  it("0 条且 has_more=false 是真实空列表，不是失败", () => {
    const d = decodedData(list('{"result":[],"has_more":false,"cursor":"","max_cursor":""}'));
    expect(d.entries).toEqual([]);
    expect(d.hasMore).toEqual({ state: "value", value: false });
    expect(d.maxCursor).toEqual({ kind: "string", value: "" });
  });

  it("result 不是数组：schema_drift，技术问题不会被当成空列表", () => {
    for (const r of ['{"has_more":false}', '{"result":null}', '{"result":"x"}', '{"result":{}}']) {
      expect(list(r).outcome).toBe("schema_drift");
    }
  });

  it("has_more 的 boolean 与 0/1 归一为布尔；其他取值为 invalid，缺失为 missing", () => {
    expect(decodedData(list('{"result":[],"has_more":1}')).hasMore).toEqual({ state: "value", value: true });
    expect(decodedData(list('{"result":[],"has_more":0}')).hasMore).toEqual({ state: "value", value: false });
    expect(decodedData(list('{"result":[],"has_more":"yes"}')).hasMore.state).toBe("invalid");
    expect(decodedData(list('{"result":[],"has_more":2}')).hasMore.state).toBe("invalid");
    expect(decodedData(list('{"result":[]}')).hasMore).toEqual({ state: "missing" });
  });

  it("max_cursor 的整数、字符串、null、缺失、非法互不转换", () => {
    const c = (frag: string) => decodedData(list(`{"result":[]${frag}}`)).maxCursor;
    expect(c(',"max_cursor":0')).toEqual({ kind: "integer", lexeme: "0" });
    expect(c(',"max_cursor":"0"')).toEqual({ kind: "string", value: "0" });
    expect(c(',"max_cursor":null')).toEqual({ kind: "null" });
    expect(c("")).toEqual({ kind: "absent" });
    expect(c(',"max_cursor":1.5')).toEqual({ kind: "invalid", raw: "1.5" });
    expect(c(',"max_cursor":9007199254740993')).toEqual({ kind: "integer", lexeme: "9007199254740993" });
  });

  it("同一 post_id 重复出现：两条都返回，不去重（去重属于投影层）", () => {
    const entry = '{"post_id":"p1","user_id":"u","video":{"url":"v"},"images":[]}';
    const d = decodedData(list(`{"result":[${entry},${entry}],"has_more":false}`));
    expect(d.entries.map((e) => e.postId)).toEqual([
      { state: "value", value: "p1" },
      { state: "value", value: "p1" },
    ]);
    expect(d.entries.map((e) => e.position)).toEqual([0, 1]);
  });

  it("数字型 post_id 以原文保留；缺失 post_id 的条目仍返回并标 missing", () => {
    const d = decodedData(
      list('{"result":[{"post_id":7680127373081070848,"video":{"url":"v"},"images":[]},{"video":{"url":"v"},"images":[]}]}'),
    );
    expect(d.entries[0]!.postId).toEqual({ state: "value", value: "7680127373081070848" });
    expect(d.entries[1]!.postId).toEqual({ state: "missing" });
  });

  it("action 不一致 / 任务未成功 沿用 profile 的分类", () => {
    expect(decodeVideoList("douyin", envelope("media_user_info", '{"result":[]}')).outcome).toBe("invalid_response");
    expect(
      decodeVideoList("douyin", bytesOf('{"code":0,"data":{"action":"user_video_list","status":"running"}}')).outcome,
    ).toBe("not_succeeded");
  });
});

describe("合成场景：单条目字段容错", () => {
  const one = (entryJson: string, platform: "douyin" | "xiaohongshu" = "douyin") =>
    decodedData(decodeVideoList(platform, envelope("user_video_list", `{"result":[${entryJson}]}`))).entries[0]!;

  it("指标：缺失 / null / 非法 / 真实 0 各自保留", () => {
    const e = one(
      '{"post_id":"p","stats":{"like_count":0,"comment_count":null,"collect_count":"x"},"video":{"url":"v"},"images":[]}',
    );
    expect(e.metrics.like).toEqual({ state: "value", value: 0n });
    expect(e.metrics.comment).toEqual({ state: "explicit_null" });
    expect(e.metrics.collect.state).toBe("invalid");
    expect(e.metrics.share).toEqual({ state: "missing" });
    expect(e.metrics.play).toEqual({ state: "unsupported" });
  });

  it("没有 stats 对象：所有指标 missing，播放数仍 unsupported", () => {
    const e = one('{"post_id":"p","video":{"url":"v"},"images":[]}');
    expect(e.metrics.like).toEqual({ state: "missing" });
    expect(e.metrics.play).toEqual({ state: "unsupported" });
  });

  it("缺 title 不影响其他字段", () => {
    const e = one('{"post_id":"p","author_name":"a","video":{"url":"v"},"images":[]}');
    expect(e.title).toEqual({ state: "missing" });
    expect(e.authorName).toEqual({ state: "value", value: "a" });
  });

  it("content_kind 推断表（缺失或矛盾 → unknown；不输出 mixed）", () => {
    const kind = (frag: string) => one(`{"post_id":"p"${frag}}`).contentKind;
    expect(kind(',"video":{"url":"https://v"},"images":[]')).toBe("video");
    expect(kind(',"video":{"url":""},"images":["https://i"]')).toBe("image");
    expect(kind(',"video":{"url":"https://v"},"images":["https://i"]')).toBe("video"); // 视频+图片 → video，不是 mixed
    expect(kind(',"title":"t","video":{"url":""},"images":[]')).toBe("text");
    expect(kind(',"video":{"url":""},"images":[]')).toBe("unknown"); // 无任何素材也无文本
    expect(kind(',"title":"t"')).toBe("unknown"); // video/images 信号缺失，不能断言「只有文本」
    expect(kind(',"title":"t","video":"x","images":[]')).toBe("unknown"); // video 类型矛盾
    expect(kind(',"title":"t","video":{"url":""},"images":"x"')).toBe("unknown"); // images 类型矛盾
  });

  it("封面：单字符串、数组不足两条、空串、混入非字符串", () => {
    const cover = (frag: string, platform: "douyin" | "xiaohongshu" = "douyin") =>
      one(`{"post_id":"p","video":{"url":"v"},"images":[]${frag}}`, platform).cover;
    expect(cover(',"cover":"https://c"', "xiaohongshu")).toEqual({
      candidates: ["https://c"],
      selected: "https://c",
      selectedJsonPath: "$.data.result.result[0].cover",
      selection: "single_string",
    });
    expect(cover(',"cover":["https://a"]')).toEqual({
      candidates: ["https://a"],
      selected: null,
      selectedJsonPath: null,
      selection: "unavailable",
    });
    expect(cover(',"cover":["https://a",1,"https://b"]')).toEqual({
      candidates: ["https://a", "https://b"],
      selected: "https://b",
      selectedJsonPath: "$.data.result.result[0].cover[2]", // 原始数组下标（中间混入了一个非字符串）
      selection: "second_of_array",
    });
    const none = { candidates: [], selected: null, selectedJsonPath: null, selection: "unavailable" };
    expect(cover(',"cover":""')).toEqual(none);
    expect(cover("")).toEqual(none);
  });

  it("条目本身不是对象：该条保留为全 invalid 的占位，其余条目照常解出", () => {
    const d = decodedData(
      decodeVideoList(
        "douyin",
        envelope("user_video_list", '{"result":[1,{"post_id":"p","video":{"url":"v"},"images":[]}]}'),
      ),
    );
    expect(d.entries).toHaveLength(2);
    expect(d.entries[0]!.postId.state).toBe("invalid");
    expect(d.entries[0]!.contentKind).toBe("unknown");
    expect(d.entries[1]!.postId).toEqual({ state: "value", value: "p" });
  });
});

describe("列表条目的其余结构化字段（长期快照需要，ODS 一年后消失）", () => {
  const dy = decodedData(decodeVideoList("douyin", loadFixtureBytes("raw3.douyin.user_video_list")));
  const xhs = decodedData(decodeVideoList("xiaohongshu", loadFixtureBytes("raw3.xiaohongshu.user_video_list")));
  it("抖音：发布地、话题文本、分享页地址、时长（秒，小数原文）、搜索词数组", () => {
    const e = dy.entries[0]!;
    expect(e.publishLocation).toEqual({ state: "value", value: "山东省青岛市" });
    expect(e.tagText).toEqual({ state: "value", value: "#日立中央空调 #全效Ⅱ三管制 #全屋全感3" });
    expect(e.shareUrl.state === "value" && e.shareUrl.value.startsWith("https://www.iesdouyin.com/share/video/7680127373081070848/")).toBe(true);
    expect(e.durationSeconds).toEqual({ state: "value", value: "62.602" });
    expect(e.relatedSearchTerms).toEqual({ state: "value", value: [] });
  });
  it("小红书：没有发布地 / 分享页 / 搜索词字段 → missing；空话题文本是有效的空串", () => {
    const e = xhs.entries[0]!;
    expect(e.publishLocation).toEqual({ state: "missing" });
    expect(e.shareUrl).toEqual({ state: "missing" });
    expect(e.relatedSearchTerms).toEqual({ state: "missing" });
    expect(e.tagText).toEqual({ state: "value", value: "" });
  });
  it("时长：只在有视频素材时读取；没有视频的条目 video.duration 是 0 占位，不当作真实时长", () => {
    const withVideo = xhs.entries.filter((e) => e.contentKind === "video");
    const without = xhs.entries.filter((e) => e.contentKind !== "video");
    expect(withVideo.length).toBeGreaterThan(0);
    expect(withVideo.every((e) => e.durationSeconds.state === "value" && Number(e.durationSeconds.value) > 0)).toBe(true);
    expect(without.every((e) => e.durationSeconds.state === "missing")).toBe(true);
  });
  it("时长非法（负数、指数、字符串）→ invalid；不会变成 0", () => {
    for (const lit of ["-1", "1e2", '"62.6"']) {
      const body = envelope(
        "user_video_list",
        `{"result":[{"post_id":"1","user_id":"a","video":{"url":"https://v/x.mp4","duration":${lit}},"images":[]}],"has_more":false,"max_cursor":0}`,
      );
      const e = decodedData(decodeVideoList("douyin", body)).entries[0]!;
      expect(e.durationSeconds.state).toBe("invalid");
    }
  });
});
