> **HISTORICAL SNAPSHOT** — archived from STATUS.md before the 2026-09-23 documentation authority reset.

# OfferU Status

Updated: 2026-09-17

## Verdict

```text
OFFERU_PUBLIC_RELEASE_NOT_READY
```

Internal Beta quality bar is largely met; Public Release still requires signed installer, live external Role Intelligence, real Gmail OAuth, clean-machine verification, and the remaining security/privacy residuals.

## Current phase

```text
AUTONOMOUS_PRODUCTION_READINESS
```

Ports: frontend `http://127.0.0.1:7410`, backend `http://127.0.0.1:8766`. The optional local llama.cpp endpoint `8080` is never a web entry point.

## Gate dashboard

| Gate | Status | Notes |
| --- | --- | --- |
| Core Product | PARTIAL | 10/10 composite, 50/50 first-run, interview learning smoke pass; lacks independent stranger acceptance |
| Data Safety | PASS | R43–R49, R76 covered |
| Security | PARTIAL | 3 legacy email bodies, artifact/PII scrub, retention policy, real OAuth, code signing remain |
| Reliability | PARTIAL | 100-cycle worker, RSS threshold, dual-process claim, retry/restart contracts pass; full matrix missing |
| Architecture / Control | PARTIAL | Static audit 0 findings; dynamic browser/legacy runtime audit and remote CI missing |
| Packaging | PARTIAL | Tauri bundle, sidecar, install lifecycle pass; installer unsigned, upgrade/clean-machine unverified |
| Live Runtime | PASS (staged) | Packaged Pi Agent verified in isolated config; live Role Intelligence still blocked on external provider |
| E2E | PARTIAL | Local managed-Chromium smoke passes; remote runner, clean-machine, migration matrix missing |

## Next actions

1. **Security/Privacy residual** — decide fate of 3 legacy email bodies; finish artifact/PII/retention audit.
2. **Release engineering** — signing certificate, previous-release upgrade/migration, CI runner, clean-machine UI, RC artifact.
3. **Reliability matrix** — cross-process provider/network/restart coverage.
4. **Live Role Intelligence** — configure a real provider and run the 10-role matrix; current `deepseek-v4-flash-free` returns model unavailable.

## Trust-boundary pass (2026-09-19)

`TRUST_BOUNDARY_P0_CLOSED`.  Apple-Bar adversarial review found real trust defects;
this pass closed the verified P0s.  Full report: `docs/review/apple-bar/00-SYNTHESIS.md`.

| Item | Root cause | Fix |
| --- | --- | --- |
| Test DB isolation | Tests/scripts could resolve `DATABASE_URL` → real `djm.db`; conftest had no DB guard | `conftest.py` now sets `OFFERU_DATA_DIR` → isolated tmp before any app import + fail-closed path guard; 2 scripts repointed to isolated tmp. Verified: real `djm.db` md5 unchanged across full suite |
| Studio preview SSRF | `/api/studio/resumes/{id}/preview` served `html_content` on API origin; iframe unsandboxed → generated HTML could call privileged APIs | Restrictive CSP `sandbox` (empty = no scripts/forms/popups/same-origin) + `X-Content-Type-Options` on endpoint; `sandbox=""` on `<iframe>` |
| Legacy Web Agent bypass | `routes/agent.py` held full `OPERATIONS` registry + in-memory `_PROPOSALS` + `web_agent_confirm` surface outside `_PROTECTED_AGENT_SURFACES` | File was **unmounted dead code** — deleted `routes/agent.py`; cleaned stale import/assert in `test_resume_optimization.py` |
| Resume fake-success | `_llm_rewrite_sections` failure silently returned original rows; `rewrite_applied` never reached UI | Added `rewrite_status`: `applied`/`degraded`/`skipped` through pipeline → candidate → proposal `trace` + top-level summary; jobs/[id] shows degraded banner; 2 regression tests |
| Runtime probe silent | `_probe()` swallowed `OSError`/`TimeoutError` — broken CLI indistinguishable from "not installed" | Added `probe_status` (`ready`/`not_installed`/`timeout`/`incompatible`/`error`) + sanitised `probe_error`; 3 regression tests |
| DSH ghost artifact | `integrations/dsh/dsh-home` is a dangling NTFS reparse point (undeletable, git-untracked, zero refs) | Marked DSH experimental in `integrations/dsh-README.md`; ghost entry recorded as inert residue |

