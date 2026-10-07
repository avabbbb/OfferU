> **已归档（2026-10）**：本文不再是当前权威。当前文档：RELEASE_CHECKLIST.md、KNOWN_ISSUES.md（实时状态）（位于 `docs/`）。

# OfferU Handoff

Status: **CURRENT CONTINUATION INDEX**
Updated: 2026-10-06

## Read first

1. [AGENTS.md](./AGENTS.md), including delivery, blocking and three-local-branch rules.
2. [GOAL.md](./GOAL.md) and [current product](./docs/product/current-product.md).
3. [CONTEXT.md](./CONTEXT.md), [current decisions](./docs/adr/README.md), [ARCHITECTURE.md](./ARCHITECTURE.md).
4. [STATUS.md](./STATUS.md), [main-readiness review](./docs/evals/reports/2026-10-05-main-readiness-review.md) and the relevant live code.
5. [Development history](./docs/history/development-history.md) only when historical rationale is needed.

## Current source boundaries

Current main is `c58c069`; active development is solely `fix/main-ci-green` (implementation checkpoint `8a28e54`). Earlier dirty UX/review work is preserved in `stash@{0}` (`pre-sync-offeru-2026-10-06`) and a restore-verified Git archive. Do not apply that stash wholesale or resume implementation in old worktrees. Re-check live HEAD, status and artifact identities before acceptance.

Proposal v2 integration is already in main. The current task migrates obsolete CI contracts, fixes demonstrated product/security regressions and preserves independent authorization, source versions and receipts. Do not restore action-level approval or create parallel approval authorities. The older review below is historical context, not an instruction to merge the old integration branch again.

## Immediate delivery work

- Finish the full Backend regression and publish the single CI repair PR; frontend tests/typecheck/build already pass, while dependency audit remains blocked on unpatched `braces`.
- Keep main unchanged until the candidate is reviewed. Source/fixture checks do not prove the running EXE contains these changes or that a real owner journey passes.

### Historical delivery checklist — 2026-10-05

- The independent documentation slice is ready for its link/archive checks and review; bilingual summaries are in the main-readiness report.
- Model discovery has scoped automatic evidence but a keyless-request compatibility change; complete that slice before claiming it ready.
- Verify Optimize streaming against actual Registry execution and progressive event delivery.
- Reconcile decision storage/execution/entrypoints, then validate the complete Resume review → Registry → Receipt → original Run continuation → restart chain.
- Preserve all existing business/security gates; record simulated, real-model, native-human and installer results independently.

## Branches and recovery

Keep only main, current development and current integration as local named branches. Other worker/experiment commits are archived; their old worktrees remain detached with files preserved. See [branch inventory and recovery](./docs/agents/branch-consolidation-20261005.md). Use detached worktrees for isolated review; do not silently recreate retired branches.

## Historical checkpoint

The September 27 handoff is preserved [here](./docs/archive/checkpoints/2026-09-27-HANDOFF.md). Its active branch, old main SHA, startup commands and regression totals belong to that checkpoint and do not prescribe the current installed-product workflow.
