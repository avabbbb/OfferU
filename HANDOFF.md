# OfferU Handoff

Updated: 2026-09-23

Read these first:

1. docs/product/current-product.md
2. CONTEXT.md
3. ARCHITECTURE.md
4. STATUS.md
5. docs/architecture/2026-09-22-tool-surface-v2.md

Do **not** use archived DSH/Pi/Main-Agent designs as current product authority.

## Current main direction

OfferU is a local-first Career OS for non-technical job seekers.

~~~
OfferU Desktop / Guided UX
→ external local Agent preferred, built-in fallback allowed
→ OfferU Skill + optional third-party Career Skills
→ Agent Tool Surface
→ Operation Registry / Proposal / Audit
→ Career Runtime / Career Truth
~~~

## Recently completed

- #14 Assisted Apply / connector foundation
- #17 Tool Surface V2
- #19 Guided Next Best Actions + Skill composition contract

## Active branch / PR to continue

- #16 Real OMP RPC Eval — Draft. Use it to validate autonomous tool discovery and real task completion before further Tool Surface compression.

## Next product milestone

Zero-Setup Golden Path:

~~~
native install
→ auto-detect a ready local Agent
→ Resume + explicitly authorized memory → Profile T0
→ user-triggered browser capture of first Job
→ optional read-only inbox connection
→ useful Today / Next Best Action
~~~

## Non-negotiable boundaries

- Career Runtime owns truth.
- Protected writes remain behind Registry / Proposal / user review.
- Third-party Skills are methodology/drafting layers, not truth or permission authorities.
- Browser capture is user-triggered by default; no beginner background crawler.
- Smart Fill never silently performs final submit.
- Email creates progress candidates before formal stage changes.
- Do not add a second Agent loop or second business backend just to support another host.
- Do not optimize Tool count without real Eval evidence.

## Documentation rule

If a document conflicts with the current Product North Star, CONTEXT or ARCHITECTURE, archive the old document rather than creating another numbered decision layer.

Previous handoff preserved at docs/archive/HANDOFF-2026-09-17.md.