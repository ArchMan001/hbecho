// PLATFORM_TEXT_FIELDS 的依据：逐平台解码 tests/fixtures/aimaster 里的列表响应，数每个字段是否出现（design §14 第 6 项）。
import { describe, expect, it } from "vitest";
import { decodedData } from "../../../../tests/harness/decode-helpers";
import { loadFixtureBytes, loadManifest } from "../../../../tests/harness/fixtures";
import { decodeVideoList } from "../../provider-adapter/decode-video-list";
import { PLATFORM_TEXT_FIELDS } from "./fields";

type Seen = { entries: number; title: number; body: number };
function observe(): Record<string, Seen> {
  const out: Record<string, Seen> = {};
  for (const e of loadManifest().entries) {
    if (e.action !== "user_video_list" || e.role !== "response") continue;
    const outcome = decodeVideoList(e.platform, loadFixtureBytes(e.id));
    if (outcome.outcome !== "decoded") continue; // 失败样本（schema_drift 等）没有条目
    const seen = (out[e.platform] ??= { entries: 0, title: 0, body: 0 });
    for (const en of decodedData(outcome).entries) {
      seen.entries++;
      if (en.title.state === "value") seen.title++;
      if (en.text.state === "value") seen.body++;
    }
  }
  return out;
}

describe("PLATFORM_TEXT_FIELDS 与 fixture 一致", () => {
  const seen = observe();
  it("三个平台都有足够的样本", () => {
    for (const p of ["douyin", "xiaohongshu", "kuaishou"]) expect(seen[p]?.entries, p).toBeGreaterThanOrEqual(40);
  });
  it("标题：三个平台的列表都返回", () => {
    for (const p of Object.keys(PLATFORM_TEXT_FIELDS)) {
      expect(seen[p]!.title, p).toBeGreaterThan(0);
      expect(PLATFORM_TEXT_FIELDS[p]!.title).toBe(true);
    }
  });
  it("正文：抖音、小红书返回（抖音很少），快手从不返回", () => {
    expect(seen.douyin!.body).toBeGreaterThan(0);
    expect(seen.xiaohongshu!.body).toBeGreaterThan(0);
    expect(seen.kuaishou!.body).toBe(0);
    expect(Object.fromEntries(Object.entries(PLATFORM_TEXT_FIELDS).map(([p, f]) => [p, f.body]))).toEqual({ douyin: true, xiaohongshu: true, kuaishou: false });
  });
});
