#!/usr/bin/env bash
# hbecho 唯一的本机验证入口。task 边界必跑。
#
# 当前覆盖：Node 版本 → 类型检查 → 全部离线测试 → 密钥（工作区 + 历史）→ Markdown 相对链接 → 文档登记与 spec 结构。
# 还没有的：静态门禁（lint）、真实 MySQL 的迁移与集成测试（任务 2 起，用本机一次性 docker 容器）。
# 扩展时保持一条命令，不要新增「差不多」的第二入口。
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== 1/6 Node 版本（.node-version）=="
want="$(tr -d '[:space:]' < .node-version)"
have="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
if [ "$have" != "$want" ]; then
  echo "✗ 需要 Node $want，当前是 ${have:-未找到}（$(command -v node || echo 'node 不在 PATH')）。"
  echo "  请把 Node $want 放到 PATH 最前面后重试；不要用别的主版本跑验证。"
  exit 1
fi
command -v pnpm >/dev/null || { echo "✗ 找不到 pnpm"; exit 1; }
[ -d node_modules ] || { echo "✗ 没有 node_modules，请先 pnpm install --frozen-lockfile"; exit 1; }

echo "== 2/6 类型检查 =="
pnpm --silent typecheck

echo "== 3/6 离线测试（禁网、fixture transport、fake clock/OSS）=="
pnpm --silent test

echo "== 4/6 密钥扫描（工作区 + git 历史）=="
./scripts/check-secrets.sh
echo "== 5/6 Markdown 相对链接 =="
python3 -I scripts/check-doc-links.py
echo "== 6/6 文档登记与 spec 结构 =="
python3 -I scripts/check-doc-registry.py
echo ""
echo "verify: OK（类型检查 + 离线测试 + 文档与密钥；尚无静态门禁与真实数据库集成测试）"
