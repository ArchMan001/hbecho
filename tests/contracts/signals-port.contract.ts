// SignalsPort 的契约测试（design §10.3）：FakeSignals 与 C 的真实实现共用这一份，防止两边悄悄分叉。
// 这里只写两边**都必须满足**的行为；真实实现需要的装配（数据库、对象存储 fake）由调用方的 make() 提供。
import { describe, expect, it } from "vitest";
import type { SignalActor, SignalsPort } from "../../src/modules/judgement/ports";

export interface SignalsPortHarness {
  port: SignalsPort;
  actor: SignalActor;
  /** 每个用例用不同的计划 ID，避免串扰。 */
  nextPlanId(): bigint;
  /** 让某信号对所给主体读作某个值（fake 直接编程；真实实现写入结果行 / 特征行）；返回 false 表示这个实现无法编程，跳过相关用例。 */
  program?(signal: string, id: bigint, value: { state: "valid"; score: number }): Promise<boolean>;
}
export function signalsPortContract(name: string, make: () => Promise<SignalsPortHarness>): void {
  describe(`SignalsPort 契约：${name}`, () => {
    it("监控段生命周期：create → 重复 create 抛 segment_exists；发布后 setItems 抛 segment_immutable；newDraft 版本 +1 且可指定来源版本", async () => {
      const { port, actor, nextPlanId } = await make();
      const planId = nextPlanId();
      const k = await port.segments.create(actor, { planId, platform: "douyin" });
      expect(k).toEqual({ planId, version: 1 });
      await expect(port.segments.create(actor, { planId, platform: "douyin" })).rejects.toMatchObject({ code: "segment_exists" });
      await port.segments.setItems(actor, k, [{ signal: "text.title_normalized" }]);
      await port.segments.publish(actor, k);
      await expect(port.segments.setItems(actor, k, [])).rejects.toMatchObject({ code: "segment_immutable" });
      const d = await port.segments.newDraft(actor, { planId, fromVersion: 1 });
      expect(d).toEqual({ planId, version: 2 });
      const d3 = await port.segments.newDraft(actor, { planId, fromVersion: 1 }); // 来源可以是任意已有版本，不限最新
      expect(d3.version).toBe(3);
    });
    it("show 返回 status / items / images；executability 带 blockers 数组", async () => {
      const { port, actor, nextPlanId } = await make();
      const planId = nextPlanId();
      const k = await port.segments.create(actor, { planId, platform: "douyin" });
      const shown = await port.segments.show(actor, k);
      expect(shown).toMatchObject({ status: "draft", planId, version: 1 });
      expect(Array.isArray(shown.items)).toBe(true);
      expect(Array.isArray(shown.images)).toBe(true);
      const ex = await port.executability(actor, k);
      expect(typeof ex.executable).toBe("boolean");
      expect(Array.isArray(ex.blockers)).toBe(true);
    });
    it("readMany 的键是主体 ID（bigint）；未算出的主体读作 missing，不抛", async () => {
      const { port, actor, nextPlanId } = await make();
      const planId = nextPlanId();
      await port.segments.create(actor, { planId, platform: "douyin" });
      const m = await port.readMany(actor, [], "text.title_normalized");
      expect(m).toBeInstanceOf(Map);
      expect(m.size).toBe(0);
    });
    it("platformSignals 给出该平台可得的信号集合：文本信号三平台都有，评论只有抖音与小红书", async () => {
      const { port } = await make();
      expect(port.platformSignals("douyin").has("text.hashtags")).toBe(true);
      expect(port.platformSignals("kuaishou").has("comment.text_normalized")).toBe(false);
      expect(port.platformSignals("douyin").has("account.avatar_template_score")).toBe(true);
      expect(port.platformSignals("xiaohongshu").has("account.avatar_template_score")).toBe(false);
    });
  });
}
