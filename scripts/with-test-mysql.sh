#!/usr/bin/env bash
# 起一个一次性本机 MySQL 8.4 容器，导出 HBECHO_TEST_DATABASE_URL 后运行传入的命令，退出时删除容器。
#
#   ./scripts/with-test-mysql.sh pnpm exec vitest --run --project db
#
# 约束（dev-ci-cadence / server-access）：只在本机；库名以 _test 结尾；UTC；用完即删；绝不连测试 ECS。
# CI 里由 workflow 的 MySQL 服务容器提供 HBECHO_TEST_DATABASE_URL，不经过本脚本。
set -euo pipefail

if [ "$#" -eq 0 ]; then echo "用法：$0 <命令...>" >&2; exit 2; fi
command -v docker >/dev/null || { echo "✗ 找不到 docker" >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "✗ docker daemon 没有运行" >&2; exit 1; }

name="hbecho-test-mysql-$$"
pw="$(openssl rand -hex 12)" # 一次性口令，容器删除即失效

cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM

docker run -d --rm --name "$name" \
  -e MYSQL_ROOT_PASSWORD="$pw" -e MYSQL_DATABASE=hbecho_test \
  -p 127.0.0.1::3306 \
  mysql:8.4 --default-time-zone=+00:00 >/dev/null

# 官方镜像初始化阶段会先起一个只监听 socket 的临时 server，所以必须经 TCP 探活，不能只 ping
ready=0
for _ in $(seq 1 120); do
  if docker exec -e MYSQL_PWD="$pw" "$name" mysql -h127.0.0.1 -uroot -N -e 'select 1' >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
[ "$ready" = 1 ] || { echo "✗ MySQL 容器 120 秒内没有就绪" >&2; docker logs "$name" 2>&1 | tail -20 >&2; exit 1; }

port="$(docker port "$name" 3306/tcp | head -1 | sed 's/.*://')"
export HBECHO_TEST_DATABASE_URL="mysql://root:${pw}@127.0.0.1:${port}/hbecho_test"
"$@"
