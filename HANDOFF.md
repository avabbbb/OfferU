# OfferU Handoff

Updated: 2026-09-23

Read these first:

1. docs/product/current-product.md
2. CONTEXT.md
3. ARCHITECTURE.md
4. STATUS.md
5. docs/evals/LIVE_EVAL.md

Do **not** use archived DSH/Pi/Main-Agent designs or closed PR branches as current product authority.

## Current main direction

OfferU is a local-first Career OS for non-technical job seekers.

~~~
App-first OfferU Desktop / Skill-first external Agent
                ↓
          same OfferU Skill
                ↓
        Agent Tool Surface
                ↓
Operation Registry / Proposal / Audit
                ↓
     Career Runtime / Career Truth
                ↓
       canonical Job Workspace
~~~

## Recently completed on main

- Assisted Apply / connector foundation
- Tool Surface V2
- Guided Next Best Actions + Skill composition contract
- Job Workspace + dual-entry product authority
- hardened AGENTS.md implementation rules
- real OMP RPC Eval implementation (old #16 is superseded and closed)
- Zero-Setup onboarding implementation
- permissioned Codex memory-summary → reviewable memory candidates
- macOS desktop packaging foundation

## Current continuation point

Do **not** continue from an old feature branch.

Continue from current main and validate what already landed.

Highest-value sequence:

1. CI/release-audit green on current main.
2. Real OMP/SWE-2 Agent-native Golden Path with trusted trace + visible HITL + pass^3.
3. Clean Zero-Setup first-run acceptance with a real Resume and real Job.
4. macOS arm64/x64 package and clean-machine acceptance.
5. Update STATUS / QUALITY_SCORE / RELEASE_CHECKLIST from evidence, then choose the next implementation slice.

## Non-negotiable boundaries

- Career Runtime owns truth.
- Skill-first and App-first must resolve to the same canonical Job Workspace / Profile / Pipeline state.
- Protected writes remain behind Registry / Proposal / human review.
- Third-party Skills are methodology/drafting layers, not truth or permission authorities.
- Browser capture is user-triggered by default; no beginner background crawler.
- Smart Fill never silently performs final submit.
- Email creates progress candidates before formal stage changes.
- Local Agent memory is explicitly authorized input and enters as candidate/hypothesis, never automatic verified truth.
- Do not add a second Agent loop or second business backend just to support another host.
- Do not optimize tool count without real Eval evidence.
- Do not treat implemented packaging/onboarding as release-ready without clean-machine runtime evidence.

## Documentation rule

If a document conflicts with the current Product North Star, CONTEXT or ARCHITECTURE, archive the old document rather than creating another numbered decision layer.

Previous handoff preserved at docs/archive/HANDOFF-2026-09-17.md.
