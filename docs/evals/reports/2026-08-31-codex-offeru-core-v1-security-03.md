# OfferU Core v1 Security 03 — isolated JSON artifact canary

日期：2026-08-31  
观察 checkout：当前工作树（Security-02 `485871b` 之后）  
实现 commit：待提交  
结论：`PARTIAL`

## Scope

本轮只收口一个明确的 Security-02 residual：本地 JSON 产物在落盘时不能保留凭据型 canary。覆盖同一 `atomic_write_json` 边界以及 Run workspace 的独立 JSON 写入路径，使用完全隔离的临时目录，不读取或修改正常用户数据库和现有 `backend/data`。

## Boundary change

- `atomic_write_json` 在生成临时文件前调用 secret-only redaction；因此 Agent memory/history、Resume draft、Application event/follow-up、Pre-application decision、Career artifact、plugin/worker JSON 等共用路径获得同一落盘边界；
- `ArtifactWorkspaceManager.write_artifact` 对 executor 产出的 JSON 使用同一 secret-only redaction；
- 普通职业内容和邮箱等非凭据字符串保持原样，只有 credential-like key、Bearer、URL secret 和 key/value secret 被替换。

## Canary matrix

测试把同一个 fake canary 送入以下隔离产物：

```text
generic atomic JSON
CareerArtifactStore
ApplicationEventStore
FollowUpStore
PreApplicationDecisionStore
ArtifactWorkspaceManager
harness conversation history
harness memory
Resume draft
```

然后扫描临时目录中的所有非临时文件。结果：

```text
canary occurrences: 0
temporary .tmp files retained: 0
owner@example.com retained: yes
```

这证明边界是“只去除凭据”，没有把正常职业内容的邮箱标识当成 secret 删除。

## Verification

执行：

```text
backend\.venv312\Scripts\python.exe -m pytest tests\test_security_canary.py -q
3 passed, 2 warnings in 6.07s
```

该测试与已有 Agent Run/Audit/export、diagnostic/error canary 一起通过；没有使用真实 API key、OAuth、外部 Provider 或真实用户内容。

## Release mapping

| Requirement | Verdict | Reason |
| --- | --- | --- |
| R51 Secrets exclusion | PARTIAL | 共用 JSON 落盘边界和 Run artifact 路径已通过 isolated canary；历史文件、binary/PDF、完整 Temp/log/trace 盘点仍缺 |
| R52 Canary Secret Test | PARTIAL | JSON artifact matrix、durable Agent/Audit/export、API/error/diagnostic/browser canary 均已有证据；完整 release artifact matrix 尚未签署 |
| R53 PII Logging | NOT_VERIFIED | 本轮只验证 secret-only JSON redaction，没有完成全仓库 logger 与历史记录 data-flow inventory |
| R58 Diagnostic Bundle | PARTIAL | Security-02 的 bundle canary 保持通过；本轮补充其依赖的 JSON artifact redaction，不扩张为完整 retention 证明 |
| R79 Full Test Gate | NOT_VERIFIED | 本轮为 security targeted regression，不替代全栈 full verification |

## Explicit non-claims

本报告不证明：

- 历史已有 JSON/SQLite/log/trace/PDF 中不存在旧 canary 或旧凭据；
- 二进制导出、浏览器下载、运行时 stdout/stderr 和所有 logger 已完成 PII 审计；
- RustSec advisory、Operation permission diff、privacy/consent、签名或 Public Release 已通过。

## Machine-readable summary

```json
{
  "report_schema": "offeru-eval-report/1.0",
  "suite_id": "offeru-core-v1",
  "suite_version": "1.0.0",
  "run_id": "security-03",
  "target_scope": "isolated-json-artifact-canary",
  "evidence_date": "2026-08-31",
  "implementation_commit": null,
  "verdict": "PARTIAL",
  "passed_security_subchecks": [
    "atomic_json_artifact_redaction",
    "run_workspace_artifact_redaction",
    "normal_content_preserved",
    "isolated_artifact_matrix"
  ],
  "not_verified": [
    "historical_artifact_scrub",
    "binary_and_pdf_artifact_matrix",
    "complete_logging_pii_inventory",
    "rust_dependency_audit",
    "permission_diff",
    "privacy_and_consent"
  ],
  "public_release": "NOT_READY",
  "recommended_decision": "continue-rust-permission-logging-and-privacy-gates"
}
```
