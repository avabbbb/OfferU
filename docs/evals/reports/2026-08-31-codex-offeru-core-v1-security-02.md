# SECURITY_02 Gate Evidence

## Scope and verdict

本报告记录 `SECURITY_01` residual 的第二轮收敛：错误关联、脱敏诊断包、验证错误输入隔离、已确认的原始异常/远端响应泄露、健康检查路径收口，以及 Python/JavaScript 依赖复核。它不是 Public Release 的完整安全证明。

| Field | Value |
| --- | --- |
| Report ID | `security-02` |
| Suite | `offeru-core-v1` / `1.0.0` |
| Evidence date | 2026-08-31 |
| Observed checkout | `485871b` (`fix: close security diagnostics residuals`) |
| Gate | `SECURITY_01` residual |
| Verdict | `PARTIAL` — 当前错误/诊断边界与 Python/npm dependency 已有可复核证据，Rust advisory database、完整全链路 canary、权限 diff、全量 logging/PII、历史行 scrub、privacy/consent 和签名仍未完成 |
| Recommended decision | 保持 Public Release `NOT_READY`，继续 Reliability 与剩余 Security gates |

## Environment and isolation

- OS/shell: Windows, PowerShell, Asia/Hong_Kong.
- Python: 3.12 via `backend/.venv312/Scripts/python.exe`.
- Node/npm: Node v24.14.0, npm 11.9.0.
- Runtime: local FastAPI backend on port 8765; frontend Vite dev server on port 7410.
- Security canary requests used fake values only; no Codex OAuth、Gmail OAuth、真实外部投递或真实 Provider 请求。
- Existing local backend was restarted to load the current checkout. No database file or user career record was deleted or replaced.

## Implemented residual boundary

1. Added a bounded in-memory diagnostics service. It records only redacted error ID, method, path, status, kind and bounded message; no request headers, Profile、Job、Resume or provider credentials are collected.
2. Added `export_diagnostic_bundle` to the Operation Registry and exposed it through `/api/agent/diagnostics/bundle`. The bundle projects database health, provider status and recent failures without durable career content or secret values.
3. Added API error correlation. HTTP/Starlette errors, request validation errors and unhandled exceptions receive an `error_id` plus `X-OfferU-Error-Id`; validation output deliberately omits FastAPI's raw `input` field.
4. Updated the frontend API/SSE clients to carry error IDs into user-visible failures. Settings feedback now combines the local browser envelope with the backend diagnostic bundle and locally redacts common credential/PII patterns before download.
5. Closed confirmed raw exception/provider-message paths in Profile smart-fill, Resume PDF/image/SSE generation, Doctor, database migration status and Zhilian/BOSS scrapers. Health output now exposes only the database filename and marks it redacted.
6. Raised `python-multipart` from `0.0.9` to `0.0.31`. PyPI JobSpy `1.1.82` declared a vulnerable `markdownify<0.14.0`; requirements now pin the upstream JobSpy commit `fda080a373e8226f3fd60635323f5da9af9892b1` whose constraint is on the maintained 1.x line, together with `markdownify==1.2.3`.

## Verification evidence

| Check | Result | Evidence |
| --- | --- | --- |
| Security canary + redaction targeted regression | PASS — `10 passed, 2 warnings, 7.60s` | `backend/tests/test_security_canary.py`, `test_security_redaction.py` |
| Backend full regression after dependency update | PASS — `298 passed, 10 warnings, 1 subtest passed in 236.16s` | `.venv312\\Scripts\\python.exe -m pytest tests -q` |
| Frontend typecheck | PASS | `frontend/npm run typecheck` |
| Frontend production build | PASS — Vite 8.1.5, 4263 modules | `frontend/npm run build` |
| API validation canary | PASS | malformed smart-fill payload returned 422 with error ID; fake `api_token` did not occur in body |
| API not-found correlation | PASS | 404 body and `X-OfferU-Error-Id` both contained the same `err_` ID; no query string was retained |
| Local diagnostic endpoint | PASS | `/api/agent/diagnostics/bundle` returned HTTP 200 and `offeru.internal-beta.diagnostics.v1` |
| Health path privacy | PASS | `/api/health` returned `djm.db` plus `database_path_redacted=true`, not an absolute path |
| Browser feedback canary | PASS | Playwright settings path: feedback card visible, endpoint 200, v2 download, fake `api_token` absent, page/console errors 0 |
| Browser feedback first implementation | FIXED before verdict | Initial canary caught an incorrect frontend replacement group; after patch the same test passed with no canary |
| Python dependency audit | PASS | `pip-audit -r requirements.txt --index-url https://pypi.org/simple --timeout 10 --progress-spinner off` → `No known vulnerabilities found` |
| Python dependency consistency | PASS | `pip check` → `No broken requirements found` |
| JobSpy markdown conversion compatibility | PASS | `jobspy.util.markdown_converter('<p>OfferU <strong>security</strong></p>')` returned formatted markdown |
| npm production audit | PASS | `npm audit --omit=dev --registry=https://registry.npmjs.org --audit-level=high` → `found 0 vulnerabilities` |
| Rust dependency audit | NOT_VERIFIED | `cargo-audit` installed, but advisory DB fetch from RustSec stalled; `cargo audit --no-fetch` failed because local advisory cache is absent |
| Diff hygiene | PASS | `git diff --check` clean before commit |

