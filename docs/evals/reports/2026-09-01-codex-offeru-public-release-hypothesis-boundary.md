# OfferU Public Release Hypothesis Boundary — 2026-09-01

## Scope

验证一次 Interview Debrief 产生的潜在能力观察，在经过 Memory Candidate review 后仍以
`career_hypothesis` 身份进入 Profile projection，不会被提升为 `verified_fact`。
测试使用隔离 SQLite，未修改正常用户工作区。

## Flow

```text
interview_debrief observation
↓
career_hypothesis MemoryProposal
↓ accept
ProfileSection(tier=career_hypothesis)
↓
derive_career_model.by_tier
```

Accept 前候选不出现在当前 Career Model；Accept 后只出现在
`by_tier.career_hypothesis`，不会出现在 `by_tier.verified_fact`。

## Result

```text
19 passed, 2 warnings
```

新增测试：
`tests/test_career_memory.py::test_career_hypothesis_stays_separate_from_verified_facts`。

## Verdict

```text
PASS — PotentialHypothesis isolation
```

该报告只证明本地 Profile tier 的隔离与 review boundary；不代表全部六态 Memory lifecycle、
多来源冲突/历史和 UI Memory Inbox 已完整验收。

## Release mapping

| Requirement | Verdict | Evidence |
| --- | --- | --- |
| R32 PotentialHypothesis isolation | `PASS` | Accept 前不入模型，Accept 后保持 `career_hypothesis`，不进入 `verified_fact` |
| R30 Interview Learning | `PARTIAL` | Interview observation/proposal 回流有证据；完整浏览器与所有来源仍缺 |
| R31 Memory Lifecycle | `PARTIAL` | hypothesis tier boundary 已验证；六态/历史/冲突矩阵仍缺 |

## Machine-readable summary

```json
{
  "report_schema": "offeru-eval-report/1.0",
  "suite_id": "offeru-public-release",
  "run_id": "public-release-hypothesis-boundary-2026-09-01",
  "verdict": "PASS",
  "target_tier": "career_hypothesis",
  "verified_fact_leak": false,
  "database": "isolated-temporary-sqlite"
}
```
