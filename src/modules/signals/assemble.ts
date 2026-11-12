// signals 的装配入口（design §4）：CLI、worker、将来的 D 都从这里取 Module，不各自拼依赖。
// 各任务把自己的部件加进返回值；依赖（网关、匹配器、两个对象存储）在用到时才进 SignalsDeps。
import type { Db } from "../../db/client";
import type { ImageConverter } from "../media-archive";
import type { Clock, MediaObjectStore } from "../raw-capture";
import type { SignalAuditSink } from "./audit";
import type { SignalsConfig } from "./config";
import { createFacts } from "./facts";
import { createReader } from "./reader";
import { createResultLookup } from "./scoring/lookup";
import type { ImageMatcher } from "./scoring/ports";
import { createRequestScores } from "./scoring/request";
import { createScoreRunner } from "./scoring/runner";
import { createSegments } from "./segments";
import type { AiGatewayPort } from "./speech/ports";

export interface SignalsDeps {
  db: Db;
  clock: Clock;
  audit: SignalAuditSink;
  config: SignalsConfig;
  /** A 的 media 桶：只读（签名 GET URL）。 */
  mediaStore: Pick<MediaObjectStore, "signedGetUrl">;
  /** hbecho-signals 桶：标准图，读写删。 */
  signalsStore: MediaObjectStore;
  signalsBucket: string;
  converter: ImageConverter;
  matcher: ImageMatcher;
  /** 缺省没有网关：语音类能力读作 capability_disabled，不建任务（默认离线、不花钱）。 */
  gateway?: AiGatewayPort;
}

export function createSignals(deps: SignalsDeps) {
  const { db, clock, audit, config } = deps;
  const gateway = deps.gateway ? { gateway: deps.gateway } : {};
  const segments = createSegments({ db, clock, audit, store: deps.signalsStore, bucket: deps.signalsBucket, converter: deps.converter, enabled: config.enabled, ...gateway });
  const reader = createReader({ db, enabled: config.enabled, ...gateway, results: createResultLookup({ db, ...gateway }) });
  const { requestScores } = createRequestScores({ db, clock, audit, config, enabled: config.enabled, ...gateway, executability: (k) => segments.computeExecutability(k) });
  const scoreRunner = createScoreRunner({ db, clock, audit, config, mediaStore: deps.mediaStore, signalsStore: deps.signalsStore, matcher: deps.matcher });
  return { facts: createFacts(db), config, segments, reader, requestScores, scoreRunner };
}
export type Signals = ReturnType<typeof createSignals>;
