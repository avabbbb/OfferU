#!/bin/sh
# 重录展示站快照：空数据目录起真后端（默认配置、不接模型）→ seed.py 造演示数据 → 起前端 → record.cjs 逐页录制。
# 前端必须用 7410（后端 CORS 只放行这个开发端口），先关掉自己开着的 vite。
# 用法（仓库根目录）：PYTHON=backend/.venv/bin/python sh frontend/scripts/showcase/refresh.sh
set -e
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
PY=${PYTHON:-python3}
DATA=$(mktemp -d)
cleanup() { kill "$BACKEND" "$FRONTEND" 2>/dev/null || true; rm -rf "$DATA"; }
trap cleanup EXIT
(cd "$ROOT/backend" && OFFERU_DATA_DIR="$DATA" exec "$PY" -m uvicorn app.main:app --host 127.0.0.1 --port 8766 >"$DATA/backend.log" 2>&1) &
BACKEND=$!
(cd "$ROOT/frontend" && exec npx vite --port 7410 --host 127.0.0.1 >"$DATA/vite.log" 2>&1) &
FRONTEND=$!
for i in $(seq 60); do curl -sf http://127.0.0.1:8766/api/health >/dev/null && curl -sf http://127.0.0.1:7410/ >/dev/null && break; sleep 1; done
"$PY" "$ROOT/frontend/scripts/showcase/seed.py"
cd "$ROOT/frontend" && SCRUB="$DATA" node scripts/showcase/record.cjs http://127.0.0.1:7410 src/lib/showcase/snapshot.json
