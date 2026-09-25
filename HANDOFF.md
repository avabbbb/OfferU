# OfferU Handoff

Updated: 2026-09-25

Read these first:

1. docs/product/current-product.md
2. docs/product/entry-onboarding-and-dogfood.md
3. STATUS.md
4. CONTEXT.md
5. ARCHITECTURE.md
6. docs/evals/LIVE_EVAL.md

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

It is owner dogfood.

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
6. Record escape points where the owner returns to another tool.
7. Turn the highest-value escape point into the next product slice.

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

## Documentation rule

Product interaction changes update current-product.md first. This handoff only describes the current continuation point.
