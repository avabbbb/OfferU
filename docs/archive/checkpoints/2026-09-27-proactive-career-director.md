# Proactive Career Director — historical checkpoint

Status: **HISTORICAL SNAPSHOT / DISTILLED**
Checkpoint: 2026-09-27
Distilled: 2026-10-02

This preserves the useful conclusions of the old Status, Handoff and dated product implementation updates. It is not a current implementation or owner-acceptance verdict.

## What was established then

- Five bounded slices had implementation: Profile Discovery, Daily Career Brief, Job Saved Assessment, Interview Prep/Debrief and Resume Updated re-engagement.
- They used the single `AutomationEvent → AutomationRule → CareerTask → Agent / Runtime → Operation Registry` path. Profile learning and re-engagement remained review candidates; no automatic external contact was claimed.
- Identified slice commits: `73c522e` (Profile Discovery), `bb2fb36` (Daily Brief), `d3508c8` (Job Saved Assessment).
- The then-active branch was `feat/proactive-career-director`; the recorded `origin/main` was `84b8255`. These are historical references, not instructions to switch branches.

## Evidence and limits

- The recorded backend regression was **813 passed, 10 skipped, 11 subtests passed**; the product follow-up also recorded 20 warnings. Frontend was **50 passed across 18 files**, with typecheck and production build passing.
- Codex 0.155.1 completed one isolated synthetic Profile Discovery task, issued `get_career_snapshot`, returned a validated briefing, and completed CareerTask/AutomationEvent. It changed no Profile truth, created no Proposal and performed no external action.
- Explicit `low` reasoning completed that bounded scenario; inherited effort and explicit `medium` had timed out. This observation does not establish a general model-effort policy or current Provider compatibility.
- Other event slices were covered by synthetic integration tests. Real OMP/SWE-2 acceptance, a real-user first-run Resume/Job journey, signing/notarization and clean-machine release acceptance remained unverified.
- The two-terminal Python/Vite startup instructions described a source-development path, not normal Desktop installation or current packaged-application acceptance.

## Why the checkpoint left the current entrance

S0 now checks false completion, resource linkage, owned-process shutdown, clean reset and build identity before S1 uses a real Provider and Resume. The older smoke cannot prove these new gates. Older test counts must not be used to report today's checkout as passing.

The product contract and single Career Truth / Registry boundaries remain valid. Their implementation and owner acceptance must be checked separately against current code and reproducible evidence.

## Original sources

The complete original text is retained in Git at `588d86082e99323da15fb5dd584916d3d938471a`:

- [STATUS.md](https://github.com/avabbbb/OfferU/blob/588d86082e99323da15fb5dd584916d3d938471a/STATUS.md)
- [HANDOFF.md](https://github.com/avabbbb/OfferU/blob/588d86082e99323da15fb5dd584916d3d938471a/HANDOFF.md)
- [Proactive Career Director, dated implementation updates](https://github.com/avabbbb/OfferU/blob/588d86082e99323da15fb5dd584916d3d938471a/docs/product/proactive-career-director.md)
- [Current Product, old active-validation checkpoint](https://github.com/avabbbb/OfferU/blob/588d86082e99323da15fb5dd584916d3d938471a/docs/product/current-product.md)

Current entrances: [Status](../../../STATUS.md), [Handoff](../../../HANDOFF.md), [documentation authority](../../README.md).