Backend suite: **631 passed, 4 pre-existing failures, 9 skipped** — the 4
failures are pre-existing tech debt unrelated to this pass: `scraper.py`
intentional fallback/reaper writes flagged by `test_control_plane_global` +
release audit (infrastructure status repair, not registry bypass), and
`CURRENT_SCHEMA_VERSION=3` vs migration-test expectation of 2.  Frontend:
typecheck clean, build ok, vitest 16/16.

## Agent integration convergence (2026-09-19)

`AGENT_INTEGRATION_CONVERGED` (Phase B of the same goal).  OfferU already had the
ASu pattern — declarative Skill Registry (49 skills) + `agent_skill_projections`
(render/drift/write) + per-host manifest generation.  What was missing was the
**Host Integration vs Hosted Runtime** split and a single capability source.

| Change | Detail |
| --- | --- |
| `agent_host_registry.py` (new) | Single canonical declaration: `kind = skill_host / hosted_runtime / both`, `beginner`, `recommended`, `can_install_skill`, `runtime_id`, `unsupported_skills`, `limited_skills`, `docs_url`. 7 hosts. |
| `agent_connection.py` | `_BEGINNER_PROVIDER_IDS` + `_GUIDES` + `provider_id == "codex"` hard-coding **removed**; `beginner`/`recommended`/`docs_url`/`can_verify_login`/`can_install_skill` now read the registry |
| Host×Skill matrix | `host_capability_matrix()` → `full/limited/unsupported`; exposed in `cli manifest` so an agent self-checks instead of assuming parity. opencode research = `limited` (no controlled web adapter); hosted-only executors `application_assistant` = `unsupported` |
| Projection capability note | `_host_capability_note()` injects per-host exclusion into generated manifests; `--check` drift gate green |
| Tests | `test_agent_host_registry.py` (7): id uniqueness, runtime↔host resolution, every RUNTIME_DEFINITIONS mapped, kind/install coherence, single recommended, unsupported never projects full |

Preserved invariants: hosted runtimes keep native lifecycle protocols
(spawn/stream/cancel/resume); Career capability still converges
Skill → Bridge/CLI → Operation Registry → Career Runtime; skills stay thin
(no business logic); beginner UI output unchanged.  79 focused tests pass.

## Real-user beta wave 1 (2026-09-19)

Recon complete (11 read-only agents). Trust surface analyzed: `_PROTECTED_AGENT_SURFACES`
covers every agent-driven surface (agent/bridge/cli/mcp/pi/web_agent/optimize_agent);
HTTP user surfaces (ui/profile_api/memory_api) are intentionally outside it — they are
the human operator, and OfferU is a loopback-only local app. Gate-2 self-confirm = PASS.
Confirmed no agent-surface path lets an LLM write Career Truth without user confirmation.
Top defects queued for Wave 2: cross-channel signal dedupe, update_application_status
event bypass, Today wrong-empty-state + unbounded notifications, JobSource ext-id
collision + captured_at→posted_at, resume description fact-gate gap + multi-ready
proposals + edited_text bypass, nav/fixture/jargon beginner leaks.

## Closure pass (2026-09-17)

| Item | Before | After |
| --- | --- | --- |
| Backend test suite | "52/52 relevant" (subset) | **621 passed, 9 skipped, 0 failed** (full `pytest tests/ -q`, 3m42s) |
| OpenAPI codegen | Generated file existed, not wired | **8 endpoints wired** (`Schemas`/`Ops` for request bodies + query params); response types stay hand-written (FastAPI emits `unknown` for most response bodies) |
| Job-preparation progress | Static text in "Next preparation" card | **Dynamic checklist** driven by `CareerTask.progress.stage` + `preApplication.stage` + `resumeProposal` presence; retry button on failed tasks |
| Demo media | Placeholder static-frame GIF | **Real recorded WebM→GIF** (13.5s, 6.4MB, real click-through on showcase workspace) |

## History

Slice-by-slice execution log (Aug 28 – Sep 16) preserved in `docs/archive/STATUS-history-2026-09.md`.
