# OfferU Core v1 Reliability 04 — Interview and Learning recovery

日期：2026-08-31  
观察 checkout：`ae1445d`  
实现 commit：`ae1445d`  
结论：`PARTIAL`

## Scope

本轮只收口 Interview 进行中状态与完成后的 Learning handoff。使用全新隔离 SQLite、真实 backend `8765` 和两次真实进程启动；不读取或修改正常 `djm.db`。

## Implementation under test

应用启动时调用 `recover_interrupted_interview_state`：

- 已提交为 `running` 但尚未提交回答的 `InterviewEvaluationRun` 标为 `failed`，保留 Interview 的 active 状态和当前题目，并给出可重新提交回答的明确错误；
- `completed` Interview 如果缺少 `learning_candidate`，按现有幂等的 Observation → Memory Proposal 链补齐；不直接写入 Profile；
- 已有 `pending`、`accepted`、`rejected`、`deferred`、`revoked` 或 `invalidated` Candidate 的面试不会重复修复。

## Real process startup recovery

隔离库预置：

```text
Interview #1: active, current_question_index=0
Interview #2: completed, report has no learning_candidate
EvaluationRun: running, belongs to Interview #1
```

第一次以隔离数据库启动真实 FastAPI backend 后，直接读取数据库结果：

```json
{
  "evaluations": [
    {
      "status": "failed",
      "completed_at": true,
      "error": "面试评价在应用重启时中断，请重新提交该回答"
    }
  ],
  "active_interview": {
    "status": "active",
    "current_question_index": 0,
    "learning_candidate": null
  },
  "completed_interview": {
    "status": "completed",
    "learning_candidate": {
      "status": "pending",
      "observation_id": 1,
      "proposal_id": 1,
      "target_tier": "career_hypothesis"
    }
  },
  "observations": 1,
  "proposals": 1
}
```

这证明：进行中的面试不会被伪造为完成或丢失当前轮次；中断评价变成明确可重试状态；完成面试的学习交接会进入 pending Candidate，而不是静默写入职业事实。

## Repeated startup / duplicate prevention

使用同一隔离库再次停止并启动真实 backend。第二次读取仍为：

```text
EvaluationRun: 1, failed
Interview Observation: 1, active
Memory Proposal: 1, pending
Interview #1: active, question index 0
Interview #2: completed, Candidate pending
```

没有新增 Evaluation、Observation 或 Proposal，说明启动恢复不会因为重启重复产生学习记录。

两次启动均通过 `/api/health`，结束后正常 `djm.db` backend health 200、diagnostic bundle 200。

## Deterministic test

当前后端 Reliability targeted suite：

```text
8 passed in 40.34s
```

其中新增测试覆盖：running evaluation → failed、active Interview round 保留、completed Interview learning repair 调用与恢复计数。

## Release mapping

| Requirement | Verdict | Evidence |
| --- | --- | --- |
| R28 Interviewer Behavior | NOT_VERIFIED | 本轮不覆盖提问行为约束与追问矩阵 |
| R29 Interview Debrief | PARTIAL | completed Interview 的 report 可在 handoff 中保留并修复 Candidate；transcript citation coverage 仍缺 |
| R30 Interview Learning | PARTIAL | 真实启动恢复 Observation + pending Proposal，且未直接写 Profile；完整完成面试、Accept/Reject 和 UI 回流仍缺 |
| R31 Memory Lifecycle | PARTIAL | pending Candidate 的重启保留与重复防护通过；六态、冲突、撤销和全来源矩阵仍缺 |
| R35 CareerTask lifecycle | PARTIAL | Interview EvaluationRun 的中断状态现在可见且可重试；完整 provider/UI lifecycle 仍缺 |
| R36 Restart Recovery | PARTIAL | Reliability-02 的任务/浏览器恢复加上本轮 Interview/Learning 两个持久化边界；完整五场景矩阵仍缺 |
| R73 Failure Path | PARTIAL | Interview evaluation interruption now becomes an explicit retryable failure；全 Provider/网络/取消矩阵仍缺 |
| R74 Duplicate Mutation | PARTIAL | Learning handoff repeated startup 不重复；Resume/Application/Interview answer/Memory 全矩阵仍缺 |

## Explicit non-claims

本报告不证明：

- 面试模型调用中的真实进程强杀时序、provider timeout/auth、网络恢复和浏览器 UI 恢复；
- 用户重新提交中断回答的 live Provider 路径；
- Interview transcript 全量恢复、Debrief citation、Profile Accept/Reject UI 和 Today/Pipeline projection；
- 全业务 mutation exactly-once、RSS 增长小于 20%、混合 workload soak 或 Public Release readiness。

## Next autonomous work

1. 对真实 backend 执行 RSS warm-up 与混合用户 workload，覆盖 read、candidate accept/reject、Job navigation、Resume edit、automation、Replay task 和 short interview；
2. 扩展 Application、Interview answer、Memory review 的 duplicate click/retry/restart 证明；
3. 继续 Security residual：完整 artifact canary、Rust advisory、权限差异、logging/PII 和 privacy/consent。

## Machine-readable summary

```json
{
  "report_schema": "offeru-eval-report/1.0",
  "suite_id": "offeru-core-v1",
  "suite_version": "1.0.0",
  "run_id": "reliability-04",
  "target_scope": "interview-learning-startup-recovery",
  "evidence_date": "2026-08-31",
  "observed_checkout": "ae1445d",
  "implementation_commit": "ae1445d",
  "verdict": "PARTIAL",
  "passed_subchecks": [
    "active_interview_round_preserved",
    "running_evaluation_marked_retryable_failure",
    "completed_interview_learning_repaired",
    "repeated_startup_does_not_duplicate_learning",
    "normal_database_restored"
  ],
  "not_verified": [
    "live_provider_retry",
    "interview_transcript_ui_recovery",
    "profile_accept_reject_ui",
    "all_business_mutation_exactly_once",
    "rss_growth",
    "mixed_user_soak"
  ],
  "public_release": "NOT_READY",
  "recommended_decision": "continue-rss-mixed-soak-and-mutation-matrix"
}
```
