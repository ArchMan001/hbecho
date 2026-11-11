// 进度上报的 Route Handler（design §4.4）：标准 Request → Response，不依赖 Next 运行时，测试直接 new Request() 调用。
// 用 Route Handler 而不是 server action，是因为页面关闭时要用 navigator.sendBeacon 补报。
// Route Handler 没有 Next 的 Origin 校验，所以这里自己做：Origin 必须是受信来源，缺失也拒绝。
import type { AuthContext } from "../access-control";
import type { LearningDeps } from "./deps";
import { LearningError } from "./errors";
import { reportProgress } from "./progress";

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

const MAX_BODY = 2048;

export type AuthenticateFn = (headers: Headers) => Promise<{ ok: true; ctx: AuthContext } | { ok: false; kind: "unauthenticated" | "forbidden" | "unavailable" }>;

export function createProgressHandler(d: { authenticate: AuthenticateFn; deps: () => LearningDeps; trustedOrigins: readonly string[] }) {
  return async (req: Request): Promise<Response> => {
    if (req.method !== "POST") return json(405, { code: "METHOD_NOT_ALLOWED", message: "method not allowed" });
    const origin = req.headers.get("origin");
    if (!origin || !d.trustedOrigins.includes(origin)) return json(403, { code: "origin_not_allowed", message: "请求来源不被允许" });
    const authn = await d.authenticate(req.headers);
    if (!authn.ok) return json(authn.kind === "unauthenticated" ? 401 : authn.kind === "forbidden" ? 403 : 503, { code: authn.kind, message: "登录状态不可用" });

    const text = await req.text();
    if (text.length > MAX_BODY) return json(400, { code: "invalid_input", message: "请求体过大" });
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return json(400, { code: "invalid_input", message: "请求体不是合法的 JSON" });
    }
    try {
      return json(200, await reportProgress(d.deps(), authn.ctx, body));
    } catch (e) {
      if (e instanceof LearningError) return json(e.status, { code: e.code, message: e.message });
      console.error("progress_failed", e instanceof Error ? e.name : typeof e);
      return json(500, { code: "internal_error", message: "内部错误，请稍后重试" });
    }
  };
}
