#!/usr/bin/env bash
# 提交前扫敏感信息。用法：PII_PATTERNS=<本机私有模式文件> bash pii_scan.sh [base]
# 私有模式文件（姓名、电话、邮箱…）只放本机，不进仓库。
set -u
BASE=${1:-origin/feat/core}
FILES=$(git diff --name-only "$BASE"...HEAD; git diff --name-only; git ls-files --others --exclude-standard)
fail=0
for f in $(echo "$FILES" | sort -u); do
  [ -f "$f" ] || continue
  case "$f" in config.json|*/config.json|*.db|*test-data*) echo "BLOCK file: $f"; fail=1; continue;; esac
  if grep -I -n -E '1[3-9][0-9]{9}|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+[.][a-z]{2,}|sk-[A-Za-z0-9]{20,}' "$f" | grep -v -E 'example[.]com|noreply|13800000000'; then echo "^^ generic hit in $f"; fail=1; fi
  if [ -n "${PII_PATTERNS:-}" ] && grep -I -q -F -f "$PII_PATTERNS" "$f"; then echo "PRIVATE pattern hit in $f"; fail=1; fi
done
for f in $(echo "$FILES" | grep -E '\.(png|jpe?g|gif|mp4|webm|pdf)$'); do
  case "$f" in docs/agent-testing/media/*) ;; *) echo "BLOCK media outside demo dir: $f"; fail=1;; esac
done
if [ $fail = 0 ]; then echo PII_SCAN_OK; else echo PII_SCAN_FAIL; exit 1; fi
