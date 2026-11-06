#!/usr/bin/env bash
# 把当前提交（git archive HEAD，不含未提交改动）上传到测试 ECS，在一次性 MySQL + node 容器里跑数据库测试。
#   ./scripts/ecs-test.sh start [--drill]   上传并后台启动（--drill 同时跑 6,000 账号规模演练，约 +5 分钟）
#   ./scripts/ecs-test.sh log               看结果摘要（总数、耗时、容器内存峰值）
# 只用 Workbench（server-access）。测试机允许跑全部测试；生产机（未购买）永远不跑。
set -euo pipefail
INSTANCE="${HBECHO_TEST_ECS:-i-2zef8qpi1d2mldntjgrv}"
PROFILE="${HBECHO_WORKBENCH_PROFILE:-hbecho}"
DIR=/data/tmp/hbecho-ci
here="$(cd "$(dirname "$0")/.." && pwd)"
remote() { workbench exec -P "$PROFILE" -i "$INSTANCE" -c "$1"; }
case "${1:-}" in
  start)
    drill=""; [ "${2:-}" = "--drill" ] && drill="1"
    tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
    git -C "$here" archive --format=tar.gz -o "$tmp/hbecho-src.tar.gz" HEAD
    remote "mkdir -p $DIR && rm -f $DIR/run.log $DIR/mem.log" >/dev/null
    workbench upload "$tmp/hbecho-src.tar.gz" "$DIR/" -i "$INSTANCE" -f >/dev/null
    workbench upload "$here/scripts/ecs-test-remote.sh" "$DIR/" -i "$INSTANCE" -f >/dev/null
    remote "cd $DIR && chmod +x ecs-test-remote.sh && DRILL=$drill nohup ./ecs-test-remote.sh > nohup.out 2>&1 & sleep 1; echo started" | tail -1
    echo "已启动；用 ./scripts/ecs-test.sh log 查看（普通套件约 2–3 分钟含安装，带演练约 7 分钟）" ;;
  log)
    remote "cd $DIR; grep -E '^==|Test Files|Tests |FAIL|Duration|scale-drill\\]' run.log | cut -c1-600 | tail -12; for n in hbecho-ci-node hbecho-ci-mysql; do echo \$n \$(grep \"^\$n \" mem.log 2>/dev/null | awk '{v=\$2; if (v ~ /GiB/) {sub(/GiB/,\"\",v); v=v*1024} else sub(/MiB/,\"\",v); if (v>m) m=v} END{print m\" MiB peak\"}'); done" ;;
  *) echo "用法：$0 start [--drill] | log" >&2; exit 2 ;;
esac
