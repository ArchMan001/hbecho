// 测试用假提出方（规则域）：固定圈定若干内容，按给定的 wants 提交按需采集需求。A 只执行不决定——
// 这里的「圈定」是测试里写死的，A 的代码里没有任何阈值或规则语义。
import type { DemandModule, DispositionRow, SubmitResult, Want } from "../../src/modules/demand";
import type { ActorContext } from "../../src/modules/tracer-command";

export class FakeRuleSource {
  private seq = 0;
  constructor(
    private readonly demand: Pick<DemandModule, "submit">,
    private readonly actor: ActorContext,
    private readonly name = "fake-rule",
  ) {}

  /** 提交；不给 key 则每次一个新 demandKey（模拟不同的计划）。 */
  request(selected: ReadonlyArray<{ contentId: bigint | string; wants: readonly Want[] }>, o: { key?: string; ruleDecisionId?: string; ruleVersion?: string } = {}): Promise<SubmitResult> {
    return this.demand.submit(
      {
        demandKey: o.key ?? `${this.name}-${++this.seq}`,
        requester: { kind: "rule_plan", ref: this.name, version: "v1" },
        ruleDecisionId: o.ruleDecisionId ?? `decision-${this.seq}`,
        ruleVersion: o.ruleVersion ?? "rv-1",
        items: selected.map((s) => ({ contentId: s.contentId.toString(), wants: [...s.wants] })),
      },
      this.actor,
    );
  }
}
export const dispositionOf = (r: { dispositions: DispositionRow[] }, contentId: bigint | string, want: Want) => r.dispositions.find((d) => d.contentId === contentId.toString() && d.want === want)?.disposition;
