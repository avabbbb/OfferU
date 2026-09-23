# OfferU Status

Updated: 2026-09-23

## Verdict

~~~
OFFERU_PUBLIC_RELEASE_NOT_READY
~~~

OfferU has converged on a local-first Career OS with a guided desktop experience, external-local-Agent-first reasoning, a shared Operation Registry, and evidence-backed Career Truth.

## Current phase

~~~
VALIDATE_ZERO_SETUP_AND_AGENT_NATIVE_MAIN
~~~

Current product authority: [docs/product/current-product.md](./docs/product/current-product.md).

## Recently landed

- #14 Assisted Apply / ApplicationActionConnector foundation.
- #17 Tool Surface V2: Registry breadth is separated from Agent-facing and active-Skill surfaces.
- #19 Guided Today + composable local Career Skills.
- Canonical Job Workspace / App-first + Skill-first documentation and AGENTS.md constraints are on main.
- Real OMP RPC Eval implementation is now on main, including protocol-v2 framing, model/session identity capture, fail-closed command policy, trusted-execution artifacts and focused tests. The old #16 branch is superseded/closed.
- Zero-Setup onboarding implementation is on main: Agent readiness, Resume → Profile bootstrap, optional permissioned AI-memory import, first Job handoff, optional email connection and Today handoff.
- macOS Tauri packaging foundation is on main for arm64/x64, with sidecar build, app/DMG workflow and package smoke tooling.

## Active validation

- AGENT_NATIVE_E2E is still NOT_RUN: current main has the harness, but no authenticated OS-isolated live OMP/SWE-2 trace + trusted business outcome + human-visible HITL evidence has been accepted yet.
- Zero-Setup implementation has code and focused tests, but the implementation record explicitly says runtime/build/browser/clean-install acceptance is pending.
- macOS packaging code exists, but signed/notarized artifact, clean-machine install, migration/backup/restore and upgrade evidence are still pending.
- Current main CI must be green before any new capability claim. Product code landed faster than release evidence.

## Current product gates

| Area | State | Current meaning |
| --- | --- | --- |
| Career Truth / Registry | STRONG | Shared truth, proposal/HITL and audit remain the core invariant |
| Agent Tool Surface | IMPLEMENTED / VALIDATING | OMP RPC path is on main; live Agent-native acceptance remains NOT_RUN |
| Guided Today | MERGED / EARLY | Next Best Action slice exists; real-user policy needs iteration |
| Local Agent ecosystem | PARTIAL | Multiple hosts are discoverable; readiness/auth/live verification varies by host |
| Zero-Setup onboarding | IMPLEMENTED / NOT ACCEPTED | New App-first flow exists; real first-run journey still needs runtime/browser validation |
| macOS package | IMPLEMENTED / NOT ACCEPTED | app/DMG pipeline exists; signed/notarized clean-machine proof is pending |
| Browser Job Capture | PARTIAL | User-triggered capture exists; consumer distribution/live-site compatibility still need polish |
| Smart Fill | PARTIAL | Safe-fill boundary exists; broad live ATS verification remains incomplete |
| Email progress sync | PARTIAL/STRONG BACKEND | Read-only sync and onboarding connection UI exist; real inbox journey needs validation |
| Profile from Resume | IMPLEMENTED / VALIDATING | Onboarding bootstrap exists; real resume first-run acceptance is pending |
| Local Agent memory → Profile | INITIAL SLICE / VALIDATING | Explicit Codex memory-summary preview/import is permissioned and evidence-gated; broader host support is not yet a claim |
| Public Release | NOT READY | release gates, signed installers, clean-machine acceptance and real-user evidence still required |

## Current priorities

1. Make current main green: backend tests + release audits, frontend typecheck/tests/build, RustSec, extension checks and downstream browser/release jobs.
2. Run the real Agent-native Golden Path on current main: authenticated OMP/SWE-2, verified model identity, model-issued tool events, trusted OperationAuditLog/outcome, human approval, rejection path, OS isolation, then fresh-state pass^3.
3. Validate one complete Zero-Setup first run: clean state → ready Agent → real Resume → reviewed Profile → first captured/saved Job → canonical Job Workspace → optional read-only inbox → useful Today. No terminal/manual DB shortcuts.
4. Validate macOS packaging on real machines: arm64 first, then x64; sidecar startup, app-data isolation, keychain, shutdown/restart, signing/notarization, clean install, upgrade, migration and backup/restore.
5. Only after those traces exist, use failures to decide the next product/code slice. Do not add more top-level features or compress the tool surface from intuition alone.

## Historical status

Previous detailed status snapshots are preserved under docs/archive/. They are evidence for their date, not current architecture authority.
