import { describe, expect, it } from "vitest";
import { decodedData } from "../../../tests/harness/decode-helpers";
import { loadFixtureBytes } from "../../../tests/harness/fixtures";
import { decodeVideoList } from "../provider-adapter";
import { DEFAULT_STRATEGIES, kuaishouStrategy } from "./strategies";

describe("快手策略", () => {
  it("已注册，且不绑定任何第二标识、不产生质量问题（昵称与主页链接不是绑定证据）", () => {
    expect(DEFAULT_STRATEGIES.kuaishou).toBe(kuaishouStrategy);
    const page = decodedData(decodeVideoList("kuaishou", loadFixtureBytes("raw12.K3")));
    const r = kuaishouStrategy.listBindings({ primary: { namespace: "kuaishou.user_id", value: "3xcqkweabmmz6pk" }, page, batchId: 1n });
    expect(r).toEqual({ bindings: [], issues: [] });
  });
});
