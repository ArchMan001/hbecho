# hbecho 应用镜像（Web + access CLI + 迁移共用一个镜像）。
# 形态：node:24-slim + `next start`。不用 standalone：同一镜像里还要跑 `tsx` 的迁移与 access CLI（运维引导首个超管）。
# 构建发生在 CI（不在服务器上构建，ADR-0016）；标签 = git 短 sha。
# 生产镜像不带 tests/、ui-lab/、设计文档（见 .dockerignore）。
ARG BASE=node:24-slim
FROM ${BASE}
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
# 版本取自 package.json 的 packageManager 字段
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# devDependencies 一并装：迁移与 CLI 用 tsx；镜像体积换来「同一个产物既能迁移又能引导」
RUN pnpm install --frozen-lockfile
COPY tsconfig.json next.config.ts drizzle.config.ts ./
COPY drizzle ./drizzle
COPY src ./src
# next build 不读业务环境变量（页面全部按请求渲染）；构建期没有任何密钥
RUN pnpm exec next build
# 备案号等运行期配置全部来自环境变量，不烘焙进镜像
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000
EXPOSE 3000
USER node
CMD ["pnpm", "exec", "next", "start"]
