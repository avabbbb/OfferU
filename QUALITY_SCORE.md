# OfferU Public Release Quality Score

更新时间：2026-08-31

## Scoring rule

评分表示“距离 Public Release Gate 的证据化完成度”，不是代码质量印象。没有当前、可复现、覆盖整个要求的证据时，即使功能看起来存在也不能高分。`PASS` 需要在 `RELEASE_CHECKLIST.md` 中有权威证据；历史 Internal Beta 结果只提供有限分数。

| Domain | Score | Evidence grade | Main reason |
| --- | ---: | --- | --- |
| Onboarding | 55/100 | Internal Beta only | Replay/Fixture UI 路径曾通过；无 installer/clean-machine 入口与 10/10 report |
| Today | 55/100 | Internal Beta only | 同源投影已有实现线索；无全事件一致性矩阵 |
| Pipeline | 55/100 | Internal Beta only | 核心视图曾通过；完整 stage/timeline/restart 未正式验证 |
| Job | 58/100 | Internal Beta only | Job Context 与自动准备可用；live research 与失败矩阵不足 |
| Resume | 64/100 | Internal Beta only | 手工编辑、Proposal、stale、version、PDF 已有较强证据；99.9% autosave、0 lost edit 与 10/10 未验证 |
| Role Intelligence | 38/100 | Fixture only | Runtime 统计边界存在；至少一个 live provider 与 10-role matrix 缺失 |
| Interview | 48/100 | Internal Beta only | Interview/Debrief/Learning 路径存在；专项 focus、行为约束与恢复矩阵不足 |
| Profile / Memory | 52/100 | Internal Beta only | Candidate → accept 路径存在；完整 lifecycle/history/conflict 未验证 |
| Agent Runtime | 35/100 | Replay only | provider-neutral seam 存在；没有 live provider PASS |
| Automation | 45/100 | Partial evidence | Event/CareerTask/Operation 链存在；exactly-once、cancel/retry/resume 全矩阵不足 |
| Data Safety | 88/100 | Current deterministic migration + export/reset | Online Backup API、manifest/hash、三次恢复、restart、migration rollback、integrity、structured export redaction、Demo Reset scope 和 Settings/Doctor 路径均有当前报告 |
| Reliability | 38/100 | Partial current backend proof | Reliability-01 已覆盖 CareerTask/AutomationEvent 去重、queued/running/waiting 恢复、cancel/retry 和 100-cycle Replay；真实进程/浏览器恢复、RSS、混合用户 soak 与全业务 mutation 仍缺 |
| Security | 52/100 | Security 02 partial | error ID、Registry-backed diagnostic、API/browser canary、确认的原始路径收口、Python `pip-audit` 与 npm audit 已有当前证据；Rust advisory、完整 artifact canary、权限 diff、全量 PII/logging、历史 scrub 和 privacy/consent 仍缺 |
| Installer / Update | 5/100 | FAIL | Tauri dev shell 存在；无 release sidecar、signed installer、updater、clean-machine 或 upgrade evidence |

## Weighted release score

```text
Current unweighted average: 49/100
Release verdict: NOT READY
```

该平均分不能抵消硬 Gate。Data Safety、Security、Packaging、Live Runtime 或 E2E 任一未通过，最终状态都不能是 `OFFERU_PUBLIC_RELEASE_READY`。

## Recalculation trigger

每完成一个大型 Workstream 后：

1. 更新对应 `RELEASE_CHECKLIST.md` 项的状态与证据；
2. 只按新增的当前证据调整分数；
3. 更新 `STATUS.md` 的 Current Gate 与 Next action；
4. 继续最高优先级 Release blocker。
