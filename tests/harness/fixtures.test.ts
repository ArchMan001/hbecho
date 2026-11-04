// fixture manifest 与 loader 的验收：来源、checksum、evidence label、不含 secret。
// 对应 tasks 任务 1「建立 fixture 清单、来源、checksum 和 evidence label」。
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
      expect(["decoder_input", "capability_evidence"]).toContain(e.use);
    }
  });

  it("raw3 四份解析器输入都登记为 fixture_observed（raw3 是解析后包络，不是供应商原始字节）", () => {
    const inputs = manifest.entries.filter((e) => e.use === "decoder_input");
    expect(inputs.map((e) => e.id).sort()).toEqual([
      "raw3.douyin.media_user_info",
      "raw3.douyin.user_video_list",
      "raw3.xiaohongshu.media_user_info",
      "raw3.xiaohongshu.user_video_list",
    ]);
    expect(inputs.every((e) => e.evidenceLabel === "fixture_observed")).toBe(true);
    expect(manifest.note).toContain("raw-before-parse");
  });

  it("每个来源文件存在，且 SHA-256 与登记值一致", () => {
    for (const e of manifest.entries) {
      expect(() => verifyChecksum(e, readSource(e))).not.toThrow();
    }
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
        errorCode: body?.data?.error?.code ?? null,
      }).toEqual(e.observed);
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
