// 媒资归档的纯逻辑：URL 守卫、格式嗅探、有界下载（fake transport，全程不碰网络）。
import { describe, expect, it } from "vitest";
import { FakeMediaTransport, jpegBytes, webpBytes, heicBytes } from "../../../tests/harness/fake-media";
import { MediaFailure, classifyMediaFailure } from "../media-failure";
import { DEFAULT_MEDIA_POLICY, checkMediaUrl, downloadBounded, sniffImage } from "./index";

const P = DEFAULT_MEDIA_POLICY;
const reject = (url: string) => {
  try {
    checkMediaUrl(url, P);
  } catch (e) {
    return (e as MediaFailure).code;
  }
  return null;
};

describe("checkMediaUrl（scheme / host / 端口 / 凭据）", () => {
  it("fixture 里出现的 CDN 域名通过（含子域）", () => {
    for (const u of [
      "https://p3-pc.douyinpic.com/aweme/1080x1080/a.jpeg?from=1",
      "https://p3-sign.douyinpic.com/tos/x.heic?x-signature=a%2Bb",
      "https://sns-i11.rednotecdn.com/x.webp",
      "http://sns-v28.rednotecdn.com/stream/a.jpg",
    ]) {
      expect(reject(u)).toBeNull();
    }
  });
  it("非 http(s)、不在白名单、IP 字面量、localhost、内网名、凭据、非默认端口都被拒绝", () => {
    for (const u of [
      "file:///etc/passwd",
      "ftp://p3.douyinpic.com/a",
      "https://evil.test/a.jpg",
      "https://douyinpic.com.evil.test/a.jpg",
      "https://notdouyinpic.com/a.jpg",
      "http://127.0.0.1/a.jpg",
      "http://[::1]/a.jpg",
      "http://169.254.169.254/latest/meta-data",
      "http://localhost/a.jpg",
      "http://10.0.0.1/a.jpg",
      "https://user:pw@p3.douyinpic.com/a.jpg",
      "https://p3.douyinpic.com:8443/a.jpg",
      "not a url",
    ]) {
      expect(reject(u), u).toBe("url_rejected");
    }
  });
});

