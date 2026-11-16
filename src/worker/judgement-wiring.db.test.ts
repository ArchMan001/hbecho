// D 的下游装配：C 的配置用到才读；缺项时清除失败（A 保守不清除），没有判定计划的活动计划不需要它。
import { describe, expect, it } from "vitest";
import { judgementPlans } from "../db/schema";
import { useTestDb } from "../../tests/harness/db";
import { judgementEnv, judgementWorld } from "../../tests/harness/judgement";
import { buildJudgementDownstream } from "./judgement-wiring";
const t = useTestDb();
const logger = { info: () => {} };
describe("buildJudgementDownstream", () => {
  it("没有任何 C 配置：summarize 照常；没有判定计划的清除是空操作；有判定计划的清除抛 not_configured 且行保留", async () => {
    const w = await judgementWorld(t);
    const e = judgementEnv(t, w);
    const down = buildJudgementDownstream({ db: t.db, env: {}, logger });
    expect(await down.summarize(w.planId)).toEqual({ judgementPlans: 0, results: 0, running: 0 });
    await down.purge(w.planId);
    await e.plans.create(e.creator, { activityPlanId: w.planId, alias: "计划 A" });
    expect(await down.summarize(w.planId)).toEqual({ judgementPlans: 1, results: 0, running: 0 });
    await expect(down.purge(w.planId)).rejects.toMatchObject({ code: expect.stringMatching(/not_configured|config/) });
    expect(await t.db.select().from(judgementPlans)).toHaveLength(1);
  });
});
