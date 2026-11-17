// 健康检查入口：只做路由转发，不含逻辑（ADR-0013：src/app 只做入口与参数校验）。
import { healthResponse } from "../../../modules/access-control/http";

export const dynamic = "force-dynamic";
export const GET = (): Response => healthResponse(process.env.HBECHO_BUILD_SHA);
