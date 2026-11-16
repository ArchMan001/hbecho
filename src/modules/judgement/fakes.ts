// 离线 fake：FakeSignals（C 的内存版，可编程各信号状态、记录调用、切换可执行性）与 FakeDemand（A 的 demand 的内存版）。
// 默认测试一律用它们；真实 C 的契约测试与它们共用 tests/contracts/signals-port.contract.ts。
import { SignalError } from "../signals/errors";
import type { Blocker } from "../signals/segments";
import type { ActorContext, DemandPort, DemandView, Executability, ImageKey, RequestResult, SegmentKey, SegmentRef, SignalActor, SignalValue, SignalsPort, SubmitDemand, SubmitResult, Subject } from "./ports";

export const MISSING_NOT_COMPUTED: SignalValue = { state: "missing", usable: false, reason: "not_computed" };
const keyOf = (r: SegmentKey): string => `${r.planId}:${r.version}`;

interface FakeSegment {
  platform: string;
  status: "draft" | "published";
  items: unknown[];
  images: Map<string, { sha256: string; bytes: number }>;
}
export interface SignalsCall {
  fn: string;
  args: unknown;
}

export class FakeSignals implements SignalsPort {
  readonly calls: SignalsCall[] = [];
  readonly segs = new Map<string, FakeSegment>();
  private readonly values = new Map<string, SignalValue>();
  /** 非空 = 监控段不可执行（blockers 带 signal 的会被 only 过滤）。 */
  blockers: Blocker[] = [];
  /** 平台 → 可得信号键；缺省用 `allSignals`。 */
  platformMap = new Map<string, ReadonlySet<string>>();
  allSignals: ReadonlySet<string> = new Set();
  failNext: { fn: string; error: Error } | null = null;
  readonly retained: Array<{ ids: bigint[]; until: Date }> = [];

  constructor(allSignals?: Iterable<string>) {
    if (allSignals) this.allSignals = new Set(allSignals);
  }
  private log(fn: string, args: unknown): void {
    this.calls.push({ fn, args });
    if (this.failNext?.fn === fn) {
      const e = this.failNext.error;
      this.failNext = null;
      throw e;
    }
  }
  callsOf(fn: string): SignalsCall[] {
    return this.calls.filter((c) => c.fn === fn);
  }
  /** 为某信号、某主体编程一个值（参数化的元素图信号带 elementKey）。 */
  setValue(signal: string, id: bigint, v: SignalValue, elementKey?: string): void {
    this.values.set(`${signal}|${elementKey ?? ""}|${id}`, v);
  }
  platformSignals = (platform: string): ReadonlySet<string> => this.platformMap.get(platform) ?? this.allSignals;

  async executability(_a: SignalActor, ref: SegmentRef, o: { only?: readonly string[] } = {}): Promise<Executability> {
    this.log("executability", { ref, only: o.only });
    const bs = this.blockers.filter((b) => o.only === undefined || b.signal === undefined || o.only.includes(b.signal));
    return { executable: bs.length === 0, blockers: bs };
  }

