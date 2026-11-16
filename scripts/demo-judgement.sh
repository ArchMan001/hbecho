#!/usr/bin/env bash
# 判定计划页面的本机演示环境：一次性 MySQL 8.4 容器 → 迁移 → 造数 → 启动 Next（同一进程）。
#
#   ./scripts/demo-judgement.sh # 前台运行，Ctrl-C 退出并删除容器
#
# 约束（dev-ci-cadence / server-access）：只在本机；库名以 _test 结尾；用完即删；绝不连测试 ECS，也不连任何真实数据库。
# 对 C 的端口是 FakeSignals，没有任何真实采集 / 识别 / 付费调用。详见 tests/demo/judgement-demo.ts。
set -euo pipefail
command -v docker >/dev/null || { echo "✗ 找不到 docker" >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "✗ docker daemon 没有运行" >&2; exit 1; }
name="hbecho-demo-mysql-$$"
pw="$(openssl rand -hex 12)"
cleanup() { docker rm -f -v "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM
docker run -d --rm --name "$name" -e MYSQL_ROOT_PASSWORD="$pw" -e MYSQL_DATABASE=hbecho_demo_test -p 127.0.0.1::3306 mysql:8.4 --default-time-zone=+00:00 >/dev/null
ready=0
for _ in $(seq 1 120); do
  if docker exec -e MYSQL_PWD="$pw" "$name" mysql -h127.0.0.1 -uroot -N -e 'select 1' >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
[ "$ready" = 1 ] || { echo "✗ MySQL 容器 120 秒内没有就绪" >&2; exit 1; }
port="$(docker port "$name" 3306/tcp | head -1 | sed 's/.*://')"
export HBECHO_DEMO_DATABASE_URL="mysql://root:${pw}@127.0.0.1:${port}/hbecho_demo_test"
HBECHO_DATABASE_URL="$HBECHO_DEMO_DATABASE_URL" pnpm db:migrate
exec_tsx() { pnpm exec tsx tests/demo/judgement-demo.ts; }
exec_tsx
