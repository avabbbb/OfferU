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

## Closure pass (2026-09-17)

| Item | Before | After |
| --- | --- | --- |
| Backend test suite | "52/52 relevant" (subset) | **621 passed, 9 skipped, 0 failed** (full `pytest tests/ -q`, 3m42s) |
| OpenAPI codegen | Generated file existed, not wired | **8 endpoints wired** (`Schemas`/`Ops` for request bodies + query params); response types stay hand-written (FastAPI emits `unknown` for most response bodies) |
| Job-preparation progress | Static text in "Next preparation" card | **Dynamic checklist** driven by `CareerTask.progress.stage` + `preApplication.stage` + `resumeProposal` presence; retry button on failed tasks |
| Demo media | Placeholder static-frame GIF | **Real recorded WebM→GIF** (13.5s, 6.4MB, real click-through on showcase workspace) |

## History

Slice-by-slice execution log (Aug 28 – Sep 16) preserved in `docs/archive/STATUS-history-2026-09.md`.
