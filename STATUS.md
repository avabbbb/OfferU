# OfferU Status

Updated: 2026-09-26

## Verdict

~~~
OFFERU_PUBLIC_RELEASE_NOT_READY
PROACTIVE_CAREER_DIRECTOR_IMPLEMENTATION_IN_PROGRESS
~~~

Public distribution still has separate signing, notarization, clean-machine and live external-evidence gates. Owner dogfood for this proactive milestone begins after its implementation Definition of Done; coding continues now against synthetic isolated fixtures.

## Current phase

~~~
PROACTIVE_CAREER_DIRECTOR_IMPLEMENTATION
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

The accepted next product slice is the bounded [Proactive Career Director](./docs/product/proactive-career-director.md): event-triggered career-state judgment, campus/experienced Strategy Packs, proactive Profile discovery, Daily/Weekly briefing, interview lifecycle and Resume re-engagement — without introducing a second infinite Agent loop.

Implementation uses synthetic fixtures and isolated test databases. First-run Profile Discovery is committed as `73c522e`; Daily Career Brief is implemented locally with Today-triggered idempotency, read-only daily context, CareerTask/Inbox projection and dismissal feedback. Job Saved Assessment, Interview Prep/Debrief and Resume Re-engagement remain the next implementation slices. Do not wait for real Resume/Profile/Job data before completing those slices; owner dogfood follows implementation and full regression.

## Active validation

- Real OMP/SWE-2 Agent-native acceptance remains NOT_RUN because the current local machine lacks the approved isolated GUI/runtime environment. This does not block implementation; after the implementation DoD, Codex-first owner dogfood can proceed while OMP pass³ stays a separate evidence gate.
- Codex is the recommended first dogfood Agent because it has the strongest beginner integration path: detection, Skill installation/update, native login check and live integration verification.
- Zero-Setup still needs one genuine real-user first-run trace with real Resume + real Job rather than only automated/replay evidence.
- Public macOS/Windows release still needs legitimate signing/notarization and clean-machine acceptance.
- Live Role Intelligence, external application execution, contact search, market/policy calibration and legal conclusions remain capability-limited and must not be treated as guaranteed beginner functionality.

## Current priorities

1. Implement Slice 3, Job Saved Assessment Plan, through the existing Automation/CareerTask/Registry path.
2. Implement Slice 4, proactive Interview Prep and post-interview Debrief.
3. Implement Slice 5, Resume Updated Re-engagement candidates with dedupe and no external sends.
4. Run the relevant backend/frontend tests, then full backend regression and frontend production build; sync docs and verify no synthetic artifacts or real-data copies were committed.
5. Only after the implementation Definition of Done, begin owner dogfood with a real Resume and three real Jobs.
6. Keep OMP/SWE-2 isolation and public-release signing/clean-machine evidence as separate external gates.

## Product boundaries during dogfood

Current native/strong surfaces include Profile/Evidence, Job evaluation and comparison, pre-application decision, Resume tailoring/export, cover-letter/application-email drafting, tracking/follow-up, governed research/Role Intelligence when provider evidence exists, interview preparation/practice/debrief, memory review, and career pattern/gap analysis.

Partial surfaces include job-source crawling, external application execution, contact discovery, live employer-reputation research, market/policy calibration and legal Offer interpretation.

Safety boundaries remain absolute: no silent submit, no automatic recruiter/email send, no Agent self-confirm, no direct DB writes and no unreviewed inference promoted to Career Truth.

## Historical status

Previous detailed status snapshots are preserved under docs/archive/. They are evidence for their date, not current architecture authority.
