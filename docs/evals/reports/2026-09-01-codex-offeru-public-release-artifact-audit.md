# OfferU Public Release — artifact privacy audit

日期：2026-09-01  
观察 checkout：当前工作树  
结论：`PARTIAL`

## Scope

新增 `backend/scripts/release/audit_artifacts.py`，对发布目录进行值不回显的 fail-closed 扫描。当前检查：

- OfferU canary；
- Bearer、OpenAI-like、GitHub、Google API token；
- PEM private key；
- `.env`、`auth.json`、`cookies.json` 和数据库文件名。

扫描输出只包含相对路径和 finding 类型，不输出匹配内容。

## Local verification

当前本地构建产物扫描结果：

| Tree | Files | Bytes | Findings | Status |
| --- | ---: | ---: | ---: | --- |
| Tauri release bundle | 2 | 412,871,280 | 0 | `clear` |
| Tauri binaries / sidecars | 2 | 152,484,029 | 0 | `clear` |

定向测试：

```text
test_release_artifact_audit.py
test_security_canary.py
test_security_logging_contract.py
6 passed, 2 warnings
```

测试同时证明：clean artifact 不误报；canary、Bearer token 和敏感文件名会被报告，但结果不会包含 secret value。

## CI integration

Windows package job 在收集并上传 release artifact 前，依次扫描：

```text
frontend/src-tauri/target/release/bundle
frontend/src-tauri/binaries
release-artifacts
```

发现任一 finding 会中止该 job；只有扫描完成后才允许上传 artifact。该步骤与 tag signing/Authenticode verification 位于同一 package job。

## Remaining boundary

本机扫描不等于远程 runner 的完整发布证明。以下仍需 CI/RC 或人工完成：

- Windows signed installer 的真实扫描；
- clean machine / installed app 运行期生成的 trace、log、Temp 和诊断包；
- previous-release upgrade 产生的 artifact；
- 历史用户数据库与外部 Provider 日志的完整 PII data-flow；
- 3 条历史 `InterviewNotification.email_body` 的保留/清理产品决定。

没有对正常工作区执行不可恢复的历史正文删除。

## Release mapping

| Requirement | Verdict | Evidence |
| --- | --- | --- |
| R50 Security baseline | `PARTIAL` | release bundle/sidecar scanner + existing security contracts；full data-flow/retention/CI 仍缺 |
| R51 Secrets exclusion | `PARTIAL` | artifact scanner covers high-confidence secret patterns and sensitive filenames；runtime/legacy matrix remains |
| R52 Canary secret test | `PARTIAL` | 6 targeted tests + local bundle/sidecar scan clear；signed CI artifact not run |
| R53 PII logging | `PARTIAL` | scanner does not replace full logger/runtime/third-party audit |
| R91 Release artifact set | `PARTIAL` | CI audit is wired before upload; signed final artifact not produced |
| R92 CI release pipeline | `PARTIAL` | scanner is wired into Windows package job; no remote runner execution |

## Machine-readable summary

```json
{
  "report_schema": "offeru-eval-report/1.0",
  "suite_id": "offeru-public-release",
  "suite_version": "1.0.0",
  "run_id": "artifact-audit",
  "evidence_date": "2026-09-01",
  "verdict": "PARTIAL",
  "local_scans": {
    "tauri_bundle": {"files": 2, "bytes": 412871280, "findings": 0},
    "sidecars": {"files": 2, "bytes": 152484029, "findings": 0}
  },
  "targeted_tests": "6 passed, 2 warnings",
  "ci_runner_executed": false,
  "signed_artifact_scanned": false,
  "public_release": "NOT_READY"
}
```
