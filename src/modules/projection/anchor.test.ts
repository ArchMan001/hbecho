// 初始锚点（R10.7；v2 §9.4 第 10 条）：time / id_window / empty，确定性。
import { describe, expect, it } from "vitest";
import { computeInitialAnchor, type AnchorEntry } from "./anchor";

const e = (id: string, ms: bigint | null): AnchorEntry => ({
  platformContentId: id,
  publishedAtMs: ms === null ? { state: "missing" } : { state: "value", value: ms },
});

describe("computeInitialAnchor", () => {
  it("存在有效发布时间 → time：最大时间 + 同一时刻的内容 ID 集合（含置顶以外的全部返回内容）", () => {
    expect(computeInitialAnchor([e("a", 1000n), e("b", 3000n), e("c", 3000n), e("d", 2000n)])).toEqual({
      mode: "time",
      highWatermarkPublishedAt: new Date(3000),
      highWatermarkContentIds: ["b", "c"],
    });
  });
  it("没有有效发布时间但有内容 ID → id_window：第一页全部内容 ID，保持返回顺序", () => {
    expect(computeInitialAnchor([e("z", null), e("y", null)])).toEqual({ mode: "id_window", highWatermarkPublishedAt: null, highWatermarkContentIds: ["z", "y"] });
  });
  it("0 条 → empty：时间与 ID 集合都为空", () => {
    expect(computeInitialAnchor([])).toEqual({ mode: "empty", highWatermarkPublishedAt: null, highWatermarkContentIds: [] });
  });
  it("无效发布时间（0、负数、超出 DATETIME 上限、非 value 状态）不参与取最大值", () => {
    const bad: AnchorEntry[] = [
      e("zero", 0n),
      e("neg", -5n),
      e("huge", 253402300800000n), // 10000-01-01，超出 MySQL DATETIME 范围
      { platformContentId: "inv", publishedAtMs: { state: "invalid", raw: '"x"' } },
    ];
    expect(computeInitialAnchor([...bad, e("ok", 5000n)])).toMatchObject({ mode: "time", highWatermarkContentIds: ["ok"] });
    expect(computeInitialAnchor(bad)).toMatchObject({ mode: "id_window" });
  });
  it("真实 0 毫秒不是有效发布时间（1970 年）", () => {
    expect(computeInitialAnchor([e("a", 0n)])).toMatchObject({ mode: "id_window" });
  });
  it("内容 ID 原文保留，不转数字（19 位抖音 ID）", () => {
    expect(computeInitialAnchor([e("7680127373081070848", 1n)]).highWatermarkContentIds).toEqual(["7680127373081070848"]);
  });
});
