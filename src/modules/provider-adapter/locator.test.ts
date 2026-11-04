import { describe, expect, it } from "vitest";
import { classifyLocator } from "./locator";

const DY_SHARE = "9- 长按复制此条消息，打开抖音搜索，查看TA的更多作品。 https://v.douyin.com/MPOAlEqWpec/ 1@3.com :1pm";
const XHS_SHARE = "@日立中央空调 在小红书已经有7.8万个粉丝，点击链接或复制口令查看Ta的主页>> https://xhslink.cn/o/E2W9yK1ctR";

describe("最小清洗（R3.4）：只截掉第一个 URL 之后的字符，前缀分享文案保留", () => {
  it("抖音分享文本：截掉路径之后的垃圾，前缀保留，原值保留", () => {
    const d = classifyLocator(DY_SHARE);
    expect(d.original).toBe(DY_SHARE);
    expect(d.cleaned).toBe("9- 长按复制此条消息，打开抖音搜索，查看TA的更多作品。 https://v.douyin.com/MPOAlEqWpec/");
  });

  it("小红书分享文本：URL 已在末尾，清洗为 no-op", () => {
    const d = classifyLocator(XHS_SHARE);
    expect(d.cleaned).toBe(XHS_SHARE);
  });

  it("URL 后紧跟中文标点或空白：在此截断", () => {
    expect(classifyLocator("https://v.douyin.com/abc/，复制此链接").cleaned).toBe("https://v.douyin.com/abc/");
    expect(classifyLocator("https://v.douyin.com/abc/\n多余").cleaned).toBe("https://v.douyin.com/abc/");
  });

  it("URL 末尾的 ASCII 句读不属于路径", () => {
    expect(classifyLocator("看 https://xhslink.cn/o/E2W9yK1ctR.").cleaned).toBe("看 https://xhslink.cn/o/E2W9yK1ctR");
    expect(classifyLocator("(https://xhslink.cn/o/E2W9yK1ctR)").cleaned).toBe("(https://xhslink.cn/o/E2W9yK1ctR");
  });

  it("路径、查询、标识语义不变", () => {
    const url = "https://www.xiaohongshu.com/user/profile/5ff0e6410000000001001a61?xsec_token=AB_c-1%3D&xsec_source=pc_feed";
    const d = classifyLocator(`${url} 看看`);
    expect(d.cleaned).toBe(url);
  });

  it("没有 URL（分享口令）：cleaned 等于原文，不 trim、不改动", () => {
    const text = "  9.99 复制打开抖音 Ab:/ 口令  ";
    const d = classifyLocator(text);
    expect(d.original).toBe(text);
    expect(d.cleaned).toBe(text);
    expect(d.kind).toBe("unknown");
    expect(d.action).toBe("send");
  });

  it("原文逐码点保留，不做 Unicode 归一化", () => {
    const text = "e\u0301 https://v.douyin.com/x/ \u00e9";
    expect(classifyLocator(text).original).toBe(text);
    expect(classifyLocator(text).cleaned).toBe("e\u0301 https://v.douyin.com/x/");
  });
});

describe("入口类型（R3.1/R3.2）：只按 URL 路径特征识别明确的视频/笔记链接，不解析 HTML", () => {
  const kindOf = (t: string) => classifyLocator(t);

  it("明确的主页链接 → home，发送", () => {
    for (const u of [
      "https://www.douyin.com/user/MS4wLjABAAAAaQNZi_ulE1SgF5-WN-toezy3GtHsCmdlZjrc1wkHcLA?from_tab_name=main",
      "https://www.xiaohongshu.com/user/profile/49328995493",
    ]) {
      expect(kindOf(u)).toMatchObject({ kind: "home", action: "send" });
    }
  });

  it("短链与口令无法在本地判断 → unknown，照常发送（由 media_user_info 处理跳转）", () => {
    expect(kindOf(DY_SHARE)).toMatchObject({ kind: "unknown", action: "send" });
    expect(kindOf(XHS_SHARE)).toMatchObject({ kind: "unknown", action: "send" });
  });

  it("明确的视频链接 → video，拒绝", () => {
    for (const u of [
      "https://www.douyin.com/video/7680127373081070848",
      "https://www.iesdouyin.com/share/video/7680127373081070848/?region=CN",
    ]) {
      expect(kindOf(u)).toMatchObject({ kind: "video", action: "reject", reason: "non_home_locator" });
    }
  });

  it("明确的笔记链接 → note，拒绝", () => {
    for (const u of [
      "https://www.douyin.com/note/7680127373081070848",
      "https://www.xiaohongshu.com/explore/6a706a35000000002403c5b2?xsec_token=abc",
      "https://www.xiaohongshu.com/discovery/item/6a706a35000000002403c5b2",
    ]) {
      expect(kindOf(u)).toMatchObject({ kind: "note", action: "reject", reason: "non_home_locator" });
    }
  });

  it("带分享文案的视频链接同样被识别，并且被拒绝的入口也保留原值与清洗值", () => {
    const text = "7.43 复制打开抖音，看看 https://www.douyin.com/video/7680127373081070848 作品";
    const d = kindOf(text);
    expect(d).toMatchObject({ kind: "video", action: "reject" });
    expect(d.original).toBe(text);
    expect(d.cleaned).toBe("7.43 复制打开抖音，看看 https://www.douyin.com/video/7680127373081070848");
  });

  it("拒绝不可重试，且结果里没有任何账号/归属/快照字段（R3.2、R4.2）", () => {
    const d = kindOf("https://www.douyin.com/video/1");
    expect(d).toMatchObject({ action: "reject", retryable: false });
    expect(Object.keys(d).sort()).toEqual(["action", "cleaned", "kind", "original", "reason", "retryable"]);
  });

  it("send 决定同样不携带身份字段：账号只能来自后续已验证的 profile 解码", () => {
    for (const t of ["https://www.douyin.com/user/abc", DY_SHARE, "口令"]) {
      expect(Object.keys(kindOf(t)).sort()).toEqual(["action", "cleaned", "kind", "original"]);
    }
  });
});
