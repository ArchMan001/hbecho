// Route Handler 的实现（design §4、AX-12）：标准 Request → Response，不依赖 Next 运行时，测试直接用 new Request() 调用。
// 默认拒绝：better-auth 自带很多端点（注册、改邮箱、删用户、设置密码、冒充……），本项目只放行下面几条（AX-1）。
// 没有公开注册、没有管理员代设密码（PRD §12），所以白名单之外一律 404，不转发给库。
import { BASE_PATH, type AccessAuth } from "./auth-instance";

/** path（去掉 basePath）→ 允许的方法。 */
export const ALLOWED_AUTH_ROUTES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["/sign-in/phone-number", new Set(["POST"])],
  ["/sign-out", new Set(["POST"])],
  ["/get-session", new Set(["GET"])],
  ["/phone-number/send-otp", new Set(["POST"])],
  ["/phone-number/verify", new Set(["POST"])],
  ["/phone-number/request-password-reset", new Set(["POST"])],
  ["/phone-number/reset-password", new Set(["POST"])],
  ["/change-password", new Set(["POST"])],
]);

const json = (status: number, body: unknown, extra: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...extra } });

export function createAuthRouteHandlers(getAuth: () => AccessAuth | Promise<AccessAuth>) {
  const handle = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (!url.pathname.startsWith(`${BASE_PATH}/`)) return json(404, { code: "NOT_FOUND", message: "not found" });
    const path = url.pathname.slice(BASE_PATH.length).replace(/\/+$/, "");
    const methods = ALLOWED_AUTH_ROUTES.get(path);
    if (!methods) return json(404, { code: "NOT_FOUND", message: "not found" });
    if (!methods.has(req.method)) return json(405, { code: "METHOD_NOT_ALLOWED", message: "method not allowed" }, { allow: [...methods].join(", ") });
    return (await getAuth()).handler(req);
  };
  return { GET: handle, POST: handle };
}

/** 健康检查：只证明进程在、路由通；不读不写数据库。`build` 是镜像对应的提交号（构建时传入），用来核对「线上跑的是哪一版」。 */
export function healthResponse(build?: string): Response {
  return json(200, { ok: true, build: build?.trim() || "unknown" });
}
