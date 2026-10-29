#!/usr/bin/env bash
# hbecho 唯一的本机验证入口。task 边界必跑。
#
# 当前覆盖：密钥（工作区 + 历史）、Markdown 相对链接、文档登记与 spec 结构。
# 应用代码落地后在这里扩展：typecheck → 全部测试 → 静态门禁 → 文档与密钥。
# 扩展时保持一条命令，不要新增「差不多」的第二入口。
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== 1/3 密钥扫描（工作区 + git 历史）=="
./scripts/check-secrets.sh

echo "== 2/3 Markdown 相对链接 =="
python3 -I scripts/check-doc-links.py

echo "== 3/3 文档登记与 spec 结构 =="
python3 -I scripts/check-doc-registry.py

echo ""
echo "verify: OK（当前仅文档与密钥层；不包含类型检查与测试）"