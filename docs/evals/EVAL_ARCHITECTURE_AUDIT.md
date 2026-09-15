# OfferU Agent Eval —— 架构审计

- 状态：第 1 阶段（Inspect）产出，作为后续实现的唯一前置事实源
- 日期：2026-09-14
- Reference implementation: **https://github.com/luyishui/OfferU**

> 本文件回答"当前 OfferU 到底长什么样"，并明确 Eval 系统应当挂在哪条缝上。
> 实现阶段以本文件 + `CONTEXT.md` + 相关 ADR 为事实源；与之冲突的旧计划以本文件为准。

---

## 0. 一句话结论

OfferU 已经具备建 Agent Eval 所需的全部**确定性控制面**（Operation Registry / Proposal / AuditLog /
RunEvent / 隔离库），**但存在四个并存的"Agent 入口"**，必须先钉死被测对象，否则会测错东西。

---

## 1. 审计结论（逐条回答 Inspection 清单）

| # | 问题 | 结论 | 证据 |
| --- | --- | --- | --- |
| 1 | Agent 的真正入口 | **外部 Coding Agent 走 CLI**（`app.cli run/confirm`）+ `.agents/skills/offeru/SKILL.md`。仓库内另有 3 条 provider seam，但它们服务不同对象（见第 2 节） | `backend/app/cli.py:63,203,211`；`.agents/skills/offeru/SKILL.md:20` |
| 2 | Tool/Operation 唯一执行入口 | `OPERATIONS` 注册表 + `execute_operation()`；写操作经 `execute_or_propose_operation()` 落提案 | `backend/app/ops.py:1687`（注册表）、`:4689`（唯一执行点）、`backend/app/services/operation_projection.py:13` |
| 3 | 真实 Career Truth | Job / Profile / ProfileSection / ProfileTargetRole / Resume / ResumeSection / ResumeVersion / ResumeOptimizationProposal / Application / ApplicationAttempt / **ApplicationStageEvent** / ApplicationProgressCandidate / ExternalProgressSignal | `backend/app/models/models.py:30,286,341,324,626,686,1561,721,826,845,939,896,864` |
| 3b | 只是投影/缓存 | AgentWorkspaceState（current view）/ SmartFillMapCache / ApplicationWorkspaceSettings / AgentRunRecord+Event | `models.py:1321,1503,1343,1025,1065`；`services/job_projection.py`、`operation_projection.py`、`context_projector.py` |
| 4 | HITL | 由 `Operation.is_mutation`（`side_effects` 含 `write\|llm\|external`）决定；schema 层 `requires_confirmation = is_mutation`；提案落 `agent_runs`，独立 confirm 才执行 | `ops.py:1542,1552,1596,1614`；`agent_run_state.py:47,56,583`；`operation_projection.py:87`；`agent_run_coordinator.py:24,81` |
| 5 | 可自动执行 | 只读（`is_mutation == False`）直接执行；`dry_run` 的写操作返回跳过预览、不落提案。实测 **257 个 Operation：只读 89 / 写类 168** | `operation_projection.py:25-31`；`ops.py:4726` |
| 6 | AgentRun 可重放性 | 状态机与事件序列已实现，恢复逻辑已实现，但语义是**禁止自动重放副作用**：重启时 `planning/executing` → `interrupted` 或 `needs_reconciliation`；confirm 遇到上次 `executing` 的步骤置 `uncertain` | `agent_run_state.py:15,16,23,216,428,549,460`；`agent_run_coordinator.py:38-58` |
| 7 | 事件持久化 | 7 张 append-only 事件表：`agent_run_events` / `career_task_events` / `hosted_executor_events` / `operation_audit_logs` / `automation_events` / `application_stage_events` / `interview_behavior_events` | `models.py:1065,1231,1143,970,1253,939,1676` |
| 8 | Fixture / Replay | 已有 `ReplayAgentRunProvider`（真落库 + 逐事件 publish）与 `ReplayAgentRuntimeProvider`；fixture 数据在 `tests/fixtures/`、`evolve_bench/fixtures/`；`demo_data.reset_demo_data()` 可重置 demo 数据 | `agent_runtime.py:279,500,812,791`；`tests/test_agent_runtime_convergence.py:129,172,249`；`demo_data.py:120` |
| 9 | 现有测试可复用性 | 见第 8 节映射表 | 同上 |
| 10 | DB 生命周期与隔离 | 优先级 **进程 env > backend/.env > 默认 backend/djm.db**；已有 SQLite online backup 克隆、非系统盘 workspace、conftest 拒绝 C 盘临时目录 | `config.py:19,100-104`；`runtime_paths.py:33,58,62,66`；`live_eval/isolation.py:139`；`tests/conftest.py:1`；`evolve_bench/real_career_fixture.py:34,58` |
| 11 | 多 Runtime 适配 | `RUNTIME_DEFINITIONS` 定义 7 个执行器：codex / claude / gemini / opencode / pi / omp / **codebuddy**；探测 = `--version` + `--help` 标志校验（20s 超时、按 mtime 缓存）；provider health 独立持久化 | `coding_agent_runtime.py:30,50,66,84,104,128,151,409,489,722`；`agent_provider_health.py:19,97,56,144`；`models.py:1168` |
| 12 | CareerTask / hosted executor | CareerTask 是持久化任务队列（4 类：`agent_turn/run_artifact/role_intelligence/plugin_capability`），幂等键落库、可重试、有事件流；hosted executor 是绑定单一重任务的 coding-agent 会话。**可复用为 Eval 的重任务通道**，但成本高于 CLI 只读通道 | `career_tasks.py:40,359,346,454,279,306`；`models.py:1188,1231,1107,1143`；`coding_agent_runtime.py:1717` |
| 13 | 配置与凭据 | 优先级 **进程 env > backend/.env > config.json 同步值 > 代码默认**；API Key 支持 `env:VAR` 延迟解析（进程 env 优先，回退 .env 文件）；邮箱类凭据存系统钥匙串，DB 只存 `credential_ref` | `llm_config_store.py:28,171,130`；`routes/config.py:471,495`；`credential_store.py:5`；`models.py:445` |
| 14 | 已有 Eval 代码 | **两套**：`evolve_bench/`（离线契约层，只定义状态/维度/指标 + 生成 NOT_RUN 骨架）与 `live_eval/`（真实外部 Harness 的 live eval，本任务的基座） | `evolve_bench/contract.py:28,282,291,399,403,519`；`live_eval/cases.py:55`、`grader.py:181`、`runner.py:264,336` |

