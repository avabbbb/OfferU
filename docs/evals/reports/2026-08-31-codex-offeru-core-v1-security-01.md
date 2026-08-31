# SECURITY_01 Gate Evidence

## Scope and verdict

这是一份 `SECURITY_01` Gate 补充报告，覆盖当前 checkout 的敏感信息边界、错误与日志脱敏、Tauri capability/CSP、npm 依赖、Pi Runtime smoke、CORS/安全响应头和 Agent Run 持久化元数据。它不是 Public Release 的完整安全证明。

| Field | Value |
| --- | --- |
| Report ID | `security-01` |
| Suite | `offeru-core-v1` / `1.0.0` |
| Evidence date | 2026-08-31 |
| Observed checkout | `7529c59` |
| Gate | `SECURITY_01` |
| Verdict | `PARTIAL` — 当前安全子项已明显收敛，但完整 canary、Python/Rust 依赖审计、全量 logging/PII、diagnostic、权限 diff、隐私/consent 和发布签名证据仍未完成 |
| Recommended decision | 继续完成 Security residual gates；Public Release 保持 `NOT_READY` |

## Environment and isolation

- OS/shell: Windows, PowerShell, Asia/Hong_Kong.
- Python: 3.12 via `backend/.venv312/Scripts/python.exe`.
- Node/npm: Node v24.14.0, npm 11.9.0.
- Runtime: local FastAPI backend on port 8765; frontend dev server on port 7410.
- Database: normal local runtime was health-checked after the isolated Data Safety browser work; no destructive security test was run against real user data.
- External access: no live LLM request, Codex OAuth, Gmail OAuth, or job-site account was used. Pi checks use the local worker protocol with a fake provider/session.

## Implemented security boundary

1. Added a dependency-free recursive redaction boundary for credential-like keys, Bearer values, URL secrets, email/phone identifiers and bounded public error messages.
2. Applied redaction to current LLM, Agent, research, interview, resume, memory, automation, scraper, config, bridge and data-safety error/log paths that previously exposed raw exception text or provider payloads.
3. Redacted persisted Agent Run steps, proposals, skill/runtime metadata, result previews and failure text before they are returned or newly stored. Operation Audit, CareerTask, Automation and Hosted Executor JSON boundaries now use credential-only redaction where user content must remain intact. Historical rows are not silently rewritten.
4. Config responses now project provider credentials instead of returning raw API keys or nested header/extra-parameter secrets.
5. CORS methods and headers are explicit; API responses receive `nosniff`, frame denial, no-referrer, restrictive permissions and `no-store` headers.
6. Removed the generic Tauri shell plugin and shell execute/spawn/kill permissions from the frontend capability. Rust’s internal launcher still uses the standard-library process boundary to start the local Python backend.
7. Replaced the null Tauri CSP with a restrictive baseline. The current product still allows broad HTTPS for user-configured LLM endpoints and MediaPipe assets; this is an explicit residual limitation, not a claim of strict network isolation.
8. Upgraded the Pi worker SDK line to `0.84.4` and refreshed npm lockfiles with the existing security overrides.

## Executed engineering checks

