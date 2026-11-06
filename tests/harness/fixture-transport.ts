import type { ProviderRequest, ProviderResponse, ProviderTransport } from "../../src/modules/raw-capture/ports";

export class UnregisteredFixtureRequestError extends Error {
  constructor(readonly request: ProviderRequest) {
    super(`fixture transport 没有登记该请求：${request.method} ${request.path}?${new URLSearchParams(request.query)}`);
    this.name = "UnregisteredFixtureRequestError";
  }
}

interface Matcher {
  path: string;
  query: Record<string, string>;
}

/** 固定响应，或按请求计算的响应（可以抛 TransportFailure、可以推进 fake clock 模拟耗时）。 */
export type FixtureResponse = ProviderResponse | ((request: ProviderRequest, callIndex: number) => ProviderResponse | Promise<ProviderResponse>);

/**
 * 默认测试用的供应商 transport：只返回已登记的 fixture 字节。
 * 未登记的请求立即失败，且不计入 calls，所以「没有付费调用」可以直接断言 calls.length。
 * 登记的响应函数一旦被调用就计入 calls（请求已「发出」），即使它随后抛出传输错误。
 */
export class FixtureTransport implements ProviderTransport {
  readonly calls: Array<{ request: ProviderRequest; response: ProviderResponse | null }> = [];
  readonly rejected: ProviderRequest[] = [];
  private readonly routes: Array<{ matcher: Matcher; response: FixtureResponse }> = [];

  register(matcher: Matcher, response: FixtureResponse): void {
    this.routes.push({ matcher, response });
  }

  /** 清空已登记的路由（换一周的响应）；calls / rejected 保留，便于累计断言。 */
  clearRoutes(): void {
    this.routes.length = 0;
  }

  async send(request: ProviderRequest): Promise<ProviderResponse> {
    const route = this.routes.find(
      ({ matcher }) =>
        matcher.path === request.path &&
        Object.entries(matcher.query).every(([k, v]) => request.query[k] === v) &&
        Object.keys(request.query).length === Object.keys(matcher.query).length,
    );
    if (!route) {
      this.rejected.push(request);
      throw new UnregisteredFixtureRequestError(request);
    }
    const entry = { request, response: null as ProviderResponse | null };
    this.calls.push(entry);
    const response = typeof route.response === "function" ? await route.response(request, this.calls.length - 1) : route.response;
    entry.response = response;
    return response;
  }
}
