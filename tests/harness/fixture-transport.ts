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

/**
 * 默认测试用的供应商 transport：只返回已登记的 fixture 字节。
 * 未登记的请求立即失败，且不计入 calls，所以「没有付费调用」可以直接断言 calls.length。
 */
export class FixtureTransport implements ProviderTransport {
  readonly calls: Array<{ request: ProviderRequest; response: ProviderResponse }> = [];
  readonly rejected: ProviderRequest[] = [];
  private readonly routes: Array<{ matcher: Matcher; response: ProviderResponse }> = [];

  register(matcher: Matcher, response: ProviderResponse): void {
    this.routes.push({ matcher, response });
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
    this.calls.push({ request, response: route.response });
    return route.response;
  }
}
