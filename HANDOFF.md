# OfferU Handoff

Updated: 2026-09-27

## Read first

1. `AGENTS.md`
2. `GOAL.md`
3. `docs/product/current-product.md`
4. `docs/product/proactive-career-director.md`
5. `docs/product/entry-onboarding-and-dogfood.md`
6. `STATUS.md`
7. `CONTEXT.md`, `ARCHITECTURE.md`, and `docs/evals/LIVE_EVAL.md`

## Current checkpoint

The active branch is `feat/proactive-career-director` at implementation commit `8c5a193`. Its cached base includes `84b8255`; the latest remote head could not be checked because `git fetch origin main` failed during TLS negotiation. Do not switch or reset this branch. All five Proactive Career Director slices are implemented through the existing `AutomationEvent → AutomationRule → CareerTask → Agent Runtime → Operation Registry` path.

- Profile Discovery and Career Stage correction are visible in Profile and Today.
- Daily Review re-evaluates bounded Career State and projects prioritized actions into Today and Inbox, with repeated-dismissal suppression.
- JOB_SAVED triggers a model-created assessment plan projected into Inbox and Job Workspace; Role Intelligence starts only when recommended.
- Interview invitation/prep and completed-interview/debrief are triggered from calendar state. Debrief answers become source-linked learning candidates pending review.
- Evidence-bearing Resume updates create idempotent re-engagement candidates for review; they cannot contact anyone.
- `career_policy.py` is enforced in the CareerTask path. The Registry-backed policy envelope constrains action keys, targets, evidence, Operations, Skills and autonomy. The final briefing is source-fingerprint checked before delivery materialization.
- Saved delivery artifacts are readable through the existing Registry-backed artifact Operation. L2/L3 mutations and external actions retain the existing Proposal/HITL boundary.

## Verification

- Full backend: **812 passed, 10 skipped, 11 subtests passed** with test data isolated under `H:\tmp\offeru\career-director-final-backend-rerun2-20260927`.
- Frontend: **50 tests passed across 18 files**; `npm run typecheck` and `npm run build` passed.
- Targeted runtime-policy/Resume and interview integration tests passed. Migration v5 is included in the full backend run.
- The extension was not modified. No real Career database or user Resume/Profile/Job was used or changed.
- `docs/evals/FINDINGS.md` retains F1/F3 as historical and records the fixture-only seed in cloned eval DBs; it does not claim a business Operation, Proposal or confirmation.

## Unresolved live gate

A local Codex 0.155.1 Career Director smoke used synthetic data at `H:\tmp\offeru\career-director-codex-agent-smoke-20260927\smoke.sqlite`. Codex made successful `get_career_snapshot` and `get_resume_reengagement_context` tool calls, and both completed Registry audit rows were recorded. The App Server did not emit `turn/completed` within 360 seconds, so the task produced no briefing or delivery. Treat this as **NOT PASSED / BLOCKED_EXTERNAL** until a live turn completes; synthetic tests do not replace that evidence. Real OMP/SWE-2 pass³ is a separate gate and was not run.

## Local dogfood startup

In a PowerShell terminal, start the backend in a dedicated persistent data directory:

~~~powershell
$env:OFFERU_DATA_DIR = 'H:\OfferU-Dogfood'
New-Item -ItemType Directory -Force -Path $env:OFFERU_DATA_DIR | Out-Null
Set-Location 'H:\WorkSpace_For_VsCode\Python\OFFERU\backend'
.\.venv312\Scripts\python.exe run_server.py
~~~

In a second terminal, start the frontend:

~~~powershell
Set-Location 'H:\WorkSpace_For_VsCode\Python\OFFERU'
npm --prefix frontend run dev
~~~

Open `http://127.0.0.1:7410`, import a Resume, review its Profile evidence, save one Job, and continue in that canonical Job Workspace. The current Codex App Server completion issue means a live Career Director result is still unverified; do not mistake the UI or mock-provider tests for a successful live judgment. This development startup path is not a Public Release installer claim.

## Non-negotiable boundaries

- Career Runtime owns Career Truth; the Operation Registry owns execution and permission; the active Agent owns reasoning.
- App-first and Skill-first converge on one Profile, Pipeline and canonical Job Workspace.
- Do not add a second infinite Agent loop or present scripted reasoning as an Agent result.
- The model cannot self-confirm protected mutations, promote unreviewed learning to verified truth, submit applications, or send/contact external parties.
- Keep automated tests and synthetic fixtures isolated under `H:\tmp\offeru`; never run destructive tests against the dogfood database.
