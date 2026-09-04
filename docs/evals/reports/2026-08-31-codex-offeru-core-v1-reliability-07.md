# OfferU Core v1 Reliability 07 — email test isolation

日期：2026-08-31  
观察 checkout：当前工作树（Reliability-06 / Security-08 之后）  
实现 commit：待提交  
结论：`PARTIAL`

## Scope

修复 `backend/tests/test_email_incremental_sync.py` 直接调用默认 `init_db()` 和默认 session 的测试隔离缺口。此前这条测试路径会把合成邮箱账号、同步运行、信号、候选和 keyring 引用写入正常 `backend/djm.db`；本轮将每个 unittest case 改为独立临时 SQLite，并同时隔离邮箱同步和应用进展摄取使用的 session。

## Verification

```text
backend\.venv312\Scripts\python.exe -m pytest tests\test_email_incremental_sync.py -q
7 passed, 2 warnings in 48.66s
```

测试后正常工作区只读审计：

```text
email_accounts: 0
email_sync_runs: 0
external_progress_signals: 0
application_progress_candidates: 0
PRAGMA integrity_check: ok
foreign_key_check: 0
```

## Release mapping

| Requirement | Verdict | Reason |
| --- | --- | --- |
| R34 Duplicate prevention | PARTIAL | 邮箱测试不再跨 case 共享数据；业务重复写的完整网络/browser 矩阵仍缺 |
| R36 Restart Recovery | PARTIAL | 测试隔离避免默认库污染；真实邮箱同步进程重启仍缺 |
| R51 Secrets exclusion | PARTIAL | 测试凭据不再落入正常 DB；完整历史/Temp/trace/第三方 artifact scan 仍缺 |
| R64 Testing Pyramid | PARTIAL | 相关测试可重复且隔离；Public Release 全部层级仍未完成 |
| R69 Playwright Isolation | NOT_VERIFIED | 本报告覆盖 backend unittest，不等价于 browser workspace isolation |

## Explicit non-claims

本报告不证明真实 OAuth、真实邮箱同步、浏览器 Golden Path、Public Release 或完整测试套件已经通过；只证明该邮箱测试文件不再使用正常工作区数据库作为测试夹具。

## Machine-readable summary

```json
{
  "report_schema": "offeru-eval-report/1.0",
  "suite_id": "offeru-core-v1",
  "suite_version": "1.0.0",
  "run_id": "reliability-07",
  "target_scope": "email-test-isolation",
  "evidence_date": "2026-08-31",
  "implementation_commit": null,
  "verdict": "PARTIAL",
  "passed_subchecks": [
    "per_test_temporary_sqlite",
    "email_sync_session_isolation",
    "application_progress_session_isolation",
    "normal_database_unchanged"
  ],
  "residual": [
    "other_legacy_tests_need_isolation_audit",
    "browser_and_real_process_recovery_matrix"
  ],
  "public_release": "NOT_READY",
  "recommended_decision": "continue-browser-golden-path-and-release-engineering"
}
```
