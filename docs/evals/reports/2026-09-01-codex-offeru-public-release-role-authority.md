# OfferU Public Release Role Intelligence Authority Evidence — 2026-09-01

## Scope

本轮验证 Role Intelligence 的 authority split：Agent/Provider 只返回结构化候选材料，
Python Runtime 负责 normalization、canonicalization、dedupe、cohort、sample sufficiency、
frequency、Delta、Evidence Gap 和持久化。测试不允许用 LLM 直接写统计数字或候选人职业事实。

## Exact verification

```text
backend\\.venv312\\Scripts\\python.exe -m pytest tests\\test_role_intelligence.py -q
11 passed, 2 warnings, 1 subtests passed in 26.52s

backend\\.venv312\\Scripts\\python.exe -m pytest tests\\test_role_interview.py -q
6 passed, 2 warnings in 4.84s
```

## Evidence

- capability alias canonicalization 保留原始 capability、evidence text 和 source section；
- 21 个 comparator（含 duplicate 与 wrong cohort）经过 dedupe/cohort 后只保留预期 20 个；
- 相同输入的 Delta 两次计算完全相同，`market_frequency`、`comparator_count`、direction 和 evidence refs 来自 Runtime；
- 样本不足时明确返回 `sufficient=false` 与空 signals，不会生成看似完整的市场结论；
- Evidence Gap 只匹配 verified profile evidence，`career_hypothesis` 不会冒充已验证事实；
- fixture/replay 与 deep executor 经过不同 Provider seam；
- benchmark round-trip 保留 target/comparator source、observation evidence、sample 和 Delta signal；
- Operation Registry 暴露 Role Intelligence 所需的读/写边界和 role skill allowed tools；
- Interview Focus Plan 从 persisted benchmark 的 Delta × Evidence Gap 生成，问题蓝图由 Runtime 固定，Interview learning 另见 [Interview learning E2E](2026-09-01-codex-offeru-public-release-interview.md)。

## Verdict

```text
PASS — deterministic authority split
```

该结论只覆盖 Runtime authority boundary 和 deterministic fixture behavior。它不证明实时
网页 Provider、10-role live acceptance 或 Public Release 的实时市场宣传条件。

## Release mapping

| Requirement | Verdict | Evidence |
| --- | --- | --- |
| R23 Role Intelligence authority split | `PASS` | Runtime tests证明 Agent collection seam 与 deterministic normalization/dedupe/cohort/frequency/Delta/Evidence Gap 分离 |
| R24 Fixture vs Live labels | `PARTIAL` | Role/Interview UI 已标注数据模式；真实 live provider 仍缺 |
| R25 Live Provider Gate | `PARTIAL` | Replay/fixture path 通过；真实 Role Intelligence provider 仍未产生结构化 live snapshot |
| R26 10-role Live Acceptance | `NOT_VERIFIED` | 当前仅有单个 fixture target 的 deterministic matrix |
| R27 Interview Focus | `PARTIAL` | Persisted Delta × Evidence Gap → Focus Plan contract 通过，并由浏览器 E2E 验证 UI；live data matrix 仍缺 |
| R65 Unit / Deterministic Tests | `PARTIAL` | Role normalization/Delta/Evidence Gap deterministic tests 已通过；全 Goal 的 deterministic mapping 仍需补齐 |

## Machine-readable summary

```json
{
  "report_schema": "offeru-eval-report/1.0",
  "suite_id": "offeru-public-release",
  "run_id": "public-release-role-authority-2026-09-01",
  "verdict": "PASS_DETERMINISTIC_AUTHORITY_SPLIT",
  "role_intelligence_tests": 11,
  "role_interview_tests": 6,
  "delta_deterministic": true,
  "sample_sufficiency_fail_closed": true,
  "hypothesis_excluded_from_verified_evidence": true,
  "public_release": "NOT_READY",
  "residual": ["live_provider", "10_role_live_matrix", "public_claim_review"]
}
```
