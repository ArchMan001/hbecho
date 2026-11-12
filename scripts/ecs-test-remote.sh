#!/bin/sh
# 在测试 ECS 上运行（由 scripts/ecs-test.sh 上传并启动，不要在本机直接运行）。
# 用法：DRILL=1 ./ecs-test-remote.sh   # DRILL=1 同时跑 6,000 账号规模演练
#       SUITE=full ./ecs-test-remote.sh # 除数据库测试外先跑类型检查与离线单元测试（缺省只跑数据库测试）
#       SIGNALS_DRILL=full              # c-signals 规模演练的完整规模（20 万内容等）；缺省为缩小规模
#       PY=1                            # 数据库测试之后，在宿主机的 venv 里跑 services/capability 的 test_match.py（无 ffmpeg，不跑依赖 ffmpeg 的用例）
# 约束（server-access 第 5 条）：只用一次性容器（独立网络、不映射宿主端口、库名 hbecho_test）；node 容器与 MySQL 共用网络命名空间，所以库主机是回环地址（测试库的清库保护要求）；用完 docker rm -f -v。
# 测试机上跑 a-full-sync 的数据库测试：一次性 MySQL 容器（独立网络、不映射端口、库名 *_test、用完 down -v）。
set -u
RUN=/data/tmp/hbecho-ci
NET=hbecho-ci-net
DB=hbecho-ci-mysql
LOG=$RUN/run.log
cleanup() { docker rm -f -v $DB hbecho-ci-node >/dev/null 2>&1; docker network rm $NET >/dev/null 2>&1; }
trap cleanup EXIT
rm -rf $RUN/src && mkdir -p $RUN/src && tar xzf $RUN/hbecho-src.tar.gz -C $RUN/src
cleanup
docker network create $NET >/dev/null
PW=$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')
docker run -d --name $DB --network $NET --memory 6g -e MYSQL_ROOT_PASSWORD=$PW -e MYSQL_DATABASE=hbecho_test mysql:8.4 --default-time-zone=+00:00 >/dev/null
i=0; until docker exec -e MYSQL_PWD=$PW $DB mysql -h127.0.0.1 -uroot -N -e 'select 1' >/dev/null 2>&1; do i=$((i+1)); [ $i -gt 120 ] && { echo "mysql not ready" >> $LOG; exit 1; }; sleep 1; done
echo "== mysql ready $(date -u +%T)" >> $LOG
(while true; do docker stats --no-stream --format "{{.Name}} {{.MemUsage}}" >> $RUN/mem.log 2>/dev/null; sleep 5; done) &
SAMPLER=$!
cat > $RUN/inner.sh <<'INNER'
#!/bin/sh
LOG=/data/tmp/hbecho-ci/run.log
corepack enable
pnpm install --frozen-lockfile --ignore-scripts=false >> $LOG 2>&1 || { echo '== install failed' >> $LOG; exit 1; }
echo '== install done' >> $LOG
S=$(date +%s)
if [ "${SUITE:-db}" = full ]; then
  pnpm exec tsc --noEmit >> $LOG 2>&1; echo "== typecheck exit $?" >> $LOG
  pnpm exec vitest --run --project unit >> $LOG 2>&1; echo "== unit exit $? seconds $(( $(date +%s) - S ))" >> $LOG
  S=$(date +%s)
fi
pnpm exec vitest --run --project db >> $LOG 2>&1; echo "== exit $? seconds $(( $(date +%s) - S ))" >> $LOG
INNER
docker run --rm --name hbecho-ci-node --network container:$DB --memory 8g -v $RUN/src:/app -v $RUN:$RUN -w /app \
  -e HBECHO_TEST_DATABASE_URL="mysql://root:$PW@127.0.0.1:3306/hbecho_test" -e HBECHO_SCALE_DRILL="${DRILL:-}" -e HBECHO_SCALE_ACCOUNTS=6000 \
  -e SUITE="${SUITE:-db}" -e HBECHO_SIGNALS_DRILL="${SIGNALS_DRILL:-}" \
  node:24-slim sh $RUN/inner.sh
kill $SAMPLER 2>/dev/null
if [ -n "${PY:-}" ]; then
  echo "== python start $(date -u +%T)" >> $LOG
  if python3 -m venv $RUN/venv >> $LOG 2>&1 && $RUN/venv/bin/pip install -q -i https://mirrors.aliyun.com/pypi/simple/ fastapi uvicorn opencv-python-headless numpy pytest >> $LOG 2>&1; then
    S=$(date +%s)
    (cd $RUN/src/services/capability && PYTHONPATH=. $RUN/venv/bin/python -m pytest -q -p no:cacheprovider tests/test_match.py >> $LOG 2>&1; echo "== pytest test_match exit $? seconds $(( $(date +%s) - S ))" >> $LOG)
  else
    echo "== python install failed" >> $LOG
  fi
fi
echo "== finished $(date -u +%T)" >> $LOG
