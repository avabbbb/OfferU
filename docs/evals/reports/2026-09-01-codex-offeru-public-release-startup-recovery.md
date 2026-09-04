# OfferU Public Release Startup Recovery Evidence — 2026-09-01

## Scope

本轮收口启动恢复的可观测边界。恢复失败不应让可选后台能力阻塞核心桌面启动，
但也不能继续被 `except Exception: pass` 静默吞掉。当前统一通过
`backend/app/services/startup_recovery.py` 记录 bounded check status 和 `error_id`，
并由 `/api/health` 与诊断包公开脱敏结果。

已纳入同一边界的检查：

```text
agent_runs
career_tasks
automation_events
research_runs
interview_state
hosted_executors
authorized_research
email_sync
memory_distill
work_source_auto_sync
```

三个可选后台服务的启动也已经改为通过 `run_startup_recovery` 执行；静态架构审计会
拒绝缺失包装或直接绕过包装的调用。

## Exact targeted result

执行：

```text
backend\\.venv312\\Scripts\\python.exe -m pytest tests\\test_startup_recovery.py tests\\test_security_canary.py tests\\test_release_doctor.py -q
```

结果：

```text
11 passed, 3 warnings in 6.71s
```

另有架构 contract：

```text
backend\\.venv312\\Scripts\\python.exe -m pytest tests\\test_release_architecture_audit.py tests\\test_startup_recovery.py -q
9 passed, 1 warning in 1.32s
```

架构脚本当前输出：

```text
route_files=21
route_mutation_functions=151
finding_count=0
status=clear
automation_model_bypasses=[]
startup_recovery_bypasses=[]
```

## Runtime evidence

在正确的 `backend/.venv312` Python 3.12 runtime 重启正常 backend 后，`GET /api/health`
返回 HTTP 200，并报告：

```json
{
  "status": "ok",
  "version": "0.4.0",
  "build_mode": "local-development",
  "database_path": "djm.db",
  "database_path_redacted": true,
  "startup_restore": {"applied": false, "reason": "no_pending_restore"},
  "startup_recovery": {
    "status": "ready",
    "checks": {
      "agent_runs": {"status": "ready"},
      "career_tasks": {"status": "ready"},
      "automation_events": {"status": "ready"},
      "research_runs": {"status": "ready"},
      "interview_state": {"status": "ready"},
      "hosted_executors": {"status": "ready"},
      "authorized_research": {"status": "ready"}
    },
    "failed_checks": []
  }
}
```

`GET /api/agent/diagnostics/bundle` 同样返回 `startup_recovery.status=ready`、上述检查
和 `failed_checks=[]`，没有暴露数据库绝对路径或凭据。当前诊断包另外明确报告：
`privacy_hygiene.status=attention_required`、3 条历史旧邮箱正文、506 字符，
`safe_to_publish=false`；这一隐私残余没有被本轮掩盖。

单元 contract 还验证恢复失败时：

```text
status=degraded
failed_checks=[named_check]
check.error_id=err_...
异常正文/测试 canary 不进入公开 startup status
```

## Verdict

```text
PARTIAL — normal startup observable and optional startup failures are bounded
```

这证明正常启动、健康/诊断可观测性以及可选启动服务的静态边界；不等价于所有真实
强退/重启、文件权限故障、Provider 失败和 clean-machine 安装矩阵均通过。历史隐私
正文、签名、previous-release upgrade、远程 CI 和完整故障矩阵仍是 Public Release
残余。

## Release mapping

| Requirement | Verdict | Evidence |
| --- | --- | --- |
| R36 Restart Recovery | `PARTIAL` | 启动恢复状态统一记录并在 health/diagnostics 暴露；Reliability-02/04/11 已覆盖部分真实重启，完整七类运行中状态矩阵仍缺 |
| R56 Error Correlation | `PARTIAL` | 启动恢复失败关联 bounded `error_id`，与脱敏 diagnostics 同源；完整 provider/installer error matrix 仍缺 |
| R57 Diagnostic Bundle | `PARTIAL` | 诊断包包含 startup recovery、doctor、provider 和隐私卫生状态；异常注入后的全量支持定位矩阵仍缺 |
| R58 Privacy / startup disclosure | `PARTIAL` | startup status 不含异常正文/secret，诊断包保留 safe-to-publish=false；历史正文 scrub、retention 和公开政策仍未决 |
| R61 Restart / recovery | `PARTIAL` | 正常启动和 recovery contract PASS；真实 clean-machine 与升级后恢复仍缺 |
| R73 Failure Path | `PARTIAL` | helper failure 可见、带 error ID、核心启动继续；真实服务/Provider/网络故障 UI matrix 仍缺 |
| R103 Support Diagnostics | `PARTIAL` | health 与 diagnostics 可关联 startup check/error ID；远程/安装环境复现矩阵仍缺 |
| R96 Architecture Drift Scan | `PARTIAL` | `startup_recovery_bypasses=[]` 并接入正式 architecture audit；远程 runner 和动态 legacy/browser audit 仍缺 |

## Machine-readable summary

```json
{
  "report_schema": "offeru-eval-report/1.0",
  "suite_id": "offeru-public-release",
  "run_id": "public-release-startup-recovery-2026-09-01",
  "targeted_tests": {"passed": 11, "warnings": 3},
  "architecture_contract_tests": {"passed": 9, "warnings": 1},
  "architecture_audit": {
    "route_files": 21,
    "route_mutation_functions": 151,
    "finding_count": 0,
    "automation_model_bypasses": 0,
    "startup_recovery_bypasses": 0
  },
  "normal_health": "ready",
  "diagnostic_startup_recovery": "ready",
  "public_release": "NOT_READY",
  "residual": [
    "forced_restart_matrix",
    "provider_failure_matrix",
    "clean_machine",
    "historical_privacy_decision"
  ]
}
```
