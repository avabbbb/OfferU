# OfferU Core v1 Security 05 — logging and PII inventory

日期：2026-08-31  
观察 checkout：当前工作树（Security-04 之后）  
实现 commit：待提交  
结论：`PARTIAL`

## Scope

本轮收口当前 checkout 中最容易产生隐私泄露的日志边界：

```text
Python application logger calls
scraper/search diagnostics
Tauri startup output
```

不使用真实账号、OAuth、外部投递或用户职业数据。

## Inventory and changes

新增 `backend/tests/test_security_logging_contract.py`，用 AST 扫描 `backend/app/**/*.py` 中的标准 `logger`/`_logger` 调用。测试拒绝把岗位、公司、JD、简历、Profile、邮件、Prompt、Cookie、Token、URL、路径和其他敏感载荷作为动态日志参数；允许长度/类型等 bounded metadata、明确的敏感信息脱敏函数和 error ID。

本轮同时完成已确认路径的最小收口：

- 面试问题提取失败只记录固定状态和响应长度，不记录公司/岗位名称；
- BOSS、实习僧、智联招聘只记录 keyword 长度、页码、状态和计数，不记录搜索词；
- Qdrant 连接日志不记录 host；
- LLM/Agent 异常通过 `redact_sensitive_text` 或 `safe_error_message` 后再进入日志；
- Tauri 启动日志不再输出 Python 可执行路径或项目根目录，只输出固定启动信息和布尔状态。

扫描结果：当前标准 Python logger 调用存在，敏感动态日志参数为 0 个。应用代码没有新增 Python 文件日志 handler；本轮只审计和收口应用日志边界，不声称已完成操作系统、Uvicorn、桌面宿主或历史日志的全部清理。

## Verification

执行：

```text
backend\\.venv312\\Scripts\\python.exe -m pytest tests\\test_security_logging_contract.py -q
1 passed in 0.82s

backend\\.venv312\\Scripts\\python.exe -m pytest tests\\test_security_logging_contract.py tests\\test_tauri_security_contract.py tests\\test_security_canary.py -q
5 passed, 2 warnings in 6.91s
```

已有 Security-03 隔离 JSON artifact canary 仍通过：敏感 fake canary 不进入受测非临时文件，普通邮箱文本保留；本轮未向正常 `djm.db` 注入新的 canary。

## Release mapping

| Requirement | Verdict | Reason |
| --- | --- | --- |
| R50 Security Baseline | NOT_VERIFIED | 应用 logger 的当前静态边界已有证据，但完整 release artifact、历史行、binary/PDF、runtime trace、privacy/consent 仍缺 |
| R51 Secrets exclusion | PARTIAL | JSON 落盘 canary 加当前 logger contract 覆盖主要 Python 路径；历史文件、临时目录、桌面/浏览器产物和完整 data-flow matrix 未完成 |
| R52 Canary Secret Test | PARTIAL | Security-03 artifact canary 与本轮日志 contract 通过；完整 release artifact matrix 未签署 |
| R53 PII Logging | PARTIAL | 当前 `backend/app` logger 动态参数静态扫描通过，已收口已知原始路径；历史持久化日志、第三方/桌面日志、运行时采样和全量 PII data-flow 尚未验证 |
| R56 Structured Observability | PARTIAL | bounded error metadata、error ID、diagnostic 和 logger contract 已有证据；完整 Run/Task/Audit correlation/retention schema 仍缺 |
| R57 Error Correlation | PARTIAL | HTTP、SSE、feedback/error ID 和安全日志边界已有证据；全部 Provider、stream、desktop 和历史 audit surface 未完成 |

## Explicit non-claims

本报告不证明：

- 历史 `.log`、数据库历史字段、浏览器输出、Temp、trace、PDF 或其他 binary artifact 已完成 scrub；
- Uvicorn、操作系统、Rust/Tauri 宿主或外部 Provider 自己的日志不含敏感信息；
- 所有 API response、frontend state、网络 payload 和第三方数据流都已经完成 PII inventory；
- privacy notice、按数据类别的 consent、撤回/删除和 retention policy 已经完成；
- RustSec freshness、签名、Packaging 或 Public Release 已通过。

## Machine-readable summary

```json
{
  "report_schema": "offeru-eval-report/1.0",
  "suite_id": "offeru-core-v1",
  "suite_version": "1.0.0",
  "run_id": "security-05",
  "target_scope": "python-logging-pii-inventory",
  "evidence_date": "2026-08-31",
  "implementation_commit": null,
  "verdict": "PARTIAL",
  "passed_security_subchecks": [
    "python_logger_ast_contract",
    "known_raw_logging_paths_redacted",
    "tauri_startup_path_logging_removed"
  ],
  "residual": [
    "historical_and_external_log_scrub",
    "complete_runtime_pii_data_flow",
    "privacy_notice_consent_withdrawal_and_retention"
  ],
  "public_release": "NOT_READY",
  "recommended_decision": "continue-privacy-consent-and-history-artifact-audit"
}
```
