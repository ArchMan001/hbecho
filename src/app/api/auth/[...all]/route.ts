// better-auth 处理器入口：只做转发（ADR-0013）。路径白名单与默认拒绝在 createAuthRouteHandlers 里。
import { createAuthRouteHandlers } from "../../../../modules/access-control/http";
import { getAccessRuntime } from "../../../../modules/access-control/runtime";

export const dynamic = "force-dynamic";
export const { GET, POST } = createAuthRouteHandlers(() => getAccessRuntime().auth);
