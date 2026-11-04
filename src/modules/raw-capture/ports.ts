// raw-capture 模块的端口（seam）。默认测试换入 fixture / fake 实现；真实实现只在批准的 smoke 与部署里出现。

export interface ProviderRequest {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  /** 准确的请求 body 字节；GET 为 null。认证头不在这里，由 transport 的 secret 配置注入。 */
  readonly body: Uint8Array | null;
}

export interface ProviderResponse {
  readonly httpStatus: number;
  /** 完整接收到的响应 body 字节。 */
  readonly body: Uint8Array;
}

/**
 * 传输层失败。transport 实现必须尽量区分：
 *  - delivered='no'：有证据确认请求没有到达远端（连接被拒、DNS 失败、TLS 握手失败、**连接阶段**超时 UND_ERR_CONNECT_TIMEOUT）
 *    ——可安全按新 attempt 重试。连接超时的 kind 仍是 'timeout'，但 undici 在连接建立前不写请求字节，所以 delivered='no'；
 *  - delivered='unknown'：请求可能已到达（**请求发出后**的超时、连接重置、响应中断）——远端是否执行未知，调用进入 ambiguous。
 * 任何不是 TransportFailure 的异常一律按 unknown 处理。
 */
export class TransportFailure extends Error {
  constructor(
    readonly kind: string,
    readonly delivered: "no" | "unknown",
    message: string,
    readonly opts: { httpStatus?: number; partialBody?: Uint8Array } = {},
  ) {
    super(message);
    this.name = "TransportFailure";
  }
}

/** 供应商 HTTP 传输。 */
export interface ProviderTransport {
  send(request: ProviderRequest): Promise<ProviderResponse>;
}

export interface Clock {
  now(): Date;
}

export interface StoredObject {
  /** 小写 hex，整字节 SHA-256（由存储实现对实际存下的字节计算）。 */
  readonly sha256: string;
  readonly byteLength: number;
}

/** 私有对象存储（ODS / 媒资）。 */
export interface ObjectStore {
  put(key: string, bytes: Uint8Array): Promise<StoredObject>;
  get(key: string): Promise<Uint8Array | null>;
  /** 幂等：对象不存在也成功。 */
  delete(key: string): Promise<void>;
  /** 列出前缀下的对象与创建时间（orphan sweeper 用）。 */
  list(prefix: string): Promise<Array<{ key: string; createdAt: Date }>>;
}
