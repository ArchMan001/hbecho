// fixture manifest 与 loader 的验收：来源、checksum、evidence label、不含 secret。
// 对应 tasks 任务 1「建立 fixture 清单、来源、checksum 和 evidence label」。
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  FixtureChecksumError,
  loadFixtureBytes,
  loadManifest,
  readSource,
  sliceTopLevelValue,
  verifyChecksum,
} from "./fixtures";

const manifest = loadManifest();

describe("manifest", () => {
  it("id 唯一，evidence label 与 use 取值受限", () => {
    const ids = manifest.entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of manifest.entries) {
      expect(["fixture_observed", "smoke_verified", "provider_failed"]).toContain(e.evidenceLabel);
      expect(["decoder_input", "capability_evidence", "failure_sample"]).toContain(e.use);
    }
  });

  it("解析器输入只来自 raw3，且都登记为 fixture_observed（raw3 是解析后包络，不是供应商原始字节）", () => {
    const inputs = manifest.entries.filter((e) => e.use === "decoder_input");
    // tracer 的四份主页 / 列表输入必须仍在；a-full-sync 增加了详情与评论的 raw3 输入
    for (const id of [
      "raw3.douyin.media_user_info",
      "raw3.douyin.user_video_list",
      "raw3.xiaohongshu.media_user_info",
      "raw3.xiaohongshu.user_video_list",
    ]) {
      expect(inputs.map((e) => e.id)).toContain(id);
    }
    expect(inputs.every((e) => e.id.startsWith("raw3."))).toBe(true);
    expect(inputs.every((e) => e.evidenceLabel === "fixture_observed")).toBe(true);
    expect(manifest.note).toContain("raw-before-parse");
  });

  it("每个来源文件存在，且 SHA-256 与登记值一致", () => {
    for (const e of manifest.entries) {
      expect(() => verifyChecksum(e, readSource(e))).not.toThrow();
    }
  });

  it("a-full-sync 的证据登记：每个 tuple 至少一条；provider_failed 与失败样本不带成功承诺；缺口如实写出", () => {
    const has = (platform: string, action: string, mode: string) =>
      manifest.entries.some((e) => e.platform === platform && e.action === action && e.mode === mode);
    for (const p of ["douyin", "xiaohongshu"]) {
      for (const a of ["media_stats_number", "post_comments_list"]) expect(has(p, a, "sync"), `${p}/${a}/sync`).toBe(true);
    }
    for (const a of ["media_user_info", "user_video_list", "media_stats_number"]) expect(has("kuaishou", a, "sync"), `kuaishou/${a}/sync`).toBe(true);
    for (const a of ["media_user_info", "media_stats_number", "user_video_list"]) expect(has("kuaishou", a, "async"), `kuaishou/${a}/async`).toBe(true);
    expect(has("xiaohongshu", "post_comments_list", "async") && has("douyin", "media_stats_number", "async") && has("xiaohongshu", "media_stats_number", "async")).toBe(true);
    // 快手评论只有失败样本，不能出现成功证据
    expect(manifest.entries.filter((e) => e.platform === "kuaishou" && e.action === "post_comments_list").every((e) => e.use === "failure_sample")).toBe(true);
    // 快手列表异步：稳定失败
    expect(manifest.entries.filter((e) => e.platform === "kuaishou" && e.action === "user_video_list" && e.mode === "async").every((e) => e.evidenceLabel === "provider_failed" && e.observed.taskStatus !== "succeeded")).toBe(true);
    // 新增条目（raw3 之外的 a-full-sync 证据）必须写 knownGaps；快手的缺口必须点名内容 URL
    const added = manifest.entries.filter((e) => e.knownGaps !== undefined);
    expect(added.length).toBeGreaterThan(40);
    expect(added.every((e) => e.knownGaps!.length > 0)).toBe(true);
    const ks = manifest.entries.filter((e) => e.platform === "kuaishou" && e.use === "capability_evidence" && e.evidenceLabel === "smoke_verified");
    expect(ks.length).toBeGreaterThan(0);
    expect(ks.every((e) => e.knownGaps!.some((g) => g.includes("内容 URL")))).toBe(true);
  });

  it("来源字节被改动时 loader 拒绝", () => {
    const e = manifest.entries[0]!;
    const tampered = Buffer.from(readSource(e));
    tampered[10] = tampered[10]! ^ 0xff;
    expect(() => verifyChecksum(e, tampered)).toThrow(FixtureChecksumError);
  });

  it("登记的 observed（http 状态、task 状态、action、错误码）与文件实际内容一致", () => {
    for (const e of manifest.entries) {
      const env = JSON.parse(readSource(e).toString("utf8")) as Record<string, any>;
      const body = env[e.envelope.responseKey];
      const http = env.http_status ?? env.http;
      expect({
        httpStatus: http,
        taskStatus: body?.data?.status ?? null,
        action: body?.data?.action ?? null,
        errorCode: body?.data?.error?.code ?? (typeof body?.code === "string" ? body.code : null),
      }).toEqual(e.observed);
    }
  });
});

describe("媒资样本（mediaSamples）", () => {
  it("每个样本文件存在，SHA-256 与长度和登记值一致", () => {
    const samples = (loadManifest() as unknown as { mediaSamples: Array<{ id: string; source: string; sourceSha256: string; byteLength: number }> }).mediaSamples;
    expect(samples.length).toBeGreaterThan(0);
    for (const s of samples) {
      const bytes = readFileSync(new URL(`../../${s.source}`, import.meta.url));
      expect(createHash("sha256").update(bytes).digest("hex"), s.id).toBe(s.sourceSha256);
      expect(bytes.byteLength, s.id).toBe(s.byteLength);
    }
  });
});

describe("loader", () => {
  it("fixture 字节是来源文件里 response_body 的原文片段，不经 parse→stringify", () => {
    for (const e of manifest.entries.filter((x) => x.use === "decoder_input")) {
      const source = readSource(e).toString("utf8");
      const slice = Buffer.from(loadFixtureBytes(e.id)).toString("utf8");
      expect(source.includes(slice)).toBe(true);
      expect(slice.startsWith("{")).toBe(true);
      expect(JSON.parse(slice).code).toBe(0);
    }
  });

  it("sliceTopLevelValue 只认顶层 key，不被嵌套同名 key 或字符串内容干扰", () => {
    const text = '{"a":{"response_body":1},"s":"x\\"response_body\\":9","response_body":{"k":"}"}}';
    expect(sliceTopLevelValue(text, "response_body")).toBe('{"k":"}"}');
    expect(() => sliceTopLevelValue(text, "nope")).toThrow();
  });
});

describe("fixture 不含 secret", () => {
  it("来源请求头只有 Content-Type，文件中没有认证头或云凭证特征", () => {
    for (const e of manifest.entries) {
      const text = readFileSync(new URL(`../../${e.source}`, import.meta.url), "utf8");
      const env = JSON.parse(text) as Record<string, any>;
      const headers = Object.keys(env.request?.headers ?? {});
      expect(headers.every((h) => h.toLowerCase() === "content-type")).toBe(true);
      expect(text).not.toMatch(/x-api-key|authorization|bearer\s|LTAI[A-Za-z0-9]{8,}|AccessKeySecret/i);
    }
  });
});
