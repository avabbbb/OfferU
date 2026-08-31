# OfferU Core v1 Reliability 03 — Resume save failure recovery

日期：2026-08-31  
观察 checkout：`25b6a49`  
实现 commit：`25b6a49`  
结论：`PARTIAL`

## Scope

本轮只验证 Resume Workspace 的保存恢复边界，不扩展 Resume 数据模型，也不触碰正常用户数据库。使用隔离 SQLite、真实 backend `8765`、真实 frontend `7410` 和 Playwright hash route `#/resume/1`。

## Implementation under test

Resume editor 现在保留最新 draft ref，并在 autosave response 返回时比较 candidate signature：晚到的旧响应不能覆盖用户更新后的 draft。保存失败时保留编辑内容，显示可理解的失败状态和“重试保存”操作；重试提交当前 draft。

## Successful autosave and reload

真实浏览器路径：

```text
open #/resume/1
↓
edit Chinese summary with a new value
↓
wait for “已保存”
↓
reload
↓
read summary
```

结果：

```json
{
  "workspace_visible": true,
  "saved_value_matches": true,
  "reloaded_value_matches": true,
  "update_requests_before_reload": 1,
  "update_requests_total": 1,
  "page_errors": []
}
```

## Save failure and retry

Playwright 仅对隔离页面的第一次 `PUT /api/resume/1` 注入 `503`，第二次请求返回成功 payload。结果：

```json
{
  "failure_visible": true,
  "retry_visible": true,
  "retained_before_retry": true,
  "retry_succeeded": true,
  "page_errors": [
    "console:Failed to load resource: the server responded with a status of 503 (Service Unavailable)"
  ]
}
```

唯一 console error 是故障注入产生的预期 503 网络日志；没有 JavaScript page error。用户编辑内容在失败后仍可见，重试请求成功，未伪造成功状态。

## Release mapping

| Requirement | Verdict | Evidence |
| --- | --- | --- |
| R17 Resume Workspace | PARTIAL | 当前 commit 的编辑、autosave、失败提示、重试和刷新读取路径通过；Public E2E、10/10 和长时间压力仍缺 |
| R18 Resume Truth Model | PARTIAL | Save failure 不覆盖当前 draft；Master/Job/Packet 全链路与原始版本保护仍缺正式 Public 证据 |
| R19 Resume Proposal | NOT_VERIFIED | 本轮未重新执行 Proposal 全部 Accept/Reject/Edit/Undo 矩阵 |
| R22 Resume Metrics | PARTIAL | 成功保存、单次更新、失败可见、内容保留和重试通过；99.9% autosave、0 lost edit 高频矩阵与中英文 PDF matrix 仍缺 |
| R36 Restart Recovery | PARTIAL | Resume 单页保存失败恢复已补；浏览器/进程重启、面试和候选恢复仍未完成 |
| R75 Resume Conflict | NOT_VERIFIED | 本轮只实现并验证本地旧响应防覆盖；跨标签/并发编辑冲突矩阵仍缺 |

## Explicit non-claims

本报告不证明：

- 高频输入下的 0 lost edit 或 99.9% autosave 成功率；
- 两个浏览器标签、跨进程或离线恢复下的冲突解决；
- Resume Proposal stale、Application Packet 引用、PDF 视觉一致性和所有版本操作的完整回归；
- Interview/Learning pending 恢复、全业务 mutation exactly-once、混合 workload soak 或 RSS 增长小于 20%；
- Security、Packaging、Live Provider 或 Public Release readiness。

## Next autonomous work

1. 建立 Interview in-progress 与 Learning Candidate pending 的隔离重启/失败矩阵；
2. 用真实进程和混合用户 workload 测量 warm-up RSS、队列增长和重复 mutation；
3. 继续 Security residual：artifact canary、Rust advisory、权限差异、logging/PII 和 privacy/consent。

## Machine-readable summary

```json
{
  "report_schema": "offeru-eval-report/1.0",
  "suite_id": "offeru-core-v1",
  "suite_version": "1.0.0",
  "run_id": "reliability-03",
  "target_scope": "resume-save-failure-recovery",
  "evidence_date": "2026-08-31",
  "observed_checkout": "25b6a49",
  "implementation_commit": "25b6a49",
  "verdict": "PARTIAL",
  "passed_subchecks": [
    "resume_chinese_autosave_reload",
    "save_failure_visible",
    "draft_retained_after_save_failure",
    "manual_retry_succeeds",
    "no_javascript_page_error"
  ],
  "not_verified": [
    "high_frequency_zero_lost_edit",
    "cross_tab_conflict",
    "resume_proposal_full_matrix",
    "interview_learning_recovery",
    "rss_growth",
    "mixed_user_soak"
  ],
  "public_release": "NOT_READY",
  "recommended_decision": "continue-interview-learning-recovery-and-resource-gates"
}
```
