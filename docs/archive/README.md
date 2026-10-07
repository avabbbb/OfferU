# 文档归档

> 状态：**归档索引**。这里的内容只用于考古，不覆盖 `docs/` 下 10 篇当前文档。当前入口：[docs/README.md](../README.md)。

## 2026-10 文档重构

2026-10 起，`docs/` 收敛为 10 篇设计文档（README + 01–09）。此前所有设计、架构、ADR、Eval 说明和报告都原样移入 `pre-2026-10/`（保留 git 历史），并在每篇文件顶部注明取代它的新文档。机器读取的 schema 移到 `docs/evidence/`。

仍保留在仓库根目录、未归档：`README*`、`QUICKSTART.md`、`DEVELOPMENT.md`、`AGENTS.md`、`SECURITY.md`、`RELEASE_CHECKLIST.md`、`KNOWN_ISSUES.md`、`RELEASE_NOTES.md`、`LICENSE`、`THIRD_PARTY_NOTICES.md`。

### 主要映射

| 原路径 | 归档位置 | 当前文档 |
| --- | --- | --- |
| `docs/README.md` | `pre-2026-10/README-docs-index.md` | README.md |
| `docs/adr/README.md` | `pre-2026-10/adr/README.md` | 01-overall-design.md、08-module-agent-runtime.md（决策已并入） |
| `docs/agents/branch-and-test-baseline.md` | `pre-2026-10/agents/branch-and-test-baseline.md` | AGENTS.md |
| `docs/agents/branch-consolidation-20261005.md` | `pre-2026-10/agents/branch-consolidation-20261005.md` | AGENTS.md |
| `docs/agents/domain.md` | `pre-2026-10/agents/domain.md` | AGENTS.md |
| `docs/agents/issue-tracker.md` | `pre-2026-10/agents/issue-tracker.md` | AGENTS.md |
| `docs/agents/triage-labels.md` | `pre-2026-10/agents/triage-labels.md` | AGENTS.md |
| `docs/architecture/2026-09-14-operation-inventory.json` | `pre-2026-10/architecture/2026-09-14-operation-inventory.json` | 08-module-agent-runtime.md |
| `docs/architecture/2026-09-14-operation-inventory.md` | `pre-2026-10/architecture/2026-09-14-operation-inventory.md` | 08-module-agent-runtime.md |
| `docs/architecture/2026-09-14-simplification-execution.md` | `pre-2026-10/architecture/2026-09-14-simplification-execution.md` | 08-module-agent-runtime.md |
| `docs/architecture/2026-09-22-tool-surface-v2.md` | `pre-2026-10/architecture/2026-09-22-tool-surface-v2.md` | 08-module-agent-runtime.md |
| `docs/architecture/agent-bridge-protocol.md` | `pre-2026-10/architecture/agent-bridge-protocol.md` | 08-module-agent-runtime.md |
| `docs/architecture/agent-control-plane.md` | `pre-2026-10/architecture/agent-control-plane.md` | 08-module-agent-runtime.md |
| `docs/architecture/agent-system.md` | `pre-2026-10/architecture/agent-system.md` | 08-module-agent-runtime.md |
| `docs/architecture/agent-tool-contract.md` | `pre-2026-10/architecture/agent-tool-contract.md` | 08-module-agent-runtime.md |
| `docs/architecture/browser-extension.md` | `pre-2026-10/architecture/browser-extension.md` | 04-module-job-workspace.md |
| `docs/architecture/embedded-agent-proposal-integration-draft.md` | `pre-2026-10/architecture/embedded-agent-proposal-integration-draft.md` | 08-module-agent-runtime.md |
| `docs/architecture/harness-integrations.md` | `pre-2026-10/architecture/harness-integrations.md` | 08-module-agent-runtime.md |
| `docs/architecture/operation-security.md` | `pre-2026-10/architecture/operation-security.md` | 08-module-agent-runtime.md |
| `docs/architecture/proposal-v2-implementation-contract.md` | `pre-2026-10/architecture/proposal-v2-implementation-contract.md` | 08-module-agent-runtime.md |
| `docs/architecture/proposal-v2-migration-handoff.md` | `pre-2026-10/architecture/proposal-v2-migration-handoff.md` | 08-module-agent-runtime.md |
| `docs/architecture/resume-design.md` | `pre-2026-10/architecture/resume-design.md` | 05-module-resume.md |
| `docs/architecture/run-lifecycle.md` | `pre-2026-10/architecture/run-lifecycle.md` | 08-module-agent-runtime.md |
| `docs/architecture/site-rule-pack-v1.md` | `pre-2026-10/architecture/site-rule-pack-v1.md` | 04-module-job-workspace.md |
| `docs/architecture/workbench-interaction.md` | `pre-2026-10/architecture/workbench-interaction.md` | 02-interaction-design.md |
| `docs/design/2026-09-22-guided-career-coach-skill-ecosystem.md` | `pre-2026-10/design/2026-09-22-guided-career-coach-skill-ecosystem.md` | 02-interaction-design.md、08-module-agent-runtime.md |
| `docs/design/adaptive-ui/CURRENT_LAYOUT_DEBT.md` | `pre-2026-10/design/adaptive-ui/CURRENT_LAYOUT_DEBT.md` | 02-interaction-design.md（§9） |
| `docs/design/adaptive-ui/RESPONSIVE_MATRIX.md` | `pre-2026-10/design/adaptive-ui/RESPONSIVE_MATRIX.md` | 02-interaction-design.md（§9） |
| `docs/design/adaptive-ui/SCROLL_OWNERSHIP.md` | `pre-2026-10/design/adaptive-ui/SCROLL_OWNERSHIP.md` | 02-interaction-design.md（§9） |
| `docs/design/adaptive-ui/SURFACE_INVENTORY.md` | `pre-2026-10/design/adaptive-ui/SURFACE_INVENTORY.md` | 02-interaction-design.md（§9） |
| `docs/design/adaptive-ui/TARGET_LAYOUT_SYSTEM.md` | `pre-2026-10/design/adaptive-ui/TARGET_LAYOUT_SYSTEM.md` | 02-interaction-design.md（§9） |
| `docs/evals/BASELINE.md` | `pre-2026-10/evals/BASELINE.md` | 09-quality-and-release.md |
| `docs/evals/CASE_AUTHORING.md` | `pre-2026-10/evals/CASE_AUTHORING.md` | 09-quality-and-release.md |
| `docs/evals/E2E-EVAL-REPORT.md` | `pre-2026-10/evals/E2E-EVAL-REPORT.md` | 09-quality-and-release.md |
| `docs/evals/EVAL_ARCHITECTURE_AUDIT.md` | `pre-2026-10/evals/EVAL_ARCHITECTURE_AUDIT.md` | 09-quality-and-release.md |
| `docs/evals/FINDINGS.md` | `pre-2026-10/evals/FINDINGS.md` | 09-quality-and-release.md |
| `docs/evals/GRADING.md` | `pre-2026-10/evals/GRADING.md` | 09-quality-and-release.md |
| `docs/evals/LIVE_EVAL.md` | `pre-2026-10/evals/LIVE_EVAL.md` | 09-quality-and-release.md |
| `docs/evals/OWNER_DOGFOOD_GOALS.md` | `pre-2026-10/evals/OWNER_DOGFOOD_GOALS.md` | 09-quality-and-release.md |
| `docs/evals/PRIVATE_REAL_USER_EVAL.md` | `pre-2026-10/evals/PRIVATE_REAL_USER_EVAL.md` | 09-quality-and-release.md |
| `docs/evals/README.md` | `pre-2026-10/evals/README.md` | 09-quality-and-release.md |
| `docs/evals/REAL-AGENT-E2E.md` | `pre-2026-10/evals/REAL-AGENT-E2E.md` | 09-quality-and-release.md |
| `docs/evals/RUNTIME_COMPARISON.md` | `pre-2026-10/evals/RUNTIME_COMPARISON.md` | 09-quality-and-release.md |
| `docs/evals/offeru-core-v1.md` | `pre-2026-10/evals/offeru-core-v1.md` | 09-quality-and-release.md |
| `docs/evals/offeru-evolve-bench-v1.md` | `pre-2026-10/evals/offeru-evolve-bench-v1.md` | 09-quality-and-release.md |
| `docs/history/development-history.md` | `pre-2026-10/history/development-history.md` | README.md |
| `docs/product/agentic-interaction-policy.md` | `pre-2026-10/product/agentic-interaction-policy.md` | 02-interaction-design.md |
| `docs/product/career-memory-contract.md` | `pre-2026-10/product/career-memory-contract.md` | 03-module-profile.md |
| `docs/product/career-operations-loop.md` | `pre-2026-10/product/career-operations-loop.md` | 04、06、07 |
| `docs/product/current-product.md` | `pre-2026-10/product/current-product.md` | 01-overall-design.md |
| `docs/product/entry-onboarding-and-dogfood.md` | `pre-2026-10/product/entry-onboarding-and-dogfood.md` | 01-overall-design.md、08-module-agent-runtime.md、09-quality-and-release.md |
| `docs/product/offeru-career-os-blueprint.html` | `pre-2026-10/product/offeru-career-os-blueprint.html` | 01-overall-design.md |
| `docs/product/owner-career-journey.md` | `pre-2026-10/product/owner-career-journey.md` | 01–07 各模块 |
| `docs/product/proactive-career-director.md` | `pre-2026-10/product/proactive-career-director.md` | 08-module-agent-runtime.md（§8）、03、07 |
| `docs/product/resume-canvas-design.md` | `pre-2026-10/product/resume-canvas-design.md` | 05-module-resume.md |
| `docs/product/skill-first-job-workspace-story.md` | `pre-2026-10/product/skill-first-job-workspace-story.md` | 01-overall-design.md |
| `ARCHITECTURE.md` | `pre-2026-10/root/ARCHITECTURE.md` | 01-overall-design.md、08-module-agent-runtime.md |
| `CONTEXT.md` | `pre-2026-10/root/CONTEXT.md` | 01-overall-design.md（§10 术语） |
| `GOAL.md` | `pre-2026-10/root/GOAL.md` | 01-overall-design.md、09-quality-and-release.md |
| `HANDOFF.md` | `pre-2026-10/root/HANDOFF.md` | RELEASE_CHECKLIST.md、KNOWN_ISSUES.md（实时状态） |
| `INTERNAL_BETA.md` | `pre-2026-10/root/INTERNAL_BETA.md` | 09-quality-and-release.md |
| `QUALITY_SCORE.md` | `pre-2026-10/root/QUALITY_SCORE.md` | 09-quality-and-release.md |
| `RELIABILITY.md` | `pre-2026-10/root/RELIABILITY.md` | 09-quality-and-release.md |
| `STATUS.md` | `pre-2026-10/root/STATUS.md` | RELEASE_CHECKLIST.md、KNOWN_ISSUES.md（实时状态） |

另有 112 个 Eval 报告及附件，原路径 `docs/evals/reports/**`，归档到 `pre-2026-10/evals/reports/**`，作为对应 commit 当时的历史证据。

`docs/evals/report-schema.json` → `docs/evidence/report-schema.json`；`docs/evals/evolve-bench-schema.json` → `docs/evidence/evolve-bench-schema.json`。

## 更早的归档（2026-09 及以前）

# Historical Archives / 历史归档

Status: **HISTORICAL MATERIAL — NOT CURRENT AUTHORITY**