| Check | Result | Evidence |
| --- | --- | --- |
| Security redaction + Agent/Bridge/Hosted targeted regression | PASS — 35 passed, 2 warnings, 26.52s | `backend/tests/test_security_redaction.py`, `test_agent_control_plane.py`, `tests/agent_bridge/test_slice1_server.py`, `test_coding_agent_runtime.py` |
| Isolated release-canary durable-path regression | PASS — 37 tests in the current targeted set; no raw canary in Agent Run, Operation Audit or export | `backend/tests/test_security_canary.py`, `test_data_export.py` |
| Current full backend regression | PASS — 290 passed, 10 warnings, 1 subtest, 518.59s | `.venv312\\Scripts\\python.exe -m pytest tests -q` on `7529c59` |
| Frontend typecheck | PASS | `frontend/npm run typecheck` |
| Frontend production build | PASS — Vite 8.1.5, 4263 modules | `frontend/npm run build` |
| Tauri Rust compile check | PASS | `frontend/src-tauri/cargo check` |
| Agent-runtime npm audit | PASS — 0 vulnerabilities | `agent-runtime/npm audit --omit=dev --audit-level=moderate` |
| Frontend npm audit | PASS — 0 vulnerabilities | `frontend/npm audit --omit=dev --audit-level=moderate` |
| Extension npm audit | PASS — 0 vulnerabilities | `extension/npm audit --omit=dev --audit-level=moderate` |
| Pi worker protocol probe | PASS — `offeru.pi-worker.v1`, SDK `0.84.4`, Node `24.14.0` | `agent-runtime` worker `runtime.probe` |
| Pi worker lifecycle smoke | PASS — `run.start → run.dispose → shutdown`, no error | fake-provider local worker harness; no external model call |
| Live HTTP security headers | PASS | `/api/health` returned HTTP 200 with `nosniff`, `DENY`, `no-store` |
| CORS positive preflight | PASS | Origin `http://localhost:7410` allowed with explicit methods/headers |
| CORS negative preflight | PASS | Origin `http://evil.invalid` received no allow-origin |
| Public config projection | PASS | `/api/config/` contained no known fake canaries and no raw `api_key` JSON value |
| Tauri capabilities static check | PASS | only `core:default`; no shell plugin/permission |
| Tauri CSP static check | PASS with residual broad HTTPS | non-null CSP includes `self`, `object-src 'none'`, `frame-ancestors 'none'` |
| Tracked secret scan | PASS — 647 files scanned; 1 expected fixture; 0 unexpected files | expected fixture: `extension/src/rule-packs/validator.test.ts` |
| CLI Doctor after runtime restart | PASS | schema 2/2, integrity `ok`, FK violations 0, backup count 2 |
| Python dependency audit | NOT_RUN | `pip-audit` is not installed in the environment |
| Rust dependency audit | NOT_RUN | `cargo-audit` is not installed in the environment |

## Security findings closed in this gate

| Finding | Outcome |
| --- | --- |
| Tauri generic shell capability | Closed for frontend capability surface; the shell plugin and generic permissions were removed. |
| Null Tauri CSP | Closed as a baseline violation; a non-null CSP now denies objects/frames and restricts scripts/forms/base URLs. |
| Raw API keys in config projection | Closed for the current config response path; provider keys and nested secret-like metadata are masked. |
| Raw exception/provider payloads in reviewed paths | Closed for the audited paths through bounded redaction and omission of raw LLM JSON logging. |
| New Agent Run proposal/result metadata carrying credential-like values | Closed for newly created/updated Run state and public projections; coverage is asserted by a canary-shaped unit test. |
| Unpinned vulnerable JS dependency line | Closed for the audited npm surfaces; all three npm audits report zero vulnerabilities. |

## Residual gates and limitations

The following items intentionally keep `SECURITY_01` and Public Release unverified:

- No unique release canary has yet been driven through every Agent, API, error, diagnostic, export, browser artifact, SQLite audit and Temp path. The current tests prove redaction behavior, not complete artifact coverage.
- Python and Rust dependency audits could not run because `pip-audit` and `cargo-audit` are unavailable. npm coverage is not a substitute for those ecosystems.
- A complete logging/PII data-flow inventory has not yet been completed. A few internal exception logs and scraper/plugin diagnostics remain candidates for a second pass; the public error paths are bounded and redacted.
- Existing historical `agent_runs.steps_json` rows are not rewritten. Newly persisted Run metadata is redacted, but an old local row created before this commit may still contain its original execution arguments and needs a deliberate, user-approved scrub procedure.
- The Tauri CSP’s `https:` allowances remain broader than a strict allowlist because the product supports user-selected LLM endpoints and current MediaPipe assets. A future release must narrow this to an explicit endpoint/model allowlist or document the approved threat model.
- Diagnostic bundle completeness, `error_id` correlation, updater signing, code signing, privacy disclosure and consent outcome matrices remain unverified or external.
- Codex OAuth remains an external blocker; Pi worker protocol/lifecycle is available, but this report does not claim a live LLM provider success.
- A fake worker lifecycle left an isolated session file outside the repository under `I:\\tmp\\offeru-pi-security-smoke`; it contains no real credential. Cleanup was not forced because the available recursive-delete guard rejected the target.

