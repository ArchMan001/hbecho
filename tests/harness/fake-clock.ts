import type { Clock } from "../../src/modules/raw-capture/ports";

export class FakeClock implements Clock {
  private ms: number;

  constructor(start: Date) {
    this.ms = start.getTime();
  }

  now(): Date {
    return new Date(this.ms);
  }

  advance(ms: number): void {
    this.ms += ms;
  }

  set(at: Date): void {
    this.ms = at.getTime();
  }
}
