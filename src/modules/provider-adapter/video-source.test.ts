import { describe, expect, it } from "vitest";
import { pickVideoSource, rankVideoSources } from "./video-source";

const dy = (host: string, p = "/v") => `https://${host}${p}`;

describe("pickVideoSource", () => {
  it("抖音：api-play.amemv.com 优先于 api.amemv.com，再到其余；同级保持原顺序", () => {
    const c = [dy("v5.zjcdn.com", "/1"), dy("api.amemv.com"), dy("v3.zjcdn.com", "/2"), dy("api-play.amemv.com")];
    expect(rankVideoSources("douyin", c)).toEqual([dy("api-play.amemv.com"), dy("api.amemv.com"), dy("v5.zjcdn.com", "/1"), dy("v3.zjcdn.com", "/2")]);
    expect(pickVideoSource("douyin", c)).toBe(dy("api-play.amemv.com"));
  });
  it("抖音：被排除的 video.url 即使主机优先级最高也不选", () => {
    const videoUrl = dy("api-play.amemv.com", "/list-video-url");
    expect(pickVideoSource("douyin", [videoUrl, dy("v5.zjcdn.com")], [videoUrl])).toBe(dy("v5.zjcdn.com"));
  });
  it("主机名比较不区分大小写，且不被子域名后缀骗过", () => {
    expect(pickVideoSource("douyin", ["https://evil-api-play.amemv.com/x", "https://API-PLAY.amemv.com/y"])).toBe("https://API-PLAY.amemv.com/y");
  });
  it("小红书 / 快手：取详情 download_urls 的第一个，不按抖音主机排序", () => {
    const c = ["http://v1.kwaicdn.com/a", dy("api-play.amemv.com")];
    expect(pickVideoSource("kuaishou", c)).toBe("http://v1.kwaicdn.com/a");
    expect(pickVideoSource("xiaohongshu", c)).toBe("http://v1.kwaicdn.com/a");
  });
  it("非 http(s)、无法解析的候选被丢弃；全部不可用返回 null；重复项去重", () => {
    expect(rankVideoSources("kuaishou", ["file:///etc/passwd", "ftp://x/y", "not a url", "http://a/x", "http://a/x"])).toEqual(["http://a/x"]);
    expect(pickVideoSource("douyin", [])).toBeNull();
    expect(pickVideoSource("douyin", ["javascript:alert(1)"])).toBeNull();
  });
});