  segments: SignalsPort["segments"] = {
    create: async (_a, input) => {
      this.log("segments.create", input);
      const k = { planId: input.planId, version: 1 };
      if (this.segs.has(keyOf(k))) throw new SignalError("conflict", "segment_exists", "该计划已有监控段；改配置请 newDraft");
      this.segs.set(keyOf(k), { platform: input.platform, status: "draft", items: [], images: new Map() });
      return k;
    },
    setItems: async (_a, k, raw) => {
      this.log("segments.setItems", { k, raw });
      const s = this.need(k);
      if (s.status !== "draft") throw new SignalError("conflict", "segment_immutable", "已发布的监控段不可修改");
      s.items = raw as unknown[];
      return raw as never;
    },
    putImage: async (_a, key: ImageKey, bytes) => {
      this.log("segments.putImage", { key, bytes: bytes.length });
      const s = this.need(key);
      if (s.status !== "draft") throw new SignalError("conflict", "segment_immutable", "已发布的监控段不可修改");
      const sha256 = Buffer.from(bytes).toString("hex").slice(0, 8);
      s.images.set(`${key.kind}/${key.target}/${key.elementKey ?? ""}`, { sha256, bytes: bytes.length });
      return { sha256, objectKey: `fake/${keyOf(key)}/${key.target}` };
    },
    removeImage: async (_a, key: ImageKey) => {
      this.log("segments.removeImage", { key });
      const s = this.need(key);
      if (s.status !== "draft") throw new SignalError("conflict", "segment_immutable", "已发布的监控段不可修改");
      s.images.delete(`${key.kind}/${key.target}/${key.elementKey ?? ""}`);
    },
    show: async (_a, k) => {
      this.log("segments.show", k);
      const s = this.need(k);
      return {
        planId: k.planId,
        version: k.version,
        platform: s.platform,
        status: s.status,
        items: s.items as never,
        createdByActor: "fake",
        publishedAt: s.status === "published" ? new Date(0) : null,
        images: [...s.images.entries()].map(([id, v]) => ({ id, ...v })) as never,
      } as never;
    },
    publish: async (_a, k) => {
      this.log("segments.publish", k);
      const s = this.need(k);
      if (s.status === "published") return;
      const ex = await this.executability(_a, k);
      if (!ex.executable) throw new SignalError("conflict", "not_executable", "监控段当前不可执行，不能发布", ex.blockers);
      s.status = "published";
    },
    newDraft: async (_a, input) => {
      this.log("segments.newDraft", input);
      const from = this.need({ planId: input.planId, version: input.fromVersion });
      const latest = Math.max(...[...this.segs.keys()].filter((x) => x.startsWith(`${input.planId}:`)).map((x) => Number(x.split(":")[1])));
      const k = { planId: input.planId, version: latest + 1 };
      this.segs.set(keyOf(k), { platform: from.platform, status: "draft", items: structuredClone(from.items), images: new Map(from.images) });
      return k;
    },
    purge: async (_a, planId) => {
      this.log("segments.purge", planId);
      for (const k of [...this.segs.keys()]) if (k.startsWith(`${planId}:`)) this.segs.delete(k);
      return { objectsDeleted: 0 };
    },
  };
  private need(k: SegmentKey): FakeSegment {
    const s = this.segs.get(keyOf(k));
    if (!s) throw new SignalError("not_found", "segment_not_found", "监控段不存在");
    return s;
  }

  async requestScores(_a: SignalActor, ref: SegmentRef, subjects: readonly Subject[], ctx: { only: readonly string[] }): Promise<RequestResult> {
    this.log("requestScores", { ref, subjects: subjects.map((s) => `${s.kind}:${s.id}`), only: ctx.only });
    const ex = await this.executability(_a, ref, { only: ctx.only });
    if (!ex.executable) throw new SignalError("conflict", "not_executable", "监控段当前不可执行，不能补算", ex.blockers);
    return {
      items: ctx.only.map((signal) => ({ signal, subjects: subjects.map((s) => ({ id: s.id, disposition: "queued" as const })) })),
      needMedia: [],
      tasks: { created: subjects.length, revived: 0, requeued: 0, reused: 0 },
    };
  }

  async readMany(_a: SignalActor, subjects: readonly Subject[], signalKey: string, o: { param?: { segment?: SegmentRef; elementKey?: string } } = {}): Promise<Map<bigint, SignalValue>> {
    this.log("readMany", { signalKey, n: subjects.length, elementKey: o.param?.elementKey });
    const out = new Map<bigint, SignalValue>();
    for (const s of subjects) out.set(s.id, this.values.get(`${signalKey}|${o.param?.elementKey ?? ""}|${s.id}`) ?? MISSING_NOT_COMPUTED);
    return out;
  }

  // 测试用的简化归一化：小写 + 去空白（真实实现在 C 的 text/normalize）
  normalizeKeyword = (raw: string): string => raw.toLowerCase().replace(/\s/g, "");

  async retainUntil(_a: SignalActor, ids: readonly bigint[], until: Date): Promise<{ matched: number }> {
    this.log("retainUntil", { ids: ids.map(String), until });
    this.retained.push({ ids: [...ids], until });
    return { matched: ids.length };
  }
}

export class FakeDemand implements DemandPort {
  readonly submitted: Array<{ actor: string; input: SubmitDemand }> = [];
  /** 同一 (actor, demandKey) 重复提交得到同一批次。 */
  private readonly batches = new Map<string, SubmitResult>();
  private seq = 0;
  /** 编程：get 返回的视图；默认全部 ready。 */
  views = new Map<string, DemandView>();
  async submit(actor: ActorContext, input: SubmitDemand): Promise<SubmitResult> {
    const key = `${actor.actorId}|${(input as { demandKey: string }).demandKey}`;
    const have = this.batches.get(key);
    if (have) return { ...have, kind: "deduplicated" };
    this.submitted.push({ actor: actor.actorId, input });
    const r: SubmitResult = { kind: "created", batchId: `fake-batch-${++this.seq}`, status: "running", dispositions: [], taskCount: 0 };
    this.batches.set(key, r);
    return r;
  }
  async get(_actor: ActorContext, batchId: string): Promise<DemandView> {
    const v = this.views.get(batchId);
    if (!v) throw new Error(`FakeDemand：批次 ${batchId} 没有编程视图`);
    return v;
  }
}
