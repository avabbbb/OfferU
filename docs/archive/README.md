# 文档归档

这里保存已经退出当前事实链的研究、设计草稿、阶段计划、旧审计和一次性 SOP。归档文件保留原始上下文，内容可能与当前代码、accepted ADR 或 Eval 结果冲突。

## 使用规则

- 不用归档文件证明当前能力或发布状态。
- 当前产品边界以 [`CONTEXT.md`](../../CONTEXT.md) 和 accepted ADR 为准。
- 当前实现面以实时 Operation Registry 为准。
- 当前可用性以 [`docs/evals`](../evals/README.md) 的有效报告为准。
- 若要恢复归档方案，先重新验证事实并建立新的 ADR/任务，不直接复制旧结论。

## 迁移索引

| 原路径 | 归档路径 | 类型 | 当前替代入口 |
|---|---|---|---|
| `docs/AGENT_NATIVE_CLI_CONTRACT.md` | [`contracts/AGENT_NATIVE_CLI_CONTRACT.md`](./contracts/AGENT_NATIVE_CLI_CONTRACT.md) | 旧 CLI 契约说明 | 实时 `manifest/schema` + [`agent-system`](../architecture/agent-system.md) |
| `docs/AGENT_OPTIMIZATION_DESIGN.md` | [`research/AGENT_OPTIMIZATION_DESIGN.md`](./research/AGENT_OPTIMIZATION_DESIGN.md) | Agent 研究稿 | [`agent-system`](../architecture/agent-system.md) + Eval |
| `docs/ALIGNMENT_2026.md` | [`research/ALIGNMENT_2026.md`](./research/ALIGNMENT_2026.md) | 对齐研究 | [`CONTEXT.md`](../../CONTEXT.md) |
| `docs/architecture/career-ops-alignment.md` | [`audits/career-ops-alignment-2026-07-30.md`](./audits/career-ops-alignment-2026-07-30.md) | 日期化审计 | 最新 Eval 报告 |
| `docs/BACKEND_CAPABILITY_AUDIT_2026-07-16.md` | [`audits/BACKEND_CAPABILITY_AUDIT_2026-07-16.md`](./audits/BACKEND_CAPABILITY_AUDIT_2026-07-16.md) | 日期化审计 | 实时 Registry + Eval |
| `docs/IMPLEMENTATION_ROADMAP_2026-07-17.md` | [`plans/IMPLEMENTATION_ROADMAP_2026-07-17.md`](./plans/IMPLEMENTATION_ROADMAP_2026-07-17.md) | 阶段路线图 | Eval 失败优先级 |
| `docs/implementation/SLICE_01_PLAN_2026-07-17.md` | [`plans/SLICE_01_PLAN_2026-07-17.md`](./plans/SLICE_01_PLAN_2026-07-17.md) | 已执行切片计划 | accepted ADR + 当前代码 |
| `docs/implementation/WEBUI_SLICE_01_APPLICATIONS_PLAN_2026-07-17.md` | [`plans/WEBUI_SLICE_01_APPLICATIONS_PLAN_2026-07-17.md`](./plans/WEBUI_SLICE_01_APPLICATIONS_PLAN_2026-07-17.md) | 已执行切片计划 | 当前 GUI + Eval |
| `docs/INTERVIEW_POSE_POC_PLAN.md` | [`plans/INTERVIEW_POSE_POC_PLAN.md`](./plans/INTERVIEW_POSE_POC_PLAN.md) | POC 计划 | 后续 capability task |
| `docs/MEMORY_ARCHITECTURE.md` | [`research/MEMORY_ARCHITECTURE.md`](./research/MEMORY_ARCHITECTURE.md) | 架构研究稿 | accepted ADR + `CONTEXT.md` |
| `docs/RESUME_CANVA_DECISION_2026.md` | [`plans/RESUME_CANVA_DECISION_2026.md`](./plans/RESUME_CANVA_DECISION_2026.md) | 技术选型记录 | 当前实现/Eval |
| `docs/RESUME_PUCK_MIGRATION_PLAN.md` | [`plans/RESUME_PUCK_MIGRATION_PLAN.md`](./plans/RESUME_PUCK_MIGRATION_PLAN.md) | 迁移计划 | 当前实现/Eval |
| `docs/UI_NOTION_CLEANUP_SOP.md` | [`plans/UI_NOTION_CLEANUP_SOP.md`](./plans/UI_NOTION_CLEANUP_SOP.md) | 一次性 SOP | 当前 GUI Eval |
| `docs/UPGRADE_2026.md` | [`plans/UPGRADE_2026.md`](./plans/UPGRADE_2026.md) | 旧升级路线 | Eval 驱动路线 |
| `docs/WEBUI_WORKBENCH_DESIGN_2026-07-17.md` | [`plans/WEBUI_WORKBENCH_DESIGN_2026-07-17.md`](./plans/WEBUI_WORKBENCH_DESIGN_2026-07-17.md) | UI 设计稿 | 当前 UI + 用户旅程 Eval |

历史验收报告没有放入本目录，而是集中到 [`docs/evals/reports`](../evals/reports/README.md) 并标记其证据等级。
