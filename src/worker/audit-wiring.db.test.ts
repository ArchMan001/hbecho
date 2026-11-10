// 审计装配替换（任务 11；AX-10）：用真实的 tracer 命令模块，把 AuditSink 换成「日志 + 持久」组合，业务模块代码不变，事件能落库并可查。
import { describe, expect, it, vi } from "vitest";
import { serviceActor } from "../../tests/harness/actors";
import { useTestDb } from "../../tests/harness/db";
import { FakeClock } from "../../tests/harness/fake-clock";
import { seedOrg, seedSyncSettings } from "../../tests/harness/seed";
import { createAuditWriter, fromTracerAudit, listAudit } from "../modules/access-control";
import { createLogAuditSink, createTracerCommands } from "../modules/tracer-command";

const t = useTestDb();

describe("tracer：createLogAuditSink → 日志 + 持久", () => {
  it("命令执行后：原日志 sink 仍被调用，audit_events 里有规范主体的事件，可按 actor / 对象查询", async () => {
    const clock = new FakeClock(new Date("2026-11-04T08:00:00.000Z"));
    const org = await seedOrg(t.db, clock.now());
    await seedSyncSettings(t.db, clock.now());
    const logged: unknown[] = [];
    const logger = { info: (o: unknown) => void logged.push(o) };
    const sink = fromTracerAudit(createAuditWriter({ db: t.db, clock }), createLogAuditSink(logger as never));
    const commands = createTracerCommands({ db: t.db, clock, audit: sink });
    const actor = serviceActor();
    const r = await commands.submit(
      { platform: "douyin", mediaStaffId: org.staffA.toString(), homeLocator: "9- 长按复制 https://v.douyin.com/MPOAlEqWpec/ 1@3.com :1pm", idempotencyKey: "k-1" },
      actor,
    );
    expect(r).toBeTruthy();
    expect(logged.length).toBeGreaterThan(0); // 日志仍在
    await vi.waitFor(async () => expect((await listAudit(t.db, { eventType: "tracer.command.submit" })).length).toBeGreaterThan(0));
    const [ev] = await listAudit(t.db, { eventType: "tracer.command.submit" });
    expect(ev!.actor).toMatch(/^(user|service):/);
    expect(ev!.reasonCode).toMatch(/^tracer\.command\.submit\./);
    expect(JSON.stringify(ev!.detail)).not.toContain("v.douyin.com"); // locator 原文不入审计，只有摘要
    expect((await listAudit(t.db, { actor: ev!.actor })).length).toBeGreaterThan(0);
  });
});
