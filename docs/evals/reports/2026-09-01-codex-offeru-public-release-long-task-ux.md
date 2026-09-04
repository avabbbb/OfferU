# OfferU Public Release Long Task UX — 2026-09-01

## Scope

把 Today 的后台自动化从静态 Inbox 文案收敛为 CareerTask 的实时投影。用户现在可以在不离开 Today 的情况下看到任务状态、阶段、进度、错误和重试次数；对可控任务可以取消或重试。所有 mutation 仍通过 UI Operation projection，再由显式用户动作确认执行。

## Implementation

- `list_automation_inbox` 按关联 `CareerTask` 投影 bounded task status/progress/error/retryability/attempt snapshot，不复制数据库状态；
- Today 以 2 秒轮询读取 CareerTask，并合并没有 Inbox item 的后台任务；
- queued/running/waiting/failed/blocked/cancelled 有用户可读状态和阶段；有百分比时同时显示文字百分比与进度条；
- cancel/retry 先接收 Registry proposal，再调用 runtime confirmation endpoint；确认失败会显示错误，不伪造成功；
- task card 保留 Job 上下文和打开详情入口。

## Verification

### Backend

```text
backend\.venv312\Scripts\python.exe -m pytest tests/test_reliability.py tests/test_agent_runtime_convergence.py -q
25 passed, 2 warnings in 87.39s
```

新增测试 `test_automation_inbox_projects_live_career_task_snapshot` 验证 running task 的阶段、25% 进度、尝试次数和 retryable 状态来自持久化 CareerTask。

### Frontend

```text
npm run typecheck
PASS
```

### Browser — isolated task-control path

使用 Playwright 可见浏览器和隔离 route fixture，验证：

```text
Today
→ running task title / stage / 25% visible
→ cancel proposal
→ runtime confirmation
→ 已取消 visible
→ failed task / error visible
→ retry proposal
→ runtime confirmation
→ 排队中 visible
```

结果：

```text
controlCalls: 2
confirmCalls: 2
cancelledVisible: 1
queuedVisible: 1
page errors: 0
failed requests: 0
```

### Browser — real local runtime smoke

未拦截 API，使用当前 `http://127.0.0.1:7410` + `http://127.0.0.1:8765`：

```text
Today heading visible
Pipeline visible
page errors: 0
failed requests: 0
```

当前正常工作区没有 pending CareerTask，因此真实 smoke 不声称完成 live task control；隔离 fixture path 专门证明 UI action contract。

## Verdict

```text
PARTIAL — Today long-task status/progress/failure/cancel/retry surface
```

已证明用户不会只看到无限 loading，也不会把 task control 的 proposal 当成已执行。以下仍未被本报告覆盖：

- 所有 >2 秒产品路径的完整 audit；
- 真实 provider timeout/auth/restart 的浏览器矩阵；
- CI failure-only trace/screenshot retention；
- 2 小时 mixed worker endurance 与 transport retry。

## Release mapping

| Requirement | Verdict | Evidence |
| --- | --- | --- |
| R13 Today projection | `PARTIAL` | Today 读取 Automation Inbox + CareerTask snapshot；既有 Job/Resume/Interview projection 仍需全 source matrix |
| R34 Automation Reliability | `PARTIAL` | task cancel/retry proposal/confirmation 与 durable task snapshot 已测；完整 worker exactly-once 仍缺 |
| R35 CareerTask lifecycle | `PARTIAL` | queued/running/waiting/failed/blocked/cancelled UI 状态可见；全 provider/approval lifecycle 仍缺 |
| R61 Long Task UX | `PARTIAL` | real Today smoke + isolated status/progress/error/cancel/retry/confirmation path；并非全部 >2 秒路径 |
| R73 Failure path | `PARTIAL` | task error 状态/操作错误可见；完整 provider/network/restart failure matrix 仍缺 |
| R74 Duplicate path | `PARTIAL` | confirmation boundary 与 backend retry contract 已有证据；浏览器 double-click/transport retry 仍缺 |

## Machine-readable summary

```json
{
  "report_schema": "offeru-eval-report/1.0",
  "suite_id": "offeru-public-release",
  "run_id": "public-release-long-task-ux-2026-09-01",
  "verdict": "PARTIAL",
  "backend_targeted_tests": 25,
  "browser_control_calls": 2,
  "browser_confirmation_calls": 2,
  "browser_cancel_visible": 1,
  "browser_retry_queued_visible": 1,
  "browser_page_errors": 0,
  "browser_failed_requests": 0,
  "live_provider": false
}
```
