import { describe, expect, it } from "vitest";
import { materialOf, type RefState } from "./facts";

const SHA = Buffer.alloc(32, 7);
const ref = (over: Partial<RefState>): RefState => ({ archiveStatus: "archived", mediaAssetId: 5n, assetSha256: SHA, assetVerification: "verified", ...over });

describe("materialOf：素材状态映射（requirements §1.4 第 7 项，SG-2 的输入侧）", () => {
  it("archived 且资产已验证 → ready，带资产 ID 与字节指纹", () => {
    expect(materialOf(ref({}))).toEqual({ state: "ready", assetId: 5n, sha256: SHA });
  });
  it("pending → missing(media_pending)", () => {
    expect(materialOf(ref({ archiveStatus: "pending", mediaAssetId: null, assetSha256: null, assetVerification: null }))).toEqual({ state: "missing", reason: "media_pending" });
  });
  it("failed → missing(media_failed)", () => {
    expect(materialOf(ref({ archiveStatus: "failed", mediaAssetId: null, assetSha256: null, assetVerification: null }))).toEqual({ state: "missing", reason: "media_failed" });
  });
  it("carried_forward → missing(media_carried_forward)，即使带着旧资产也不能当当前图", () => {
    expect(materialOf(ref({ archiveStatus: "carried_forward" }))).toEqual({ state: "missing", reason: "media_carried_forward" });
  });
  it("archived 但资产被隔离（quarantined）→ 不当作 ready", () => {
    expect(materialOf(ref({ assetVerification: "quarantined" }))).toEqual({ state: "missing", reason: "media_failed" });
  });
  it("未知的归档状态按失败处理，不当作 ready", () => {
    expect(materialOf(ref({ archiveStatus: "weird" }))).toEqual({ state: "missing", reason: "media_failed" });
  });
});