## Release mapping

| Requirement | Verdict | Reason |
| --- | --- | --- |
| R50 Security Baseline | NOT_VERIFIED | Error/diagnostic and dependency subchecks improved; complete security protocol remains incomplete. |
| R51 Secrets exclusion | PARTIAL | Current API validation, diagnostic, browser feedback, config/Run/export paths are covered; complete Temp/log/trace/history scan is open. |
| R52 Canary Secret Test | PARTIAL | Durable canary plus API/error/diagnostic/browser canaries pass; the complete release artifact matrix is not yet signed off. |
| R53 PII Logging | NOT_VERIFIED | Confirmed raw paths were closed, but no complete data-flow inventory of every logger and persisted historical row exists. |
| R54 Tauri Security | PASS | Inherited Security 01 capability/CSP/cargo-check evidence; broad HTTPS limitation remains explicit. |
| R55 Dependency Gate | PARTIAL | Three npm surfaces and Python audit pass; Rust advisory DB is unavailable in this environment. |
| R56 Structured Observability | PARTIAL | Recent error metadata and correlation IDs are structured; full Run/Task/Audit schema matrix is still open. |
| R57 Error Correlation | PARTIAL | HTTP/validation/404 and frontend request/SSE paths have current IDs; every streaming/provider path and persisted audit correlation remain open. |
| R58 Diagnostic Bundle | PARTIAL | Registry-backed v1 bundle and browser download pass the current canary; full artifact/PII review and long-term retention policy remain open. |
| R89 Update Signing | NOT_VERIFIED | No signed updater artifact. |
| R90 Code Signing | BLOCKED_EXTERNAL | Requires the owner's platform certificate and signing credentials. |
| R98 Privacy Disclosure | NOT_VERIFIED | Final product data-flow disclosure is not complete. |
| R99 Consent | NOT_VERIFIED | Final external-model, email and media consent matrix is not complete. |

## Explicit non-claims

This report does not prove:

- that every historical Agent Run/Audit/Temp/log/browser artifact is scrubbed;
- that every logger in the repository has completed a manual PII data-flow review;
- that the RustSec advisory database contains no finding for the current Tauri lockfile;
- that the broad Tauri `https:` CSP is an acceptable final threat model;
- privacy disclosure, consent, updater signing, code signing, clean-machine installation or Public Release readiness.

## Next autonomous work

1. Continue with real process/browser recovery and resource measurements from the Reliability residual, while preserving the Security partial verdict.
2. Return to Security for the full isolated artifact matrix, Operation permission diff, RustSec advisory fetch and privacy/consent documentation when those are in scope.
3. Do not upgrade `SECURITY_01` or Public Release to PASS until the remaining hard gates have current evidence.

## Machine-readable summary

```json
{
  "report_schema": "offeru-eval-report/1.0",
  "suite_id": "offeru-core-v1",
  "suite_version": "1.0.0",
  "run_id": "security-02",
  "target_scope": "security-residual",
  "evidence_date": "2026-08-31",
  "commit": "485871b",
  "verdict": "PARTIAL",
  "public_release": "NOT_READY",
  "passed_security_subchecks": [
    "api_error_id_and_header",
    "validation_input_omission",
    "registry_backed_diagnostic_bundle",
    "browser_feedback_canary",
    "python_dependency_audit",
    "npm_dependency_audit",
    "confirmed_raw_error_path_hardening"
  ],
  "not_verified": [
    "rust_dependency_audit",
    "complete_release_artifact_canary",
    "complete_logging_pii_inventory",
    "operation_permission_diff",
    "historical_agent_run_scrub",
    "privacy_disclosure_and_consent",
    "updater_signing"
  ],
  "blocked_external": ["code_signing_certificate", "optional_provider_oauth"],
  "recommended_decision": "continue-reliability-and-security-residual-gates"
}
```
