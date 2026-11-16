import { describe, expect, it } from "vitest";
import type { AuditEvent, AuditWriteOptions } from "../access-control";
import { createJudgementAudit, JUDGEMENT_AUDIT_EVENTS } from "./audit";

const recorder = () => {
  const out: Array<{ e: AuditEvent; o: AuditWriteOptions }> = [];
  return { out, writer: { write: async (e: AuditEvent, o: AuditWriteOptions) => void out.push({ e, o }) } };
};
describe("judgement 审计", () => {
  it("high 事件必须传 tx（与业务写入同事务）；low 事件可不传", async () => {
    const { writer, out } = recorder();
    const a = createJudgementAudit(writer);
    await expect(a.record({ event: "execution_started", actor: "user:7" })).rejects.toThrow(/同事务/);
    await a.record({ event: "circle_run", actor: "user:7", planId: 3n });
    expect(out).toHaveLength(1);
    expect(out[0]!.o).toEqual({ risk: "low" });
    await a.record({ event: "version_published", actor: "user:7", planId: 3n, runId: 9n }, {} as never);
    expect(out[1]!.o.risk).toBe("high");
    expect(out[1]!.e).toMatchObject({ eventType: "judgement.version_published", targetType: "judgement_plan", targetId: "3", reasonCode: "judgement.version_published.succeeded", detail: { runId: "9" } });
  });
  it("每个事件的风险级别：创建 / 发布 / 开始执行 / 取消 / 回退 / 归档 / 清除是 high，试跑与圈定是 low", () => {
    for (const e of ["plan_created", "version_published", "execution_started", "run_cancelled", "rollback_applied", "plan_archived", "plan_purged"] as const) expect(JUDGEMENT_AUDIT_EVENTS[e], e).toBe("high");
    expect(JUDGEMENT_AUDIT_EVENTS.circle_run).toBe("low");
    expect(JUDGEMENT_AUDIT_EVENTS.trial_run).toBe("low");
  });
  it("reasonCode 是稳定标识符；submitter_revoked 带稳定码", async () => {
    const { writer, out } = recorder();
    await createJudgementAudit(writer).record({ event: "submitter_revoked", actor: "user:7", reasonCode: "submitter_revoked" }, {} as never);
    expect(out[0]!.e.reasonCode).toMatch(/^[a-z0-9][a-z0-9_.-]{0,63}$/);
  });
});
