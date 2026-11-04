#!/usr/bin/env bash
# 密钥扫描：工作区 + git 历史。只打印文件与行号，不打印命中内容。
# 说明见 HBECHO设计方案/runbooks/server-operations-runbook.md §9.5 与 HBECHO设计方案/runbooks/dev-test-deploy-workflow.md §4。
set -euo pipefail
cd "$(dirname "$0")/.."

CRED_RE='(^|/)\.env$|(^|/)\.env\.|settings\.local\.json$|\.pem$|\.p12$|\.pfx$|(^|/)id_(rsa|ed25519)$|_ed25519$|_rsa$|(^|/)服务器密码$|password.*\.txt$'
ALLOW_RE='(^|/)\.env\.example$|(^|/)\.env\.sample$'
CONTENT_RE='(^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}|LTAI[A-Za-z0-9]{12,}|BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY|AccessKeySecret["'"'"']?[[:space:]]*[:=][[:space:]]*["'"'"']?[A-Za-z0-9/+]{16,}'
PLACEHOLDER_RE='sk-x{8,}|LTAIx{6,}|<[A-Za-z_]+>|LTAI\.\.\.|sk-\.\.\.|FAKE'

# ── 原始实测样本的豁免（2026-10-28，刘学奎同意）────────────────
# `aimaster接口文档/测试结果/raw*/` 是供应商响应原文，按“先落 ODS 再解析”的纪律必须保真，
# 不能在仓库里脱敏改写，否则证据链断裂。
# 其中的抖音 CDN 临时下载 URL 带 ss / tt / kcdntag 等参数，某一段恰好形似 sk- 密钥，
# 属于误报；临时 URL 不是凭证，过期即失效，也不能用于重新获取数据。
#
# 边界（不要扩大）：
#   - 只豁免 raw 样本目录下的文件（含 raw4-2026-10-28 这类带日期的命名）；测试脚本、摘要文档、runbook 仍全量扫描；
#   - 若原始响应里真的出现服务端凭证（LTAI / AccessKeySecret / PRIVATE KEY），
#     说明是供应商侧泄漏，不属本豁免范围，需单独排查并轮换；
#   - 这个正则只用于“跳过扫描”，不用于放行任何真密钥。
EVIDENCE_RE='aimaster接口文档/测试结果/raw[^/]*/'
EVIDENCE_PATHSPEC=':!aimaster接口文档/测试结果/raw*'

fail=0

# ── 1. 工作区：凭证类文件名 ──────────────────────────────
# 本地验证时新文件还没进索引，所以带上未跟踪但未被忽略的文件；CI 里它们都已跟踪。
all_files() { git -c core.quotepath=false ls-files --cached --others --exclude-standard; }
cred=$(all_files | grep -E "$CRED_RE" | grep -vE "$ALLOW_RE" || true)
if [ -n "$cred" ]; then
  echo "✗ 工作区包含凭证类文件名："
  echo "$cred" | sed 's/^/    /'
  fail=1
fi

# ── 2. 工作区：内容特征 ──────────────────────────────────
hits=$(git grep -nIE -e "$CONTENT_RE" -- . ':!*.example' ':!*.example.*' "$EVIDENCE_PATHSPEC" 2>/dev/null || true)
# git grep 只扫已跟踪文件；未跟踪的新文件单独扫一遍
untracked_hits=""
while IFS= read -r f; do
  [ -n "$f" ] && [ -f "$f" ] || continue
  case "$f" in *.example|*.example.*) continue;; esac
  [[ "$f" =~ $EVIDENCE_RE ]] && continue
  one=$(grep -nIE -e "$CONTENT_RE" -- "$f" 2>/dev/null | sed "s|^|$f:|" || true)
  [ -n "$one" ] && untracked_hits="${untracked_hits}${one}"$'\n'
done <<< "$(git -c core.quotepath=false ls-files --others --exclude-standard)"
hits=$(printf '%s\n%s\n' "$hits" "$untracked_hits" | grep -vE "$PLACEHOLDER_RE" | grep -v '^$' || true)
if [ -n "$hits" ]; then
  echo "✗ 工作区内容命中密钥特征（命中内容已隐藏）："
  echo "$hits" | sed -E 's/^([^:]+:[0-9]+):.*/\1/' | head -20 | sed 's/^/    /'
  fail=1
fi

# ── 3. 历史：凭证类文件名 ────────────────────────────────
histnames=$(git -c core.quotepath=false log --all --name-only --pretty=format: \
  | sort -u | grep -E "$CRED_RE" | grep -vE "$ALLOW_RE" || true)
if [ -n "$histnames" ]; then
  echo "✗ git 历史中出现过凭证类文件名（补救只能是轮换密钥，不是改历史）："
  echo "$histnames" | sed 's/^/    /'
  fail=1
fi

# ── 4. 历史：内容特征 ────────────────────────────────────
# 逐提交扫描整棵树。仓库规模小，这样比解析 diff 更可靠；历史变大后可换成 gitleaks。
histhits=""
for c in $(git rev-list --all); do
  out=$(git grep -nIE -e "$CONTENT_RE" "$c" -- . ':!*.example' ':!*.example.*' "$EVIDENCE_PATHSPEC" 2>/dev/null \
    | grep -vE "$PLACEHOLDER_RE" || true)
  [ -n "$out" ] && histhits="${histhits}${out}"$'\n'
done
if [ -n "$histhits" ]; then
  echo "✗ git 历史内容命中密钥特征（命中内容已隐藏）："
  echo "$histhits" | sed -E 's/^([^:]+:[^:]+:[0-9]+):.*/\1/' | sort -u | head -20 | sed 's/^/    /'
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo ""
  echo "确认是误报时：把占位值改成 <PLACEHOLDER> 或加进 PLACEHOLDER_RE。"
  echo "确认是真密钥时：按 runbook §8.6 轮换，并从历史里能删则删——但改历史不是补救。"
  exit 1
fi

echo "✓ 密钥扫描通过（工作区与 git 历史）"