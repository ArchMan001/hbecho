#!/usr/bin/env bash
# hbecho 唯一的本机验证入口。task 边界必跑。
#
# 覆盖：Node 版本 → 类型检查 → 离线单元测试 → 迁移与 schema 一致 → 数据库测试（真实 MySQL 8.4）
#       → 密钥（工作区 + 历史）→ Markdown 相对链接 → 文档登记与 spec 结构。
# 数据库测试：CI 提供 HBECHO_TEST_DATABASE_URL（MySQL 服务容器）；本机没有该变量时，自动起一个一次性 docker 容器
# （scripts/with-test-mysql.sh：mysql:8.4、库名 *_test、UTC、用完即删）。绝不连测试 ECS，不用 SSH。
# Python 能力服务单测（services/capability，ADR-0012）：需要 pytest 与 ffmpeg >= 7.1（HEIF 解码）。环境不满足时明确打印
# 「未验证」并继续，绝不把跳过说成通过（CI 的 ubuntu 自带 ffmpeg 6.x，不满足，所以 CI 不验 Python 侧）。
# 还没有的：静态门禁（lint）。
# 扩展时保持一条命令，不要新增「差不多」的第二入口。
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== 1/9 Node 版本（.node-version）=="
want="$(tr -d '[:space:]' < .node-version)"
have="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
if [ "$have" != "$want" ]; then
  echo "✗ 需要 Node $want，当前是 ${have:-未找到}（$(command -v node || echo 'node 不在 PATH')）。"
  echo "  请把 Node $want 放到 PATH 最前面后重试；不要用别的主版本跑验证。"
  exit 1
fi
command -v pnpm >/dev/null || { echo "✗ 找不到 pnpm"; exit 1; }
[ -d node_modules ] || { echo "✗ 没有 node_modules，请先 pnpm install --frozen-lockfile"; exit 1; }

echo "== 2/9 类型检查 =="
pnpm --silent typecheck

echo "== 3/9 离线单元测试（禁网、fixture transport、fake clock/OSS）=="
pnpm --silent test

echo "== 4/9 迁移与 schema 一致（drizzle-kit generate 不应产生新文件）=="
fingerprint() { find drizzle -type f -print0 | sort -z | xargs -0 shasum -a 256 | shasum -a 256; }
before="$(fingerprint)"
pnpm exec drizzle-kit generate >/dev/null
after="$(fingerprint)"
if [ "$before" != "$after" ]; then
  echo "✗ src/db/schema 与 drizzle/ 迁移不一致：drizzle-kit generate 产生了新的迁移文件。"
  echo "  请检查 git status drizzle，把生成的迁移纳入提交（或还原对 schema 的改动）。"
  exit 1
fi

echo "== 5/9 数据库测试（MySQL 8.4：迁移 + 约束 + 命令/状态/CLI）=="
if [ -n "${HBECHO_TEST_DATABASE_URL:-}" ]; then
  pnpm exec vitest --run --project db
else
  ./scripts/with-test-mysql.sh pnpm exec vitest --run --project db
fi

echo "== 6/9 密钥扫描（工作区 + git 历史）=="
./scripts/check-secrets.sh
echo "== 7/9 Markdown 相对链接 =="
python3 -I scripts/check-doc-links.py
echo "== 8/9 文档登记与 spec 结构 =="
python3 -I scripts/check-doc-registry.py
echo "== 9/9 Python 能力服务单测（services/capability）=="
py=""
if [ -x "$PWD/services/capability/.venv/bin/python" ]; then py="$PWD/services/capability/.venv/bin/python"; elif python3 -c 'import pytest' 2>/dev/null; then py="python3"; fi
ffok="$(ffmpeg -version 2>/dev/null | head -1 | sed -E 's/.*version n?([0-9]+)\.([0-9]+).*/\1 \2/' | awk 'NF==2 && ($1>7 || ($1==7 && $2>=1)){print "yes"}')"
python_verified="未验证"
if [ -n "$py" ] && [ "$ffok" = "yes" ]; then
  (cd services/capability && "$py" -m pytest -q -p no:cacheprovider)
  python_verified="已验证"
else
  echo "  SKIPPED（Python 侧未验证）：需要 pytest（services/capability/.venv）与 ffmpeg >= 7.1"
fi
echo ""
echo "verify: OK（类型检查 + 单元测试 + 迁移一致 + 数据库测试 + 文档与密钥；Python 侧${python_verified}；尚无静态门禁）"
