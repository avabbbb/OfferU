# OfferU Core v1 Security 06 — privacy consent and email revocation

日期：2026-08-31  
观察 checkout：当前工作树（Security-05 之后）  
实现 commit：待提交  
结论：`PARTIAL`

## Scope

本轮把 Public Release 所需的隐私说明、最小数据类别和邮箱授权撤回边界落到当前实现：

```text
cloud/local interview model consent
authorized browser capture disclosure
Gmail readonly OAuth scope
IMAP readonly connection confirmation
email account revoke
derived email signal/candidate invalidation
```

不使用真实 OAuth、邮箱密码、第三方账号、真实投递或用户职业数据。

## Implementation

- 云端 Interview Runtime 要求明确的数据类别同意；配置 API Key 不等于允许发送敏感职业数据；本地模型只记录本地处理边界，不虚构云端授权。
- Interview Runtime 明确不把原始摄像头/音频作为默认后端数据；授权浏览器研究只保存使用者选择的摘录，且不保存 credentials、cookies 或 storage state。
- Gmail OAuth 只请求 `gmail.readonly`，开始授权前必须在服务端收到 `user_confirmed=true`；OAuth state 也保存并校验本次确认。
- IMAP 连接只接受 `user_confirmed=true`，账号 scope 记录为 `imap:read`；前端在连接前展示只读范围和本地保存说明。
- Email 设置页增加授权确认、错误可见和活动账号撤销入口。撤销通过 Operation Registry 执行：删除钥匙串 credential reference、停止同步、清空游标，使 pending candidate 失效，并清除已存 signal 的邮件标识、发件人、主题、摘要、正文 hash 与分类；已确认的阶段事件只保留不含原文的 `source_revoked` 审计外壳。

工程披露文档见 [`docs/PRIVACY_CONSENT.md`](../../PRIVACY_CONSENT.md)。它是当前实现边界，不代替最终法律隐私政策。

## Verification

执行：

```text
backend\\.venv312\\Scripts\\python.exe -m pytest tests\\test_security_privacy_consent.py tests\\test_email_incremental_sync.py tests\\test_authorized_research.py tests\\test_interview_scoring.py -q
27 passed, 2 warnings in 15.87s

npm --prefix frontend run typecheck
exit code 0
```

额外断言包括：

- Gmail scope 精确为 `https://www.googleapis.com/auth/gmail.readonly`；
- 未确认的 Gmail/IMAP 连接在服务端拒绝，而不是只依赖 UI 禁用按钮；
- 撤销后的账号不再同步，pending candidate 与 signal 内容被清理，已确认 stage event 不携带原始邮件内容；
- 当前前端包含只读范围说明、确认复选框、撤销授权入口和可理解错误提示。

真实浏览器页面验收在本报告生成时仍等待本机 Playwright Chromium 安装完成，不能把静态前端检查当作浏览器 PASS。

## Release mapping

| Requirement | Verdict | Reason |
| --- | --- | --- |
| R41 External Signals as Candidate | PARTIAL | 邮箱 signal 仍先进入 candidate/event 边界，未确认不改正式阶段；完整 email/browser/calendar 矩阵和真实浏览器证据仍缺 |
| R50 Security Baseline | NOT_VERIFIED | 当前 consent/revoke 子项已有证据；历史 scrub、完整 PII data-flow、artifact 矩阵和 retention 仍缺 |
| R51 Secrets exclusion | PARTIAL | 邮箱凭据只保留 opaque keychain reference 且撤回会删除 reference；历史行、Temp、trace、binary/PDF 和第三方日志未完成全量审计 |
| R53 PII Logging | PARTIAL | 当前 logger contract 和邮箱撤回边界已有证据；历史邮件/面试字段、宿主日志和全链路运行采样仍缺 |
| R56 Structured Observability | PARTIAL | 授权/撤回结果进入 Operation 与同步状态；完整 retention、error correlation 和审计 schema 矩阵仍缺 |
| R58 Diagnostic Bundle | PARTIAL | 现有 bundle 不含凭据和职业正文；完整隐私政策、历史 artifact 与 retention review 未完成 |
| R98 Privacy Disclosure | PARTIAL | UI 与工程披露已增加本地/云端、邮箱和媒体范围；最终公开隐私政策与法律审阅仍未完成 |
| R99 Consent | PARTIAL | Interview cloud/local、Gmail、IMAP 和 authorized browser 子项已有 deterministic tests；真实 OAuth/媒体授权、完整 outcome matrix 和最终政策仍缺 |
| R107 Optional Integration Rule | PARTIAL | Gmail/外部研究失败边界可表达；全部 optional Provider 的 UI label 与 live outcome 尚未完成 |

## Explicit non-claims

本报告不证明：

- 真实 Gmail OAuth、IMAP 账号或摄像头/麦克风授权流程已经通过；这些需要用户凭据或真实运行环境；
- 旧版数据库中的 `InterviewNotification.email_body`、历史邮件 signal、artifact、trace、log 或第三方 Provider 日志已经全部 scrub；
- retention、删除请求、公开隐私政策或任何法律/合规判断已经完成；
- 所有模型 Provider、Browser/Calendar 集成或 Public Release 已通过；
- 当前尚未完成的真实浏览器 Golden Path 已通过。

## Machine-readable summary

```json
{
  "report_schema": "offeru-eval-report/1.0",
  "suite_id": "offeru-core-v1",
  "suite_version": "1.0.0",
  "run_id": "security-06",
  "target_scope": "privacy-consent-email-revocation",
  "evidence_date": "2026-08-31",
  "implementation_commit": null,
  "verdict": "PARTIAL",
  "passed_security_subchecks": [
    "minimal_interview_data_categories",
    "cloud_model_explicit_consent",
    "gmail_readonly_scope",
    "server_side_email_confirmation",
    "email_revoke_signal_scrub",
    "authorized_browser_privacy_summary"
  ],
  "residual": [
    "historical_and_external_artifact_scrub",
    "retention_and_public_legal_policy",
    "real_oauth_and_media_consent",
    "browser_golden_path"
  ],
  "public_release": "NOT_READY",
  "recommended_decision": "continue-history-artifact-retention-audit"
}
```
