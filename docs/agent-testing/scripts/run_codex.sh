#!/usr/bin/env bash
# 后台跑 Codex，只给它 OfferU 的 MCP 工具，不改你的全局 Codex 配置。
# 用法：OFFERU_REPO=<仓库> DATA=<数据目录> [PY=python] bash run_codex.sh <名字> <prompt 文件>
set -u
NAME=$1; PROMPT_FILE=$2
REPO=${OFFERU_REPO:?set OFFERU_REPO}
DATA=${DATA:?set DATA}
PY=${PY:-python}
RUN=${RUNS_DIR:-./runs}/$NAME
mkdir -p "$RUN"
start=$(date +%s)
codex exec --skip-git-repo-check --ephemeral --ignore-user-config -C "$RUN" -s workspace-write \
  -c model_reasoning_effort="medium" \
  -c "mcp_servers.offeru.command=\"$PY\"" \
  -c 'mcp_servers.offeru.args=["-m","app.entry","mcp"]' \
  -c "mcp_servers.offeru.env={OFFERU_DATA_DIR=\"$DATA\",PYTHONPATH=\"$REPO/backend\",PYTHONIOENCODING=\"utf-8\"}" \
  -c 'mcp_servers.offeru.startup_timeout_sec=30' \
  -c 'mcp_servers.offeru.default_tools_approval_mode="approve"' \
  --json -o "$RUN/last.md" - < "$PROMPT_FILE" > "$RUN/events.jsonl" 2> "$RUN/stderr.log"
code=$?
echo "exit=$code seconds=$(( $(date +%s) - start ))"
echo "cancelled_or_approval_lines=$(grep -c -i -E 'cancel|approval' "$RUN/events.jsonl")"
cat "$RUN/last.md"
# events.jsonl 里有简历原文，不要提交。
