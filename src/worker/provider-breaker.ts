// provider 熔断（FS-3.7、design §7.5.1）。进程内、每个 provider 一个状态机：closed → open → half_open → closed。
//
//  - 连续 K 次**供应商级**失败（429、5xx、传输错误、超时、ambiguous）→ open：不再为该 provider 领取任务，
//    任务保持 pending、不消耗尝试额度；
//  - open 持续冷却期后 → half_open：只放行一个探测任务；成功回 closed 并清零，失败回 open 重新计时；
//  - 账号级失败（RESULT_VALIDATION_FAILED、HTTP 400、身份不符、字段缺失、解析失败）既不计数也不清零：
//    换个账号照样可能成功，说明不了供应商好坏；在 half_open 里它只释放探测名额，让下一个任务再探测。
//
// ponytail: 进程重启后状态清零，单 worker 够用；多进程需要共享状态后再升级。
export type BreakerState = "closed" | "open" | "half_open";

export interface BreakerDeps {
  /** 连续多少次供应商级失败后打开（K，配置，无默认值）。 */
  failures: number;
  cooldownMs: number;
  nowMs(): number;
  onChange?(change: { provider: string; from: BreakerState; to: BreakerState; consecutiveFailures: number }): void;
}

export interface ProviderBreaker {
  readonly state: BreakerState;
  /** 不改变状态的 tryAcquire：用于领取前决定要不要排除该 provider。 */
  peek(): "yes" | "probe" | "no";
  /** 现在能不能为该 provider 领取：closed 随时；half_open 且没有探测在途时 1 个；open 冷却期内不行。 */
  tryAcquire(): "yes" | "probe" | "no";
  recordSuccess(): void;
  recordProviderFailure(): void;
  /** 账号级失败：中性。 */
  recordNeutral(): void;
  readonly consecutiveFailures: number;
}

export function createProviderBreaker(provider: string, d: BreakerDeps): ProviderBreaker {
  if (!Number.isInteger(d.failures) || d.failures < 1) throw new RangeError("failures 必须是正整数");
  if (!(d.cooldownMs >= 0)) throw new RangeError("cooldownMs 必须非负");
  let state: BreakerState = "closed";
  let consecutive = 0;
  let openedAt = 0;
  let probeInFlight = false;
  const to = (next: BreakerState) => {
    if (next === state) return;
    const from = state;
    state = next;
    d.onChange?.({ provider, from, to: next, consecutiveFailures: consecutive });
  };
  const open = () => {
    openedAt = d.nowMs();
    probeInFlight = false;
    to("open");
  };
  return {
    get state() {
      return state;
    },
    get consecutiveFailures() {
      return consecutive;
    },
    peek() {
      if (state === "closed") return "yes";
      if (state === "open") return d.nowMs() - openedAt < d.cooldownMs ? "no" : "probe";
      return probeInFlight ? "no" : "probe";
    },
    tryAcquire() {
      if (state === "closed") return "yes";
      if (state === "open") {
        if (d.nowMs() - openedAt < d.cooldownMs) return "no";
        to("half_open");
      }
      if (probeInFlight) return "no";
      probeInFlight = true;
      return "probe";
    },
    recordSuccess() {
      consecutive = 0;
      probeInFlight = false;
      to("closed");
    },
    recordProviderFailure() {
      consecutive++;
      if (state === "half_open") return open();
      if (state === "closed" && consecutive >= d.failures) open();
    },
    recordNeutral() {
      if (state === "half_open") probeInFlight = false;
    },
  };
}

/** 按 provider 懒创建一组熔断器。 */
export function createBreakerSet(d: BreakerDeps) {
  const all = new Map<string, ProviderBreaker>();
  const get = (provider: string) => {
    let b = all.get(provider);
    if (!b) all.set(provider, (b = createProviderBreaker(provider, d)));
    return b;
  };
  return { get, snapshot: () => Object.fromEntries([...all].map(([k, v]) => [k, { state: v.state, consecutiveFailures: v.consecutiveFailures }])) };
}
export type BreakerSet = ReturnType<typeof createBreakerSet>;