---

## 2. 关键澄清：仓库里有四个"入口"，别测错

| 入口 | 服务对象 | 工厂 / 实现 | 是否本 Eval 的被测对象 |
| --- | --- | --- | --- |
| **主 Agent UI** | 前端 OfferU 面板里的对话 | `get_agent_run_provider`（仅 `pi` / `replay`） | 否 |
| **内部任务 provider** | CareerTask 等内部重任务 | `get_agent_runtime_provider`（`replay` / `codex`） | 间接（经 CareerTask） |
| **hosted 执行器 runtime** | 受托管的外部 coding-agent 会话 | `RUNTIME_DEFINITIONS`（codex/claude/gemini/opencode/pi/omp/codebuddy） | 作为"能力可用性"事实源 |
| **外部 Coding Agent CLI 接入** | Codex / WorkBuddy / Claude / Pi **直接操作 OfferU** | `app.cli run/confirm` + Operation Registry + SKILL.md | ✅ **是** |

> **结论（不可动摇）**：Ava 版 Eval 的被测对象是**第 4 条**——外部 Harness 能否通过 Operation Registry
> 正确地完成真实求职任务。`scripts/live_eval/runner.py` 已按这条缝实现（工具白名单 + 显式禁止
> `app.cli confirm`），应当作为基座继续演进，**不重写**。

