# OfferU Public Release — Severity Gate

日期：2026-09-01  
结论：`PASS_P0_P1_ZERO`

## Scope

`KNOWN_ISSUES.md` 现在包含 7 条当前已知残余，并以结构化 severity ledger 作为唯一 inventory。发布前置条件使用 `GATE`，实际产品缺陷使用 `P0`–`P3`，避免把“尚未签名”误报成产品 Bug。

审计命令：

```text
backend\\.venv312\\Scripts\\python.exe backend\\scripts\\release\\audit_release_severity.py --repo-root . --json
```

## Result

```json
{
  "issue_count": 7,
  "severity_counts": {
    "GATE": 6,
    "P0": 0,
    "P1": 0,
    "P2": 1,
    "P3": 0
  },
  "open_p0_p1": [],
  "findings": [],
  "status": "clear"
}
```

这只表示当前已记录并分类的已知项中没有 P0/P1，且 ledger 没有格式、重复 ID 或未分类行。它不替代真实用户 clean-machine 验收、动态全矩阵或安全/隐私所有者决定。

## Release mapping

| Requirement | Verdict | Evidence |
| --- | --- | --- |
| R81 Release Severity | `PASS` | P0–P3 与 GATE 语义已固定在 `KNOWN_ISSUES.md` |
| R82 Release Bug Gate | `PASS` for current known-issue inventory | P0=0、P1=0、7/7 known issues classified、audit findings=0 |
| R106 Release Blocker Rule | `PASS` | 未完成 GATE 仍继续阻止 Public Release，不因 P0/P1 为 0 而放行 |

## Remaining release gates

当前仍有 6 条 `GATE`：代码签名、previous-release upgrade、updater、clean-machine 人工验收、live Role Intelligence claim、历史邮箱隐私决定。它们保持原有 `BLOCKED_EXTERNAL` 或 `NOT_VERIFIED` 状态，不受本次 severity audit 隐藏。

```json
{
  "report_schema": "offeru-eval-report/1.0",
  "suite_id": "offeru-public-release",
  "run_id": "release-severity-2026-09-01",
  "verdict": "PASS_P0_P1_ZERO",
  "p0": 0,
  "p1": 0,
  "known_issue_inventory": 7,
  "audit_findings": 0,
  "public_release": "NOT_READY"
}
```
