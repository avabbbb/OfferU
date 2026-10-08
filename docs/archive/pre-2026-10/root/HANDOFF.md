> **已归档（2026-10）**：本文不再是当前权威。当前文档：RELEASE_CHECKLIST.md、KNOWN_ISSUES.md（实时状态）（位于 `docs/`）。

# OfferU Handoff

Status: **CURRENT CONTINUATION INDEX**
Updated: 2026-10-05

## Read first

1. [AGENTS.md](./AGENTS.md), including delivery, blocking and three-local-branch rules.
2. [GOAL.md](./GOAL.md) and [current product](./docs/product/current-product.md).
3. [CONTEXT.md](./CONTEXT.md), [current decisions](./docs/adr/README.md), [ARCHITECTURE.md](./ARCHITECTURE.md).
4. [STATUS.md](./STATUS.md), [main-readiness review](./docs/evals/reports/2026-10-05-main-readiness-review.md) and the relevant live code.
5. [Development history](./docs/history/development-history.md) only when historical rationale is needed.

## Current source boundaries

The last reviewed main is `265cad5`; the development checkout is `588d860` plus substantial uncommitted changes. The isolated Proposal v2 integration is `cf8deae`. Re-check HEAD, status, worktree and artifact identities: none of these identifiers includes the current working-tree content by itself.

Current development has `decision_plans` / `decision_execution` and related UI work, while the earlier isolated integration has `proposal_plan_*` services. Review the exact schema, authority and caller contracts before applying that integration. Do not create parallel approval authorities or overwrite the user's implementation to match an older report.

## Immediate delivery work

- The independent documentation slice is ready for its link/archive checks and review; bilingual summaries are in the main-readiness report.
- Model discovery has scoped automatic evidence but a keyless-request compatibility change; complete that slice before claiming it ready.
- Verify Optimize streaming against actual Registry execution and progressive event delivery.
- Reconcile decision storage/execution/entrypoints, then validate the complete Resume review → Registry → Receipt → original Run continuation → restart chain.
- Preserve all existing business/security gates; record simulated, real-model, native-human and installer results independently.

## Branches and recovery

Keep only main, current development and current integration as local named branches. Other worker/experiment commits are archived; their old worktrees remain detached with files preserved. See [branch inventory and recovery](./docs/agents/branch-consolidation-20261005.md). Use detached worktrees for isolated review; do not silently recreate retired branches.

## Historical checkpoint

The September 27 handoff is preserved [here](./docs/archive/checkpoints/2026-09-27-HANDOFF.md). Its active branch, old main SHA, startup commands and regression totals belong to that checkpoint and do not prescribe the current installed-product workflow.
