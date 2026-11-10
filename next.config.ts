import type { NextConfig } from "next";

// 本轮没有页面，只有 Route Handler（b-access-control AX-12）。最小配置：
// - 不暴露 X-Powered-By；
// - 构建期类型检查交给 `pnpm typecheck`，不在 next build 里重复一遍。
const config: NextConfig = {
  poweredByHeader: false,
  typescript: { ignoreBuildErrors: true },
  reactStrictMode: true,
};

export default config;
