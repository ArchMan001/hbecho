# hbecho 应用镜像（Web + access CLI + 迁移共用一个镜像）。
# 形态：node:24-slim + `next start`。不用 standalone：同一镜像里还要跑 `tsx` 的迁移与 access CLI（运维引导首个超管）。
# 构建发生在 CI（不在服务器上构建，ADR-0016）；标签 = git 短 sha。
# 体积与文件数是硬约束（2026-11-11 探针）：链路本身不慢（大文件约 9.4 MB/s），慢的是 node_modules 这种大量小文件的层（约 1.85 MB/s）；
#   单阶段 1.5 GB 镜像每次改动都要重推。
#   两阶段：构建阶段装全部依赖并 next build；运行阶段只装生产依赖（tsx 在 dependencies 里，迁移与 CLI 要用），
#   拷入构建产物（不含 .next/cache）。生产镜像不带 tests/、ui-lab/、设计文档（见 .dockerignore）。
ARG BASE=node:24-slim

FROM ${BASE} AS build
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
# 版本取自 package.json 的 packageManager 字段
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json next.config.ts drizzle.config.ts ./
COPY drizzle ./drizzle
COPY src ./src
# next build 不读业务环境变量（页面全部按请求渲染）；构建期没有任何密钥
RUN pnpm exec next build && rm -rf .next/cache

FROM ${BASE}
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# 临时 store 装完即删，避免同一份文件在镜像里存两遍
RUN pnpm install --prod --frozen-lockfile --store-dir /tmp/pnpm-store && rm -rf /tmp/pnpm-store
COPY tsconfig.json next.config.ts drizzle.config.ts ./
COPY drizzle ./drizzle
COPY src ./src
COPY --from=build /app/.next ./.next
# 组织主档种子：`master-data bootstrap` 的默认路径是仓库根下的这个 CSV（见 bootstrap.ts）。
# 镜像里只有这一个文件来自设计文档目录，其余仍按 .dockerignore 排除。
COPY ["HBECHO设计方案/domains/data-foundation/seed/分公司-大区对照.csv", "./HBECHO设计方案/domains/data-foundation/seed/"]
# 备案号等运行期配置全部来自环境变量，不烘焙进镜像
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000
EXPOSE 3000
USER node
# 运行时不经过 pnpm/corepack（corepack 会在首次运行时去外网下载 pnpm，服务器上不可靠）：直接用 node_modules 里的可执行文件。
# 迁移与 CLI 同理：`./node_modules/.bin/tsx src/db/migrate.ts`、`./node_modules/.bin/tsx src/worker/access-main.ts ...`
CMD ["./node_modules/.bin/next", "start"]
