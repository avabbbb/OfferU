# OfferU Status

Updated: 2026-09-27

## Verdict

~~~
OFFERU_PUBLIC_RELEASE_NOT_READY
PROACTIVE_CAREER_DIRECTOR_IMPLEMENTED
LIVE_CODEX_TURN_COMPLETION_BLOCKED_EXTERNAL
~~~

Public distribution still has separate signing, notarization, clean-machine and live external-evidence gates. The five proactive implementation slices are complete and locally regression-tested with isolated synthetic fixtures. One live Codex turn-completion gate remains blocked after two model-issued Registry reads completed successfully but the app-server did not emit a completed turn within 360 seconds.

## Current phase

~~~
PROACTIVE_CAREER_DIRECTOR_IMPLEMENTED
~~~

Current product authority: [docs/product/current-product.md](./docs/product/current-product.md).  
First-use/dogfood contract: [docs/product/entry-onboarding-and-dogfood.md](./docs/product/entry-onboarding-and-dogfood.md).

## Recently landed

- #29 merged: deterministic Build & Release branch validation is green.
- Backend, frontend, browser extension, migration/recovery smoke, 10/10 critical new-user browser repeatability, macOS arm64/x64 packaging, Windows packaging and installed-app smoke all passed on the validated #29 head.
- Agent proposal/HITL is now visible in Desktop through per-action Pending Proposal Review with approve/reject.
- Canonical Job Workspace, App-first / Skill-first product model, Zero-Setup onboarding and current Skill Registry remain the product baseline.

## What this means

For **owner dogfood**, do not wait for Public Release completion.

Start with:

~~~text
OfferU Desktop
→ recommended verified Agent (Codex first)
→ real Resume
→ reviewed Profile
→ real Job
→ Job Workspace
→ Agent read
→ governed proposal
→ approve / reject / edit
→ export / track
→ restart and continue
~~~

Use a dedicated dogfood data directory. Automated destructive tests must never run against the owner’s real dogfood database.

## Primary dogfood finding

The first owner-dogfood review identified a product-level autonomy gap: OfferU has a broad Skill/Operation surface and durable Automation infrastructure, but normal users still need to know what to ask too often.

The accepted product slice is the bounded [Proactive Career Director](./docs/product/proactive-career-director.md): event-triggered career-state judgment, campus/experienced Strategy Packs, proactive Profile discovery, Daily/Weekly briefing, interview lifecycle and Resume re-engagement — without introducing a second infinite Agent loop.

Implementation uses synthetic fixtures and isolated test databases. First-run Profile Discovery is committed as `73c522e`; Daily Career Brief as `bb2fb36`; Job Saved Assessment as `d3508c8`; Interview Prep/Debrief and Resume Re-engagement are implemented in the current proactive branch. Resume updates with added evidence enqueue an idempotent `RESUME_UPDATED` event in the same transaction as the canonical ResumeVersion. A bounded Codex Career Director reads Resume, application and Job evidence through the Registry; validated candidates materialize in Today, Inbox and the canonical Job Workspace without direct Career Truth writes or external contact. Do not wait for real Resume/Profile/Job data before coding. Owner dogfood follows final validation.

Interview Prep/Debrief and Resume Updated Re-engagement are implemented with synthetic fixtures. Resume candidate generation uses the current Resume version pointer, only the newest application attempt per Job, active/non-terminal state, a wait window, evidence-reference validation and pending-suggestion dedupe. A candidate is displayed for owner review only; no send/contact capability is available.

## Active validation

- Full backend regression: **812 passed, 10 skipped, 11 subtests passed** (`OFFERU_TEST_TEMP_ROOT=H:\tmp\offeru\career-director-final-backend-rerun2-20260927`).
- Frontend regression: **50 passed across 18 files**; `npm run typecheck` and `npm run build` passed.
- Local Codex 0.155.1 Career Director smoke used only synthetic Career data in `H:\tmp\offeru\career-director-codex-agent-smoke-20260927\smoke.sqlite`. Codex issued `get_career_snapshot` and `get_resume_reengagement_context`; both Registry audit rows completed. No `turn/completed` arrived within 360 seconds, so no final briefing or delivery was materialized and the CareerTask failed with `codex turn did not complete`. The generated local 0.155.1 protocol types confirm the adapter's dynamic-tool response shape. This is recorded as **BLOCKED_EXTERNAL / NOT PASSED** pending a completed live turn; it is not a synthetic test pass.
- Real OMP/SWE-2 Agent-native acceptance remains NOT_RUN and separate from this coding milestone.
- Zero-Setup still needs one genuine real-user first-run trace with a real Resume and Job.
- Public macOS/Windows release still needs legitimate signing/notarization and clean-machine acceptance.
- Live Role Intelligence, external application execution, contact search, market/policy calibration and legal conclusions remain capability-limited and must not be treated as guaranteed beginner functionality.

## Current priorities

1. Investigate why the local Codex app-server does not complete a Career Director turn after returning successful dynamic-tool responses; preserve the Registry protocol and HITL boundaries.
2. Begin owner dogfood with a real Resume and three real Jobs using a dedicated data directory; evaluate the UI path while treating live turn completion as unresolved.
3. Keep OMP/SWE-2 isolation and public-release signing/clean-machine evidence as separate gates.

## Product boundaries during dogfood

Current native/strong surfaces include Profile/Evidence, Job evaluation and comparison, pre-application decision, Resume tailoring/export, cover-letter/application-email drafting, tracking/follow-up, governed research/Role Intelligence when provider evidence exists, interview preparation/practice/debrief, memory review, and career pattern/gap analysis.

Partial surfaces include job-source crawling, external application execution, contact discovery, live employer-reputation research, market/policy calibration and legal Offer interpretation.

Safety boundaries remain absolute: no silent submit, no automatic recruiter/email send, no Agent self-confirm, no direct DB writes and no unreviewed inference promoted to Career Truth.

## Historical status

Previous detailed status snapshots are preserved under docs/archive/. They are evidence for their date, not current architecture authority.