## Release mapping

| Requirement | Verdict | Reason |
| --- | --- | --- |
| R50 Security Baseline | NOT_VERIFIED | Current report covers several sub-checks, but the canary, Python/Rust audit, complete PII/logging and diagnostic evidence are incomplete. |
| R51 Secrets exclusion | PARTIAL | New redaction boundary, config projection, tracked scan and Agent Run canary-shaped tests pass; historical rows and complete artifacts are not scrubbed/proven. |
| R52 Canary Secret Test | NOT_VERIFIED | Full release canary protocol has not been executed across all artifacts. |
| R53 PII Logging | NOT_VERIFIED | Reviewed paths are hardened, but no complete repository/runtime data-flow inventory is signed off. |
| R54 Tauri Security | PASS | Current capabilities contain only `core:default`; CSP is non-null and restrictive at the baseline level; `cargo check` passes. |
| R55 Dependency Gate | NOT_VERIFIED | Agent-runtime, frontend and extension npm audits pass; Python/Rust audit tools were unavailable. |
| R56 Structured Observability | NOT_VERIFIED | Run/Task/Audit records exist, but a current full schema/correlation audit is not complete. |
| R57 Error Correlation | NOT_VERIFIED | Bounded errors are present, but end-to-end `error_id` evidence is not complete. |
| R58 Diagnostic Bundle | NOT_VERIFIED | Existing diagnostics are not yet proven against the full secret/PII/correlation contract. |
| R89 Update Signing | NOT_VERIFIED | Updater release artifacts are not enabled and signed evidence is absent. |
| R90 Code Signing | BLOCKED_EXTERNAL | Requires the owner’s legitimate platform certificate/credentials after release artifacts are ready. |
| R98 Privacy Disclosure | NOT_VERIFIED | Final UI/data-flow disclosure is not complete. |
| R99 Consent | NOT_VERIFIED | Email/microphone/camera/external model consent outcome matrix is not complete. |

## Next autonomous work

1. Extend the deterministic isolated release-canary harness from durable Agent Run/Audit/export paths to the remaining API, browser artifact and diagnostic bundle surfaces without touching the normal user database.
2. Complete the logging/PII inventory and diagnostic `error_id` correlation audit; patch only confirmed leaks.
3. Re-run the security suite, then proceed to the next highest unverified Public Release domain: Reliability.

## Machine-readable summary

```json
{
  "report_schema": "offeru-eval-report/1.0",
  "suite_id": "offeru-core-v1",
  "suite_version": "1.0.0",
  "run_id": "security-01",
  "target_scope": "security-baseline",
  "evidence_date": "2026-08-31",
  "commit": "7529c59",
  "verdict": "PARTIAL",
  "public_release": "NOT_READY",
  "passed_security_subchecks": [
    "redaction_unit_and_control_plane_regression",
    "npm_audits_agent_runtime_frontend_extension",
    "tauri_capability_and_csp_baseline",
    "cors_and_security_headers",
    "pi_worker_probe_and_lifecycle_smoke",
    "tracked_secret_scan",
    "agent_run_new_metadata_redaction",
    "isolated_durable_release_canary"
  ],
  "not_verified": [
    "full_release_canary",
    "python_dependency_audit",
    "rust_dependency_audit",
    "complete_logging_pii_inventory",
    "diagnostic_bundle_error_correlation",
    "historical_agent_run_scrub",
    "privacy_disclosure_and_consent",
    "updater_signing"
  ],
  "blocked_external": ["codex_oauth", "code_signing_certificate"],
  "recommended_decision": "continue-security-residual-gates"
}
```
