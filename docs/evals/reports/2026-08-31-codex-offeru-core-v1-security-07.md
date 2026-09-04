# OfferU Core v1 Security 07 — persisted privacy hygiene

日期：2026-08-31  
观察 checkout：当前工作树（Security-06 之后）  
实现 commit：待提交  
结论：`PARTIAL`

## Scope

本轮把历史持久化隐私 residual 变成可检查、可审计且不会被后台静默删除的路径：

```text
legacy InterviewNotification email bodies
privacy hygiene status
diagnostic summary
explicitly confirmed cleanup Operation
```

## Implementation

- 新增 `get_privacy_hygiene_status`：只返回旧邮件正文的记录数、字符数和是否需要处理，不返回正文或账号信息。
- 新增 `scrub_legacy_email_notification_bodies`：必须通过 Operation Registry 且携带 `user_confirmed=true` 才能清理已解析旧通知的冗余正文；结构化的主题、公司、岗位、类别和时间字段保留。
- 清理操作失败关闭，不接受缺省确认；Operation schema 标记为 mutation、requires confirmation 和 `privacy:maintenance` permission。
- 诊断包加入 bounded privacy hygiene summary，让用户/支持人员能看到是否存在历史清理项，而不会把正文带出诊断包。

## Verification

隔离 SQLite 测试验证：

```text
backend\\.venv312\\Scripts\\python.exe -m pytest tests\\test_privacy_hygiene.py tests\\test_security_canary.py tests\\test_security_logging_contract.py tests\\test_tauri_security_contract.py -q
7 passed, 2 warnings in 17.57s
```

正常 `backend/djm.db` 的只读审计发现：

```text
interview_notifications total: 3
non-empty legacy email bodies: 3
legacy body characters: 506
```

这些正常用户记录没有被本轮自动清理，因为清理会不可恢复地移除用户历史正文，必须由用户通过明确确认执行。该选择符合数据安全边界，但意味着当前工作区的 `safe_to_publish` 仍为 false，不能把本轮报告标为完整历史 scrub PASS。

## Release mapping

| Requirement | Verdict | Reason |
| --- | --- | --- |
| R50 Security Baseline | NOT_VERIFIED | 历史正文有可检查/可确认清理路径；正常工作区仍有 3 条旧正文，完整历史、binary/PDF、第三方日志和 retention 仍缺 |
| R51 Secrets exclusion | PARTIAL | 当前数据库隐私卫生状态和旧邮件正文清理已覆盖；全量历史 artifact、Temp、trace、log 和外部宿主仍缺 |
| R52 Canary Secret Test | PARTIAL | 既有 JSON/logging canary 保持通过；诊断新增 privacy summary，完整 release artifact matrix 未签署 |
| R53 PII Logging | PARTIAL | 诊断只输出旧正文计数；旧数据库字段本身和所有宿主/第三方日志仍需审计 |
| R56 Structured Observability | PARTIAL | privacy hygiene status 进入诊断，Operation 有审计边界；统一 retention/correlation 矩阵仍缺 |
| R58 Diagnostic Bundle | PARTIAL | bundle 新增 bounded privacy hygiene summary，不含正文；完整历史 scrub 和 retention policy 未完成 |

## Explicit non-claims

本报告不证明：

- 正常用户数据库的旧正文已经被删除；本轮明确没有执行该不可恢复动作；
- `InterviewExperience.raw_text`、Interview transcript、Resume version、PDF、浏览器 trace 或任意第三方日志已经全部 scrub；这些是用户职业资料或其他独立保留边界，需要单独策略；
- retention、删除语义、法律隐私政策或 Public Release 已通过；
- 诊断摘要可以替代用户对历史数据处理的明确选择。

## Machine-readable summary

```json
{
  "report_schema": "offeru-eval-report/1.0",
  "suite_id": "offeru-core-v1",
  "suite_version": "1.0.0",
  "run_id": "security-07",
  "target_scope": "persisted-privacy-hygiene",
  "evidence_date": "2026-08-31",
  "implementation_commit": null,
  "verdict": "PARTIAL",
  "passed_security_subchecks": [
    "bounded_privacy_hygiene_status",
    "confirmed_legacy_email_body_scrub",
    "diagnostic_privacy_summary"
  ],
  "residual": [
    "normal_workspace_requires_explicit_cleanup",
    "historical_and_external_artifact_scrub",
    "retention_and_public_legal_policy"
  ],
  "public_release": "NOT_READY",
  "recommended_decision": "continue-real-browser-and-release-data-policy-gates"
}
```
