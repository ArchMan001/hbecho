import type { NextConfig } from "next";
// 页面（b-access-control 界面任务）与两个 Route Handler 共用的最小配置：
// - 不暴露 X-Powered-By；
// - 构建期类型检查交给 `pnpm typecheck`，不在 next build 里重复一遍；
// - 批量导入的文件经服务端动作上传：单文件上限 10 MB（Module 再校验一次），请求体上限放到 11 MB；
// - 页面不允许被嵌入别的站点（防点击劫持）。
const config: NextConfig = {
  poweredByHeader: false,
  typescript: { ignoreBuildErrors: true },
  reactStrictMode: true,
  experimental: { serverActions: { bodySizeLimit: "11mb" } },
  async headers() {
    return [{ source: "/:path*", headers: [{ key: "X-Frame-Options", value: "DENY" }] }];
  },
};
export default config;