---

## 3. HITL 与 surface 边界（含两类必须防的旁路）

授权只在 `op.is_mutation and surface in _PROTECTED_AGENT_SURFACES` 时强制（`ops.py:4743`）。
`ui`、`unknown` 与 legacy `web_agent_confirm` **不在**受保护 surface 内，因此可直写。

| 旁路 | 位置 | 对 Eval 的影响 |
| --- | --- | --- |
| legacy Web Agent 确认 | `routes/agent.py:197`（`surface="web_agent_confirm"`）提案存**内存** `_PROPOSALS`，不落库 | 若只做 DB 前后 diff，会**观察不到提案**从而误判 |
| UI 直写 | `routes/jobs.py:355`、`routes/pools.py:130`、`routes/agent.py:233`（`surface="ui"`） | `set_current_view` 走 CLI 需确认、走 UI 直写 —— Eval seed 必须"提案 + confirm"两步 |

已有静态守卫可直接复用：`backend/tests/test_control_plane_global.py`（AST 扫描禁止 route 层直接 ORM 写，
白名单 `NON_REGISTRY_MUTATION_ENDPOINTS`）。

---

## 4. 隔离与幂等的硬约束

1. **真实库 `backend/djm.db` 约 112MB**，任何 mutation Eval 必须 clone 隔离副本，禁止直接跑。
2. **必须 seed UI current view**：隔离环境没有前端，current view 为空会让所有"我当前这个岗位"类题目
   退化成"找不到目标"，把 Agent 的合理澄清误判成 FAIL（已由 `FINDINGS.md` 记录并修复）。
3. **幂等不能靠重复请求验证**：`execute_confirmed` 对上次 `executing` 的步骤置 `uncertain` 并
   `needs_reconciliation`，`recover_interrupted_agent_runs` 也绝不重放；真正能证明幂等的只有
   `OperationAuditLog.idempotency_key` 唯一占位（`ops.py:4931`）。
4. **provider 层故障（401/424/429/timeout）单独归类 BLOCKED**，不计入 Agent 能力。

---

## 5. 现有测试 → Eval Case 的映射（可直接或稍加改造）

| 现有测试 | 覆盖场景 | 可转成的 Eval 维度 |
| --- | --- | --- |
| `tests/test_agent_control_plane.py:33` | MCP schema 与 Registry 一致、无 DB 旁路 | 唯一入口不变式 |
| `tests/test_control_plane_global.py` | 全局禁止第二写路径 | safety / operation_bug |
| `tests/test_agent_runtime_convergence.py` | replay run 持久化 / resume / thread-turn / CareerTask 幂等 | 恢复语义、幂等 |
| `tests/test_coding_agent_runtime.py:33,78,129,199,220` | codex/claude 协议、能力探测 fail-closed | provider 归类 |
| `tests/test_reliability.py:49,94,390,445,573,746,824` | CareerTask 并发 exactly-once、重放 soak、取消 | 并发正确性 |
| `tests/test_eval_fixes.py:16` | 简历事实门（echo_source / unverified_fact / metric） | **career-truth grader 的现成素材** |
| `tests/test_release_provider_health.py:32-78` | provider health 映射 + 密钥脱敏 | 脱敏断言 |
| `tests/test_agent_conformance.py:22-81` | 探测事件归类、不支持信号 fail-closed | conformance 判定 |
| `tests/test_demo_data.py:47,296` | demo 作用域隔离与显式确认 | seed 隔离 |
| `scripts/e2e/test_public_release_failure_recovery.py` | 跨进程 CareerTask 失败/重试/重启 | 失败恢复（成本高，后续） |

---

## 6. 已有 Eval 资产与复用决策

