# ADR-0013 · 仓库目录约定

- **状态**：accepted
- **日期**：2026-11-04
- **决策人**：刘学奎
- **关闭**：`CLAUDE.md`「应用代码落地后，目录约定必须由第一份 ADR 决定」

## 背景

ADR-0005 定了单一 Node 应用（Web + 独立 Worker 进程）加一个 Python 能力服务（ADR-0012），但没定目录。tracer 任务 1 要开始写离线 fixture 与合同测试，需要一个合法落点。

## 决定

单仓、单应用，不用 monorepo。所有 TypeScript 放在 `src/` 下（Next.js 原生支持 `src/app`）：

```text
src/app/                 Next.js App Router：页面与 Route Handler，只做入口与参数校验
src/modules/<模块>/       领域逻辑，不 import Next.js；单测 *.test.ts 与源码同目录
src/db/                  Drizzle schema 与受限写入过程的调用封装
src/worker/              Worker 进程入口（领取 MySQL 任务表）
drizzle/                 drizzle-kit 生成的迁移 SQL（只走 db:migrate）
services/capability/     Python 能力服务（ADR-0012），自带 pyproject 与离线测试
tests/fixtures/          离线 fixture：供应商原始响应的脱敏副本
```

规则：

- `src/modules/*` 之间只通过各自的 `index.ts` 导出互相引用；模块名用领域词（`raw-capture`、`provider-adapter`、`identity`、`projection`、`media` 等），以 CONTEXT.md 为准；
- `src/app` 与 `src/worker` 只调用 `src/modules`，不直接写 SQL；
- fixture 只放脱敏后的副本，原始证据仍在 `aimaster接口文档/测试结果/`，不搬家；
- 新增一级目录需要改本 ADR。

## 备选与不选原因

| 方案 | 不选原因 |
|---|---|
| monorepo（`apps/web` + `packages/*`） | 多一层工作区与构建配置；1.0 只有一个应用，收益为零 |
| 根目录 `app/` 加 `src/` 并存 | 代码分两处，Next.js 入口与领域代码的边界不清 |

## 后果

- tracer 任务 1 的 fixture 与合同测试落在 `tests/fixtures/` 与 `src/modules/*`，此时还不需要 Next.js 与数据库；
- `verify.sh` 扩展 typecheck 与 vitest 时，以 `src/` 为根。

## 现在谁在守

- 代码审查；`tsconfig.json` 的 `include` 只含 `src` 与 `tests`。
