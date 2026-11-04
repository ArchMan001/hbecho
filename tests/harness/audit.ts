import type { AuditEvent, AuditSink } from "../../src/modules/tracer-command";

export class MemoryAuditSink implements AuditSink {
  readonly events: AuditEvent[] = [];
  record(event: AuditEvent): void {
    this.events.push(event);
  }
}