describe("sniffImage（按字节判断类型，不信 Content-Type / 扩展名）", () => {
  it("JPEG / PNG / GIF / WebP / HEIC 被识别；其余为 null", () => {
    expect(sniffImage(jpegBytes("a"))).toBe("image/jpeg");
    expect(sniffImage(webpBytes("a"))).toBe("image/webp");
    expect(sniffImage(heicBytes("a"))).toBe("image/heic");
    expect(sniffImage(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe("image/png");
    expect(sniffImage(new TextEncoder().encode("GIF89a....."))).toBe("image/gif");
    expect(sniffImage(new TextEncoder().encode("<html>403 Forbidden</html>"))).toBeNull();
    expect(sniffImage(new Uint8Array())).toBeNull();
  });
});

describe("downloadBounded", () => {
  const URL1 = "https://p3.douyinpic.com/a.jpg";
  it("成功：返回完整字节、嗅探类型", async () => {
    const tr = new FakeMediaTransport();
    tr.route(URL1, { status: 200, contentType: "image/jpeg", body: jpegBytes("x") });
    const r = await downloadBounded(tr, URL1, P);
    expect(r.mimeType).toBe("image/jpeg");
    expect(r.bytes).toEqual(jpegBytes("x"));
  });
  it("403 / 404 / 410：source_expired（需要新地址，不是重试同一 URL）；5xx / 429：source_unavailable", async () => {
    const tr = new FakeMediaTransport();
    for (const [status, code] of [[403, "source_expired"], [404, "source_expired"], [410, "source_expired"], [500, "source_unavailable"], [429, "source_unavailable"]] as const) {
      tr.route(URL1, { status, contentType: "text/html", body: new TextEncoder().encode("x") });
      await expect(downloadBounded(tr, URL1, P)).rejects.toMatchObject({ code });
    }
  });
  it("Content-Length 与实际字节数不一致：truncated（可重试）", async () => {
    const tr = new FakeMediaTransport();
    tr.route(URL1, { status: 200, contentType: "image/jpeg", contentLength: 99999, body: jpegBytes("x") });
    await expect(downloadBounded(tr, URL1, P)).rejects.toMatchObject({ code: "truncated" });
  });
  it("超过大小上限：too_large（终态）；声明的 Content-Length 超限同样拒绝", async () => {
    const tr = new FakeMediaTransport();
    const body = jpegBytes("x".repeat(100));
    tr.route(URL1, { status: 200, contentType: "image/jpeg", body });
    await expect(downloadBounded(tr, URL1, { ...P, maxBytes: 50 })).rejects.toMatchObject({ code: "too_large" });
    tr.route(URL1, { status: 200, contentType: "image/jpeg", contentLength: 10_000_000, body: jpegBytes("y") });
    await expect(downloadBounded(tr, URL1, { ...P, maxBytes: 50 })).rejects.toMatchObject({ code: "too_large" });
  });
  it("不是图片（HTML 错误页，即使状态码 200）：content_type_not_allowed；声明 image/* 但字节不是图片也拒绝", async () => {
    const tr = new FakeMediaTransport();
    tr.route(URL1, { status: 200, contentType: "text/html", body: new TextEncoder().encode("<html>") });
    await expect(downloadBounded(tr, URL1, P)).rejects.toMatchObject({ code: "content_type_not_allowed" });
    tr.route(URL1, { status: 200, contentType: "image/jpeg", body: new TextEncoder().encode("<html>") });
    await expect(downloadBounded(tr, URL1, P)).rejects.toMatchObject({ code: "content_type_not_allowed" });
  });
  it("重定向：逐跳校验白名单；最多 3 跳；跳到不允许的主机被拒绝，且不会请求它", async () => {
    const tr = new FakeMediaTransport();
    tr.route(URL1, { status: 302, location: "https://p9.douyinpic.com/b.jpg", contentType: null, body: new Uint8Array() });
    tr.route("https://p9.douyinpic.com/b.jpg", { status: 200, contentType: "image/jpeg", body: jpegBytes("b") });
    expect((await downloadBounded(tr, URL1, P)).bytes).toEqual(jpegBytes("b"));

    const bad = new FakeMediaTransport();
    bad.route(URL1, { status: 302, location: "http://169.254.169.254/latest", contentType: null, body: new Uint8Array() });
    await expect(downloadBounded(bad, URL1, P)).rejects.toMatchObject({ code: "url_rejected" });
    expect(bad.requested).toEqual([URL1]);

    const loop = new FakeMediaTransport();
    loop.route(URL1, { status: 302, location: URL1, contentType: null, body: new Uint8Array() });
    await expect(downloadBounded(loop, URL1, P)).rejects.toMatchObject({ code: "too_many_redirects" });
    expect(loop.requested).toHaveLength(4); // 初始 + 3 跳
  });
  it("初始 URL 不合规时根本不发请求", async () => {
    const tr = new FakeMediaTransport();
    await expect(downloadBounded(tr, "http://127.0.0.1/a", P)).rejects.toMatchObject({ code: "url_rejected" });
    expect(tr.requested).toHaveLength(0);
  });
  it("传输层超时 / 连接失败映射为 timeout / transport_error", async () => {
    const tr = new FakeMediaTransport();
    tr.route(URL1, () => {
      throw new MediaFailure("timeout");
    });
    await expect(downloadBounded(tr, URL1, P)).rejects.toMatchObject({ code: "timeout" });
    tr.route(URL1, () => {
      throw new Error("ECONNRESET");
    });
    await expect(downloadBounded(tr, URL1, P)).rejects.toMatchObject({ code: "transport_error" });
  });
});

describe("失败分类", () => {
  it("重试 / 需要新地址 / 终态；未知码不被当作可重试", () => {
    expect(classifyMediaFailure("timeout")).toBe("retryable");
    expect(classifyMediaFailure("source_expired")).toBe("needs_fresh_url");
    expect(classifyMediaFailure("too_large")).toBe("terminal");
    expect(classifyMediaFailure("never_heard_of_it")).toBe("unknown");
    expect(classifyMediaFailure(null)).toBe("unknown");
  });
});
