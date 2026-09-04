# Public Release Provider Failure Matrix

日期：2026-09-02  
范围：隔离 SQLite、CareerTask durable control plane、模拟 Provider failure

## 目的

补齐 Provider failure contract 的本地确定性部分，验证认证阻塞和网络超时不会变成静默成功，并且失败状态、错误摘要、重试资格和生命周期事件都进入 durable CareerTask。

## 覆盖场景

| Scenario | Expected durable result |
| --- | --- |
| `401 invalid_api_key` | `blocked`、错误为 `provider authentication failed`、可 retry、`task.blocked` |
| Provider network timeout | `failed`、bounded timeout message、可 retry、`task.failed` |

两个场景都使用独立临时数据库，Provider failure 只通过测试 seam 注入；不触碰正常工作区数据库，也不执行外部写入。

## Verification

```text
backend\.venv312\Scripts\python.exe -m pytest tests\test_public_release_reliability_matrix.py -q -p no:cacheprovider
1 passed in 5.04s
```

结果同时确认：每个任务只执行一次 `attempt_count=1`，认证错误不暴露 canary token，失败状态通过 `task.started + task.failed/blocked` 持久化。

## Release mapping

| Requirement | Verdict | Evidence |
| --- | --- | --- |
| R34 Automation Reliability | `PARTIAL` | Provider auth/timeout 的 durable task failure contract 通过；跨进程 provider/network/cancel/resume 全矩阵仍缺 |
| R35 CareerTask lifecycle | `PARTIAL` | `blocked/failed`、retryable、attempt 和 lifecycle event 通过；真实 Provider 与 force-stop/restart matrix 仍缺 |
| R61 Long Task UX | `PARTIAL` | 失败状态可被 durable task projection 消费；所有真实 >2s Provider/UI failure path 仍缺 |
| R74 Duplicate / retry | `PARTIAL` | 当前 failure contract 保留 retry 资格且不伪造成功；完整 Provider/network mutation matrix 仍缺 |

## Limits

这不是 live Provider/network test：它验证的是控制面在已知异常类型下的行为，不声称当前外部模型、Codex、DSH 或 Role Intelligence live source 可用。完整跨进程 Provider failure、真实断网、backend force-stop 后 retry/resume 和 clean-machine recovery 继续保持 Release residual。

```json
{
  "report_schema": "offeru-eval-report/1.0",
  "suite_id": "offeru-public-release",
  "run_id": "reliability-13-provider-failure-2026-09-02",
  "verdict": "PASS_DETERMINISTIC_FAILURE_CONTRACT",
  "scenarios": ["provider_auth", "provider_timeout"],
  "tests_passed": 1,
  "public_release": "NOT_READY"
}
```