| 资产 | 内容 | 决策 |
| --- | --- | --- |
| `scripts/evolve_bench/contract.py` | 状态值、9 个领域、6 维权重、`pass_at_1` / `pass_power_k` / `safety_gate` / `validate_report` / `build_not_run_report` | **复用为指标与报告契约**，不另造一套 |
| `docs/evals/*.json` | `evolve-bench-schema.json`、`report-schema.json` | 复用为产物 schema |
| `scripts/live_eval/` | 隔离库 + 真实 Harness + trace + diff + 判分 + 两种模式 | **本任务基座，继续演进** |
| `scripts/evolve_bench/real_career_fixture.py` | 需人工确认的 `resume-gold.json` / `profile-t0.json` | 留待 REAL_CAREER 阶段；本阶段用真实库隔离副本 |
| `tests/evolve_bench/test_contract.py` | 契约层自测 | 复用范式，扩展为 Eval Harness 自测 |

---

## 7. 对照参考实现：采用 / 重设计 / 不采用

Reference implementation: **https://github.com/luyishui/OfferU**

### 7.1 采用的思想
- **Outcome > Agent self-report**：判分只看数据库最终状态与工具轨迹。
- **Case → Seed → Real Agent → Trace → Before/After → Grader → Verdict → Repeat → Findings** 闭环。
- **Isolated seed database**（参考实现建全新库；本仓库改为 SQLite online backup 克隆真实库）。
- **protected records**（参考实现叫 `protected_records`；本仓库 `protected_jobs`，将扩展为通用表+主键）。
- **issue taxonomy 把"谁的锅"分开**（参考实现只分 `provider_failure`；本仓库扩展为 10 类）。
- **findings.md 沉淀真实 Bug**，并让修过的 Bug 进 regression。
- **harness 自测**（参考实现有 `test_live_agent_eval_harness.py`）。

### 7.2 重新设计的部分
- **被测对象不同**：参考实现测**自家 Kernel**（`/api/harness-agent/chat/stream`，需 LLM Key）；
  本仓库测**外部 Harness**（CLI + Operation Registry），**不需要为 Eval 准备模型凭据**。
- **Seed 用真实库克隆**而非合成 25 个岗位：本仓库已有 458 岗位 / 65 profile / 64 application_attempt
  的真实数据，克隆即可获得更真实的噪声分布。
- **判分绑定 surface**：本仓库存在 `ui` / `web_agent_confirm` 直写旁路，参考实现没有这个问题，
  因此 Eval 必须显式声明"被测 Agent 只能走 CLI surface"。
- **provider 归因覆盖认证失败**：参考实现只覆盖 424/连接错误，实测 401 会被算成 FAIL（已在本仓库修正）。

### 7.3 不采用的部分
- **不复制 68KB runner + 142KB grader**：规模不匹配，且其内部结构与本仓库 Operation Registry 不同。
- **不做 auto-confirm-all 的实验性确认循环**：参考实现的"最多补两次 Go on"已吸收为 `--mode capability`，
  但不允许在真实库上跑（本仓库严格 clone）。
- **不引入平行 Runtime / 平行 backend**（GOAL 第 24 条明确禁止）。

---

## 8. 本阶段实施边界

### 允许修改
- `backend/scripts/live_eval/**`（基座演进）
- `backend/tests/evals/**`（新建 Harness 自测）
- `docs/evals/**`（文档与产出）

### 禁止
- 绕过 Operation Registry 制造第二条写路径
- 直接改数据库"模拟 Agent 成功"
- 在真实库 `backend/djm.db` 上跑 mutation Eval
- 把 API Key 写入 artifact / git
- 为让 Eval PASS 而硬编码 Agent 路径

### 本阶段不覆盖（留待后续）
- 真实 Resume PDF → Profile T0（需人工确认的 gold 数据）
- 邮箱 IMAP 纵向阶段（需用户 OAuth）
- Browser JD 采集 / Smart Fill（需真实站点与扩展）
- Interview 深度训练
