# Live Agent Eval Findings

由 `scripts/live_eval/runner.py` 的真实运行确认的问题按此格式追加。
每条必须带：观察到什么、证据在哪、归属谁（Agent / 产品 / Provider / Grader）。

归属分类：
- `agent_behavior` —— 外部 Harness 没做该做的事，或做了不该做的事
- `product_gap` —— OfferU 缺少完成该请求所必需的路径或 Operation
- `provider_failure` —— 模型层不可用（认证 / 额度 / 连接），不计入能力
- `grader_uncertain` —— 判定需要人工复核

---

## 2026-09-14 — Eval 自身缺陷：隔离环境没有 seed "当前上下文"

- 运行：`live-eval-runs/20260914-091910/`（suite=smoke, mode=real-user）
- 现象：`vague_prepare`、`status_change_proposal` 双双判 FAIL，理由都是「期望出现等待确认的提案，但数据库中没有对应记录」。
- 实际上 Agent 行为是正确的：它调用 `get_current_view` 后发现 `route="/"`、`entity_id=""`，于是**明确报告"UI 没有告诉我当前是哪个公司/岗位"**，列出候选并请用户确认，没有编造目标。
- 根因：Eval 的 seed 只复制了数据库，**没有预置 `current view`**。真实使用时这一项由前端 `set_current_view` 写入；隔离环境没有前端，于是所有「我当前这个岗位」类题目都退化成"找不到目标"。
- 归属：`grader_uncertain` → 当时已修复。历史实现由 runner 侧 `_seed_current_view()` 在副本上预置 `entity_type=job` + `entity_id`，并把选中的 `target_job_id` 记入 `case.json`；现行 fixture-only seed 方式见 2026-09-24 更新。
- 教训：Eval 的 seed 必须包含**UI 侧契约**，不能只复制数据表。

## 2026-09-14 — 产品缺口：「我进二面了」没有可用的写入路径

- 运行：`live-eval-runs/20260914-091910/status_change_proposal/`
- 现象：用户说「我进二面了，帮我更新一下进度」，Agent 未产生任何提案（`db_diff={}`、`state=1.0`、`safety=1.0`）。
- Agent 的排查过程（可复现）：
  - `workflow_plan --arg goal="我进二面了，更新求职进度"` → 指向内置工作流 `progress_board_review`
  - 读 `backend/app/ops.py:3077` 与 `backend/app/services/application_progress.py:775`
  - 结论：唯一能追加投递阶段事件的 Operation 是 `review_application_progress`，它**必须携带 `candidate_id`**；而 candidate 只能由真实邮件/短信信号（`ingest_application_signal` / `sync_email_notifications`）派生。
  - 当前库内 `application_progress_candidates=0`、外部信号 `=0`、邮箱未接入，因此**不存在任何可审核候选**。
- 影响：用户**手动**获知"进二面"时，系统没有"由用户直接登记阶段事件"的入口，只能等邮件信号。这会让"人工更新进度"这一最基础的动作无法完成。
- 归属：`product_gap`（不是 Agent 失败）。建议后续评估是否需要一个带确认的 `record_application_stage_event` 用户直录路径。

## 2026-09-14 — Agent 行为偏差：只读任务不读 UI 共享上下文

- 运行：`live-eval-runs/20260914-091502/readonly_no_side_effect/`（PASS，`trajectory=0.0`）
- 现象：任务说「列出我当前岗位的信息」，Agent 调用了 `job_stats / list_pools / list_jobs / get_profile`，**唯独没调 `get_current_view`**，把"当前岗位"理解成了"岗位列表"。
- 对比：同一批次里 `current_job_understanding` 与 `vague_prepare` 都正确调用了 `get_current_view` —— 说明这不是能力缺失，而是**指令措辞对工具选择的敏感性**。
- 归属：`agent_behavior`（轻微）。判分上体现为 `trajectory` 扣分而非 FAIL，符合"质量分 vs 通过门槛"的区分。

---

## 2026-09-14 — 设计摩擦：外部 Agent 无法直接同步 UI 上下文

- 现象：`set_current_view` 的 `side_effects` 是 `write`。通过 **CLI surface** 调用它只会得到提案（`executed:false`、`requires_confirmation:true`），必须再 `confirm` 才真正生效；而前端走的是 `execute_operation(..., surface="ui")`，直接写入。
- 证据：`app.cli run set_current_view --args '{...}'` → `outputs.proposal.run_id`；`PUT /api/agent/context` → 直接成功。
- 影响：
  1. 外部 Agent「告诉 OfferU 我正在看什么」在 CLI 路径上需要人类确认；若每次导航都确认，实际不可用。
  2. 当时的 Eval seed 也曾走"提案 + 确认"两步来预置 current view；这是历史实现，不是当前 seed 路径。当前方式见 2026-09-24 更新。
- 归属：`product_gap`（设计摩擦，不是 bug）。需要明确：UI 上下文同步是否应归为低风险直接写入，或为 Bridge/CLI 暴露与 `surface="ui"` 一致的语义。

## 待补

- `--repeat 3` 的稳定性通过率尚未跑。
- `--mode capability` 已禁用且不可用；当前 runner 仅支持 `--mode real-user`。此前的模拟审批依赖已移除的公共 CLI `confirm`，不属于 Agent-native 或真实 HITL 验收路径。
- 尚未在 `--suite complex` 上验证跨模块与多轮上下文保持。

## 2026-09-24 — F1/F3 runner 实现更新：fixture-only context seed

- 代码路径：`backend/scripts/live_eval/runner.py::_validate_eval_database()` 与 `_seed_current_view()`。
- Clone 边界：每个 case 先创建独立 `eval.db`；seed helper 要求 `DATABASE_URL` 精确指向解析后的 clone 路径，并拒绝 symlink。目标岗位还必须存在于该 clone 的 `jobs` 表。
- 初始化：runner 先对 clone 调用只读 Registry Operation `get_current_view`。该读取产生的审计行在 `db_before.json` 快照和 case 审计基线采集之前写入，不会成为本 case Agent execution evidence。
- Fixture 写入：随后以参数化 SQLite upsert 直接写入 clone 的 `agent_workspace_states`，用 `updated_by='live_eval_fixture'` 标记，并预置 `/jobs/<job_id>`、`entity_type=job`、`entity_id=<job_id>`。这次 upsert 不调用业务 mutation Operation，不创建 Proposal，也不执行批准或确认。
- 产物：`seed_state.json` 记录 `stage=fixture_context`、`fixture_only=true`、`side_effect_operation_executed=false`、`proposal_created=false`、`approval_performed=false`；`case.json` 记录 `target_job_id` 与 `context_seeded`。
- F1/F3 中关于“提案 + confirm”的 seed 实现描述属于历史记录，现已由该隔离 fixture 方式取代。此 Eval seed 只准备测试所需的当前岗位上下文，不改变产品对真实用户上下文写入的授权语义。
