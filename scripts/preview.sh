#!/usr/bin/env bash
# 本机预览环境：4175（可点击原型）+ 3202（完整应用，造好数据）。两个入口都来自**当前这个工作树**，所以永远是同一份代码。
#
#   ./scripts/preview.sh      # 前台运行；Ctrl-C 退出并删除容器与静态服务
#
# 做了什么：
#   1. 起一次性本机 MySQL 8.4 容器并迁移（库名以 _test 结尾，用完即删；绝不连测试 ECS，也不连任何真实数据库）
#   2. 在 4175 起静态服务（ui-lab/）
#   3. 清库、造数、在 3202 起 Next（dev + webpack，假短信、假的 C 端口），详见 tests/demo/preview.ts
# 每次启动都重置成同一份预览数据。规则与地址见 ui-lab/LOCAL-UI.md 与 .kiro/steering/ui-workflow.md。
set -euo pipefail
cd "$(dirname "$0")/.."
command -v docker >/dev/null || { echo "✗ 找不到 docker" >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "✗ docker daemon 没有运行" >&2; exit 1; }
for p in 3202 4175; do
  if lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "✗ 端口 $p 已被占用：" >&2
    lsof -nP -iTCP:"$p" -sTCP:LISTEN | tail -n +2 | awk '{print "   pid=" $2 "  " $1}' >&2
    echo "  旧的预览服务要先停掉（kill <pid>）；不确定是谁起的就先问。" >&2
    exit 1
  fi
done
name="hbecho-preview-mysql-$$"
pw="$(openssl rand -hex 12)"
static_pid=""
cleanup() {
  [ -n "$static_pid" ] && kill "$static_pid" >/dev/null 2>&1 || true
  docker rm -f -v "$name" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM
docker run -d --rm --name "$name" -e MYSQL_ROOT_PASSWORD="$pw" -e MYSQL_DATABASE=hbecho_preview_test -p 127.0.0.1::3306 mysql:8.4 --default-time-zone=+00:00 >/dev/null
ready=0
for _ in $(seq 1 120); do
  if docker exec -e MYSQL_PWD="$pw" "$name" mysql -h127.0.0.1 -uroot -N -e 'select 1' >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
[ "$ready" = 1 ] || { echo "✗ MySQL 容器 120 秒内没有就绪" >&2; exit 1; }
port="$(docker port "$name" 3306/tcp | head -1 | sed 's/.*://')"
export HBECHO_PREVIEW_DATABASE_URL="mysql://root:${pw}@127.0.0.1:${port}/hbecho_preview_test"
HBECHO_DATABASE_URL="$HBECHO_PREVIEW_DATABASE_URL" pnpm db:migrate
python3 -m http.server 4175 --directory ui-lab >/dev/null 2>&1 &
static_pid=$!
echo "4175 原型：http://localhost:4175/   （来自 $(pwd)/ui-lab）"
pnpm exec tsx tests/demo/preview.ts
