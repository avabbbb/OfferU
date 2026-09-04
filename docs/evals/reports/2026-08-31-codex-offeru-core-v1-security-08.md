# OfferU Core v1 Security 08 — synthetic test-data cleanup

日期：2026-08-31  
观察 checkout：当前工作树（Security-07 之后）  
实现 commit：待提交  
结论：`PARTIAL`

## Scope

本轮修复此前测试没有完全隔离而污染正常 `backend/djm.db` 的合成邮箱数据。清理范围只允许严格命中：

```text
gmail-*@example.com
imap-*@qq.com
```

并要求 `user_confirmed=true`。如果 signal 已关联正式阶段事件或日历事件，Operation 会拒绝清理。

## Verification and cleanup

清理前只读审计：

```text
synthetic accounts: 140
email sync runs: 30481
signals: 70
candidates: 70
formal stage events: 0
calendar events: 0
credential references: 105
```

第一次执行因当前虚拟环境缺少 `keyring` 而 fail-closed，数据库没有被删除。补齐 requirements 中已有的 `keyring>=25.6.0` 后，Windows backend 为 `keyring.backends.Windows.WinVaultKeyring`，再次通过 Operation Registry 执行带确认清理：

```text
purged accounts: 140
purged sync runs: 30481
purged signals: 70
deleted credential references: 105
```

清理后：

```text
synthetic accounts/sync runs/signals/candidates: 0 / 0 / 0 / 0
PRAGMA integrity_check: ok
foreign_key_check: 0
/api/health: 200
/api/agent/diagnostics/bundle: 200
/api/email/status: connected=false, accounts=0
/api/jobs/?page_size=1: total=463
```

正常工作区未删除 3 条来源不明的旧 `InterviewNotification.email_body`，仍为 506 字符；该不可恢复操作继续等待明确产品/使用者决定。

## Automated evidence

```text
backend\\.venv312\\Scripts\\python.exe -m pytest tests\\test_privacy_hygiene.py tests\\test_security_canary.py tests\\test_security_logging_contract.py tests\\test_tauri_security_contract.py -q
8 passed, 2 warnings in 17.52s
```

## Release mapping

| Requirement | Verdict | Reason |
| --- | --- | --- |
| R41 External Signals as Candidate | PARTIAL | 合成 signal/candidate 已清除，现有邮箱 confirmation/revoke 边界保留；真实 email/browser/calendar matrix 仍缺 |
| R49 SQLite Integrity | PASS | 清理后 integrity 与 foreign-key check 通过，核心岗位数据仍为 463 条 |
| R50 Security Baseline | NOT_VERIFIED | 测试污染已修复；历史正文、artifact、retention、真实 OAuth 和完整 PII data-flow 仍缺 |
| R51 Secrets exclusion | PARTIAL | 合成 credential references 已通过 Windows keyring delete 路径清除；完整历史/外部 artifact scan 未完成 |
| R52 Canary Secret Test | PARTIAL | 清理失败时 fail-closed 且未伪造成功；完整 release artifact matrix 未签署 |
| R53 PII Logging | PARTIAL | health/diagnostic 不返回账号或正文；旧通知正文和完整宿主/第三方日志仍待审计 |
| R58 Diagnostic Bundle | PARTIAL | privacy hygiene summary 在真实后端返回计数且不返回正文；`safe_to_publish=false` 正确暴露 residual |
| R64 Testing Pyramid | PARTIAL | 隔离清理与回归 contract 有证据；全量迁移/打包/浏览器失败层仍缺 |

## Explicit non-claims

本报告不证明：

- 3 条来源不明的历史旧通知正文已经被清理；
- 所有历史 DB 字段、PDF、trace、Temp、桌面/第三方日志已完成 scrub；
- 真实用户邮箱、OAuth、媒体授权或 Public Release 已通过；
- `keyring` 安装本身等于完成 clean-machine installer 验收；它只是当前开发环境的依赖修复。

## Machine-readable summary

```json
{
  "report_schema": "offeru-eval-report/1.0",
  "suite_id": "offeru-core-v1",
  "suite_version": "1.0.0",
  "run_id": "security-08",
  "target_scope": "synthetic-email-test-data-cleanup",
  "evidence_date": "2026-08-31",
  "implementation_commit": null,
  "verdict": "PARTIAL",
  "passed_security_subchecks": [
    "strict_synthetic_namespace_scope",
    "confirmed_operation_cleanup",
    "keyring_delete_fail_closed",
    "post_cleanup_integrity",
    "normal_database_preserved"
  ],
  "residual": [
    "legacy_notification_body_retention_decision",
    "historical_and_external_artifact_scrub",
    "retention_and_public_legal_policy"
  ],
  "public_release": "NOT_READY",
  "recommended_decision": "continue-browser-golden-path-and-release-engineering"
}
```
