// 视频下载的纯逻辑：流式落盘 + 边写边算 SHA-256、超限中止、声明长度校验、逐跳重定向、魔数嗅探、临时文件清理。无网络。
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, utimesSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeVideoTransport, mp4Header } from "../../../tests/harness/fake-media";
import { MediaFailure } from "../media-failure";
import { DEFAULT_VIDEO_POLICY, cleanStaleTmp, downloadVideoToFile, sniffVideo } from "./video";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "video-unit-"));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const URL1 = "https://v5.zjcdn.com/a.mp4";
const policy = { ...DEFAULT_VIDEO_POLICY, maxBytes: 10_000 };
const fail = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as MediaFailure).code;
  }
  return null;
};

describe("downloadVideoToFile", () => {
  it("字节完整写入临时文件，摘要与长度和文件一致", async () => {
    const tr = new FakeVideoTransport();
    tr.route(URL1, { total: 5_000, chunk: 700, tag: "x" });
    const path = join(tmp(), "t.part");
    const r = await downloadVideoToFile(tr, URL1, policy, path);
    const onDisk = readFileSync(path);
    expect(r).toEqual({ sha256: createHash("sha256").update(onDisk).digest("hex"), byteLength: 5_000, mimeType: "video/mp4" });
    expect(onDisk.byteLength).toBe(5_000);
  });
  it("超限：中止并删除临时文件（声明长度超限不读体；未声明则读到超限的那一块就停）", async () => {
    const dir = tmp();
    const path = join(dir, "t.part");
    const tr = new FakeVideoTransport();
    let produced = 0;
    tr.route(URL1, { total: 100_000, chunk: 1_000, contentLength: null, onChunk: (n) => (produced = n) });
    expect(await fail(downloadVideoToFile(tr, URL1, policy, path))).toBe("too_large");
    expect(produced).toBe(11_000);
    expect(existsSync(path)).toBe(false);
    tr.route(URL1, { total: 100_000, onChunk: (n) => (produced = n) });
    produced = 0;
    expect(await fail(downloadVideoToFile(tr, URL1, policy, path))).toBe("too_large");
    expect(produced).toBe(0);
  });
  it("声明长度与实际不符 → truncated；非视频字节 → content_type_not_allowed；都不留文件", async () => {
    const path = join(tmp(), "t.part");
    const tr = new FakeVideoTransport();
    tr.route(URL1, { total: 3_000, contentLength: 4_000 });
    expect(await fail(downloadVideoToFile(tr, URL1, policy, path))).toBe("truncated");
    expect(existsSync(path)).toBe(false);
    tr.route(URL1, { chunks: [new TextEncoder().encode("<html>expired</html>")] });
    expect(await fail(downloadVideoToFile(tr, URL1, policy, path))).toBe("content_type_not_allowed");
    expect(existsSync(path)).toBe(false);
  });
  it("状态码映射：403/404/410 = source_expired；其它非 200 = source_unavailable；传输异常 = transport_error", async () => {
    const path = join(tmp(), "t.part");
    const tr = new FakeVideoTransport();
    for (const [status, code] of [[403, "source_expired"], [404, "source_expired"], [410, "source_expired"], [500, "source_unavailable"]] as const) {
      tr.route(URL1, { status });
      expect(await fail(downloadVideoToFile(tr, URL1, policy, path))).toBe(code);
    }
    tr.route(URL1, { throws: new Error("socket hang up") });
    expect(await fail(downloadVideoToFile(tr, URL1, policy, path))).toBe("transport_error");
  });
  it("重定向逐跳校验白名单；超过跳数上限失败", async () => {
    const path = join(tmp(), "t.part");
    const tr = new FakeVideoTransport();
    tr.route(URL1, { status: 302, location: "https://evil.example/x.mp4" });
    expect(await fail(downloadVideoToFile(tr, URL1, policy, path))).toBe("url_rejected");
    tr.route(URL1, { status: 302, location: URL1 });
    expect(await fail(downloadVideoToFile(tr, URL1, policy, path))).toBe("too_many_redirects");
    tr.route(URL1, (n) => (n === 1 ? { status: 302, location: "https://v6.zjcdn.com/b.mp4" } : { total: 2_000 }));
    tr.route("https://v6.zjcdn.com/b.mp4", { total: 2_000, tag: "b" });
    expect((await downloadVideoToFile(tr, URL1, policy, path)).byteLength).toBe(2_000);
  });
  it("白名单外的主机在发请求之前就被拒绝", async () => {
    const tr = new FakeVideoTransport();
    expect(await fail(downloadVideoToFile(tr, "http://127.0.0.1/a.mp4", policy, join(tmp(), "t.part")))).toBe("url_rejected");
    expect(tr.requested).toHaveLength(0);
  });
});

describe("sniffVideo", () => {
  it("MP4 / MOV（ftyp）与 WebM 魔数；其它 null", () => {
    expect(sniffVideo(mp4Header("x"))).toBe("video/mp4");
    expect(sniffVideo(Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe("video/webm");
    expect(sniffVideo(new TextEncoder().encode("<!DOCTYPE html>"))).toBeNull();
    expect(sniffVideo(Uint8Array.from([0, 0, 0, 24]))).toBeNull(); // 不足 12 字节
  });
});

describe("cleanStaleTmp", () => {
  it("只删超过阈值的 .part 文件，不碰其它文件与新文件", async () => {
    const dir = tmp();
    const old = join(dir, "1.part");
    const fresh = join(dir, "2.part");
    const other = join(dir, "keep.txt");
    for (const f of [old, fresh, other]) writeFileSync(f, "x");
    const longAgo = new Date(Date.now() - 3 * 3600_000);
    utimesSync(old, longAgo, longAgo);
    utimesSync(other, longAgo, longAgo);
    expect(await cleanStaleTmp(dir, 3600_000, Date.now())).toBe(1);
    expect(readdirSync(dir).sort()).toEqual(["2.part", "keep.txt"]);
    expect(await cleanStaleTmp(join(dir, "missing"), 1, Date.now())).toBe(0); // 目录不存在不报错
  });
});
