import type { NextConfig } from "next";
// 页面（b-access-control 界面任务）与两个 Route Handler 共用的最小配置：
// - 不暴露 X-Powered-By；
// - 构建期类型检查交给 `pnpm typecheck`，不在 next build 里重复一遍；
// - 批量导入的文件经服务端动作上传：单文件上限 10 MB（Module 再校验一次），请求体上限放到 11 MB；
// - 页面不允许被嵌入别的站点（防点击劫持）；唯一例外是学习资料预览响应允许同源嵌入。
const config: NextConfig = {
  poweredByHeader: false,
  typescript: { ignoreBuildErrors: true },
  reactStrictMode: true,
  // 云厂商官方 SDK 是 CommonJS 且带运行期 require（proxy-agent 等），不让打包器内联；浏览器端的 ali-oss 走它的 browser 入口
  serverExternalPackages: ["ali-oss", "@alicloud/vod20170321", "@alicloud/dysmsapi20170525"],
  experimental: { serverActions: { bodySizeLimit: "11mb" } },
  async headers() {
    return [
      { source: "/:path*", headers: [{ key: "X-Frame-Options", value: "DENY" }] },
      // 资料预览由本服务转发（OSS 默认域名强制下载），要被课程详情页同源 iframe 嵌入；后一条规则覆盖前一条的同名头
      { source: "/api/learning/courses/:id/preview", headers: [{ key: "X-Frame-Options", value: "SAMEORIGIN" }] },
    ];
  },
};
export default config;
