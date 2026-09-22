# OfferU Status

Updated: 2026-09-23

## Verdict

~~~
OFFERU_PUBLIC_RELEASE_NOT_READY
~~~

OfferU has converged on a local-first Career OS with a guided desktop experience, external-local-Agent-first reasoning, a shared Operation Registry, and evidence-backed Career Truth.

## Current phase

~~~
ZERO_SETUP_AND_AGENT_NATIVE_PRODUCTIZATION
~~~

Current product authority: [docs/product/current-product.md](./docs/product/current-product.md).

## Recently landed

- #14 Assisted Apply / ApplicationActionConnector foundation merged to main.
- #17 Tool Surface V2 merged: Registry breadth is separated from Agent-facing and active-Skill surfaces.
- #19 Guided Today + composable local Career Skills merged: Today can surface up to three Next Best Actions; OfferU Skill may safely compose with third-party resume/recruiting/interview Skills.
- Documentation authority reset: old DSH/Pi/Main-Agent architecture has been archived and removed from the default Agent reading path.

## Active work

- #16 Real OMP RPC Eval remains Draft and is the current path for validating real external-Agent tool use.
- Zero-Setup consumer flow is the next product milestone: native installer → Agent auto-discovery → Profile bootstrap → first Job → inbox → useful Today.
- Tool Surface V2 should be optimized further only from real Agent traces, not by arbitrary tool-count targets.

## Current product gates

| Area | State | Current meaning |
| --- | --- | --- |
| Career Truth / Registry | STRONG | Shared truth, proposal/HITL and audit remain the core invariant |
| Agent Tool Surface | MERGED / VALIDATING | Progressive disclosure is implemented; real OMP/SWE-2 eval is still being validated |
| Guided Today | MERGED / EARLY | First Next Best Action slice is in main; broader policy still needs real-user iteration |
| Local Agent ecosystem | PARTIAL | Multiple hosts are discoverable; readiness/auth/live verification varies by host |
| Zero-Setup installer | PARTIAL | Desktop/sidecar foundations exist; clean-machine consumer install and macOS parity still need release proof |
| Browser Job Capture | PARTIAL | User-triggered capture exists; consumer distribution/live-site compatibility still need polish |
| Smart Fill | PARTIAL | Safe-fill boundary exists; broad live ATS verification remains incomplete |
| Email progress sync | PARTIAL/STRONG BACKEND | Read-only sync, classification and progress candidates exist; beginner setup/review UX needs validation |
| Profile from Resume | PARTIAL/STRONG BACKEND | Core primitives exist; onboarding consolidation remains |
| Local Agent memory → Profile | PARTIAL | Import/distill primitives exist; safe discovery/permission/merge UX remains |
| Public Release | NOT READY | signed installer, clean-machine acceptance, remaining privacy/security/reliability gates still required |

## Current priorities

1. Finish and validate the real external-Agent Eval path (#16).
2. Build the Zero-Setup onboarding state machine without adding another parallel truth store.
3. Validate first-run with a real Resume, a real captured Job and a real read-only mailbox.
4. Use Eval traces to find capability gaps / wrong-tool selection before changing the 112-tool Agent surface again.
5. Keep documentation authority lean; archive snapshots instead of turning them into current specs.

## Historical status

Previous detailed status snapshots are preserved under docs/archive/. They are evidence for their date, not current architecture authority.