import { describe, expect, it } from "vitest";
import { fromSignal } from "./signal";
import type { SignalLike } from "./types";

const sig = (o: Partial<SignalLike>): SignalLike => ({ state: "valid", usable: true, ...o });

describe("fromSignal", () => {
  it("valid 与可用的 stale → 值（stale 带标记）", () => {
    expect(fromSignal(sig({ value: "x" }))).toEqual({ kind: "value", value: "x", stale: false });
    expect(fromSignal(sig({ state: "stale", value: "x", normalizerVersion: 1 }))).toEqual({ kind: "value", value: "x", stale: true, normalizerVersion: 1 });
  });
  it("missing(not_computed / failed_under_old_version) 与 queued / running 是在等；其余原因是终态", () => {
    for (const reason of ["not_computed", "failed_under_old_version"]) expect(fromSignal(sig({ state: "missing", usable: false, reason }))).toMatchObject({ kind: "unobtained", awaiting: true });
    expect(fromSignal(sig({ state: "missing", usable: false, reason: "media_pending", pending: "queued" }))).toMatchObject({ awaiting: true });
    for (const reason of ["media_pending", "media_failed", "audio_not_archived", "capability_disabled", "compute_dead", "no_profile_snapshot"])
      expect(fromSignal(sig({ state: "missing", usable: false, reason }))).toEqual({ kind: "unobtained", reason, awaiting: false });
  });
  it("failed / not_applicable → 未获取成功，原因码逐字沿用 C 的", () => {
    expect(fromSignal(sig({ state: "failed", usable: false, reason: "invalid_output" }))).toEqual({ kind: "unobtained", reason: "invalid_output", awaiting: false });
    expect(fromSignal(sig({ state: "not_applicable", usable: false, reason: "field_absent_on_platform" }))).toEqual({ kind: "unobtained", reason: "field_absent_on_platform", awaiting: false });
  });
  it("stale 但不可用（as_unknown 策略）→ 未获取成功", () => {
    expect(fromSignal(sig({ state: "stale", usable: false }))).toEqual({ kind: "unobtained", reason: "stale_not_usable", awaiting: false });
  });
});
