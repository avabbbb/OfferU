# OfferU Handoff

Updated: 2026-09-25

Read these first:

1. docs/product/current-product.md
2. docs/product/entry-onboarding-and-dogfood.md
3. docs/product/proactive-career-director.md
4. STATUS.md
5. CONTEXT.md
6. ARCHITECTURE.md
7. docs/evals/LIVE_EVAL.md

Do **not** continue from closed feature branches or historical Harness designs.

## Current main direction

~~~
Normal user                         Power user
OfferU Desktop                     external Agent
      │                                │
      └────── OfferU Skill / tools ────┘
                       ↓
              Operation Registry
                       ↓
              Career Runtime
                       ↓
              Career Truth
                       ↓
            canonical Job Workspace
~~~

## Current checkpoint

PR #29 has been merged. Its validated Build & Release run passed the deterministic upstream and downstream gates, including backend/frontend/extension, browser/migration/recovery, critical new-user repeatability, macOS arm64/x64 package, Windows package and installed-app smoke.

The next product task is **not another broad feature sprint**.

Owner dogfood has now identified the first high-value product slice: **runtime proactivity**.

OfferU already has durable Automation, CareerTask, Skill and Operation infrastructure. The missing product behavior is a bounded Career Director that interprets Career State and proactively decides what deserves attention, while preserving the existing permission/truth boundaries.

## Continue from here

1. Use current main with a dedicated dogfood data directory.
2. Start with Codex as the first Agent.
3. Import the owner’s real Resume and review Profile evidence.
4. Use three real Jobs.
5. Exercise:
   - Job evaluation;
   - pre-application decision;
   - Evidence gaps;
   - Resume proposal;
   - Desktop proposal approve/reject;
   - PDF export;
   - Pipeline/Today continuation;
   - restart/persistence.
6. Record every point where the owner has to tell the Agent an obvious next action.
7. Implement only the first Proactive Career Director vertical slice defined in the current design:
   - First-run Profile Discovery;
   - Daily Career Brief;
   - Job-saved Assessment Plan;
   - Interview Prep / Debrief;
   - Resume-updated Re-engagement Review.
8. Evaluate whether user-directed task rate falls without increasing duplicate/irrelevant reminders or autonomy violations.

Do not let the blocked OMP isolation requirement stop Codex-first owner dogfood. The OMP/SWE-2 Golden Path remains a separate acceptance workstream and needs an approved isolated environment before pass³.

## First-use product contract

Normal users should eventually need only:

~~~text
download OfferU
→ install
→ open
→ OfferU finds an existing supported Agent
→ OfferU prepares its Skill where supported
→ Resume
→ Job
→ useful Job Workspace
~~~

No Python, Node, Git, MCP or manual Skill-folder work is acceptable in the public beginner path.

The current development/internal path may still rely on a prepared development environment; this is acceptable for owner dogfood but not a Public Release claim.

## Non-negotiable boundaries

- Career Runtime owns truth.
- App-first and Skill-first converge on the same canonical Job Workspace.
- Agent Skills are entry/methodology layers, not a second database.
- Agent cannot self-confirm protected mutations.
- Application submit / recruiter contact remain user-controlled.
- AI memory and third-party Skill output enter as candidate/evidence, not automatic Career Truth.
- Do not add another top-level product surface until dogfood proves a real need.
- Do not implement proactivity as a second infinite Agent loop. Runtime triggers are deterministic; Career Director reasoning is bounded; all execution remains behind CareerTask / Operation Registry / Proposal.
- Campus and experienced-hire users must use different first-party Strategy Packs; do not solve this with one generic prompt or a fixed daily-application number.
- Scripted bootstrap/health logic must never masquerade as career judgment.

## Documentation rule

Product interaction changes update current-product.md first. This handoff only describes the current continuation point.
