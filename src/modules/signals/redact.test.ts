import { describe, expect, it } from "vitest";
import { redactUrls } from "./redact";

describe("redactUrls", () => {
  it("URL 一律替换为 <url>，保留其余文字", () => {
    expect(redactUrls("读取 https://b.oss-cn-beijing.aliyuncs.com/k?Expires=1&Signature=abc%2F 失败，重试 http://x/y")).toBe("读取 <url> 失败，重试 <url>");
    expect(redactUrls("(见 https://a.test/p?q=1)")).toBe("(见 <url>)");
    expect(redactUrls("没有地址的消息")).toBe("没有地址的消息");
    expect(redactUrls("file:///etc/passwd 与 s3://bucket/key")).toBe("<url> 与 <url>");
  });
});
