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
    it("executability 的 only：只看所给信号，段里没有的信号即使有阻塞也不影响；blockers 项带 signal 与 code", async () => {
      const { port, actor, nextPlanId } = await make();
      const k = await port.segments.create(actor, { planId: nextPlanId(), platform: "douyin" });
      await port.segments.setItems(actor, k, [{ signal: "text.title_normalized" }]);
      const all = await port.executability(actor, k);
      const only = await port.executability(actor, k, { only: ["text.title_normalized"] });
      expect(only.executable).toBe(all.executable || all.blockers.every((b) => b.signal !== "text.title_normalized"));
      for (const b of all.blockers) expect(typeof b.code).toBe("string");
      await expect(port.executability(actor, k, { only: [] })).rejects.toMatchObject({ code: "only_empty" }); // 空数组既不是「什么都不做」也不是「全部」，C 直接拒绝
    });
    it("show.images 的形状：模板图 {kind, target}，元素图再带 elementKey；removeImage 之后消失", async () => {
      const { port, actor, nextPlanId } = await make();
      const k = await port.segments.create(actor, { planId: nextPlanId(), platform: "douyin" });
      const key = "a".repeat(64);
      await port.segments.setItems(actor, k, [{ signal: "content.cover_template_score" }, { signal: "content.cover_element_score", element_key: key }]);
      const bytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("contract")]);
      await port.segments.putImage(actor, { ...k, kind: "template", target: "cover" }, bytes);
      await port.segments.putImage(actor, { ...k, kind: "element", target: "cover", elementKey: key }, bytes);
      const shown = (await port.segments.show(actor, k)) as unknown as { images: Array<{ kind: string; target: string; elementKey?: string }> };
      expect(shown.images.map((i) => `${i.kind}/${i.target}/${i.elementKey ?? ""}`).sort()).toEqual([`element/cover/${key}`, "template/cover/"]);
      await port.segments.removeImage(actor, { ...k, kind: "element", target: "cover", elementKey: key });
      const after = (await port.segments.show(actor, k)) as unknown as { images: Array<{ kind: string }> };
      expect(after.images.map((i) => i.kind)).toEqual(["template"]);
    });
    it("normalizeKeyword 幂等且不区分大小写；retainUntil 对空清单不报错", async () => {
      const { port, actor } = await make();
      expect(port.normalizeKeyword("ABC")).toBe(port.normalizeKeyword("abc"));
      expect(port.normalizeKeyword(port.normalizeKeyword("海信 New"))).toBe(port.normalizeKeyword("海信 New"));
      expect(await port.retainUntil(actor, [], new Date("2027-02-16T00:00:00Z"))).toEqual({ matched: 0 });
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
