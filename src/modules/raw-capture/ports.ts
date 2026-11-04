// raw-capture 模块的端口（seam）。任务 1 只定义接口，让默认测试可以换入 fixture / fake 实现；
// RawCaptureGateway 本身在任务 3 实现。

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

/** 供应商 HTTP 传输。默认测试只允许 fixture 实现；真实实现只在批准的 smoke 里出现。 */
export interface ProviderTransport {
  send(request: ProviderRequest): Promise<ProviderResponse>;
}

export interface Clock {
  now(): Date;
}

export interface StoredObject {
  /** 小写 hex，整字节 SHA-256。 */
  readonly sha256: string;
  readonly byteLength: number;
}

/** 私有对象存储（ODS / 媒资）。 */
export interface ObjectStore {
  put(key: string, bytes: Uint8Array): Promise<StoredObject>;
  get(key: string): Promise<Uint8Array | null>;
}
