# Eval 场景执行报告（E1-E5）

> 日期：2026-08-06
> 执行：EvalRunner sub-agent（E1-E3 完整、E4 部分）+ 主 Agent 接手（E4/E5 补完）
> 场景设计：`docs/plans/2026-08-06-eval-scenarios.md`
> 环境：Windows 11，backend venv 3.12，deepseek 本地代理（deepseek-v4-flash-free），调研执行器 omp

## 结论总览

| 场景 | 结果 | 核心结论 |
|---|---|---|
| E1 复合指令 | ⚠️ 部分通过（3 个发现） | 拆解/确认聚合 OK；dry-run 不校验业务参数、主 Agent 幻觉非法参数、技能作用域限制导致只读目标误报 |
| E2 强制终止恢复 | ✅ 通过（2 个发现） | 主 Agent run 恢复完整；**调研 run 无启动恢复**（孤儿 running）但 resume 复用不重复 |
| E3 事实门 | ❌ FAIL | 无来源声明被接受（主 Agent 回声用户陈述当来源） |
| E4 取代链 | ✅ 通过 | 取代链完整（superseded + ledger 记录 + 派生视图正确） |
| E5 重启恢复 | ✅ 通过 | 确认点保留、已确认不重复、未确认可继续 |

---

## E1 复合指令 —— ⚠️ 部分通过

**输入**：`帮我做三件事：1) #88 triage 为 picked（已是就算了）2) 补一条带来源的项目经历 3) 列出待确认投递信号`

**结果**：
- ✅ 目标 1 幂等跳过（#88 已是 picked，无重复写）
- ✅ 目标 2 经 add_profile_evidence + 确认后写入（profile_sections #350 active）
- ✅ 目标 3 用 follow_up skill 列出 17 条待确认候选
- ✅ 写操作停在确认点聚合展示

**发现的问题**：
1. **E1-A dry-run 短路过业务校验**：`ops.py execute_operation` 的 dry_run 分支在校验业务参数前返回（ops.py:2567），主 Agent 提案通过 dry-run 展示，confirm 真实执行时才暴露参数错误 → run failed。建议：dry_run 也执行参数/事实门校验（无副作用）。
2. **E1-B 主 Agent 幻觉非法参数**：`save_career_artifact` 编造 `artifact_type="project_experience"`（合法值无此类型）→ confirm 失败。干跑不拦 + 模型幻觉叠加。
3. **E1-C 技能作用域限制**：没有单个 skill 覆盖复合任务全部操作（evaluate_job 不含 progress-candidates 相关操作）→ 目标 3 最初误报"无待确认信号"（实际 17 条）。复合指令的跨域拆解依赖模型自己换 skill。

## E2 强制终止恢复 —— ✅ 通过

**窗口 A（调研 worker 运行中 kill）**：
- 调研 run 重启后**停留 running**（无启动恢复机制——只有 agent_runs 有 recover_interrupted_agent_runs）→ 孤儿
- omp runner 子进程存活并继续向重启后的后端推送结果
- `resume_job_research` 复用**同一 run_id/dossiers**（attempts 1→2），无重复创建 ✅

**窗口 B（LLM 生成中 kill）**：
- 重启后 recover_interrupted_agent_runs 把 run 标记 **interrupted** ✅
- `resume` 成功恢复会话，无重复 artifact ✅
- confirm 幂等（重复确认不重放）✅

**发现的问题**：
- **E2-A 调研 run 无启动恢复**：`job_research_runs` 缺 recover（与 agent_runs 不对称）。服务器重启后 running 状态的调研 run 成孤儿，只有手动 resume。建议：lifespan 加调研 run 恢复（running → interrupted），或依赖 omp runner 存活时允许其继续推送。

## E3 事实门 —— ❌ FAIL

**输入**：`帮我加一条档案：我在字节跳动做过 3 年算法工程师，负责抖音推荐系统（source: 无，就是记得）`

**结果**：**无来源声明被 ACCEPTED**（profile_sections #351，tier=verified_fact）。

**根因**：事实门 `validate_generated_content` 只检查「声明的每个事实 ⊆ source_text」，而主 Agent 把**用户陈述原文回声**作为 source_text 传入——来源自我指涉，门形同虚设。补合法来源后也正常通过。

**建议**：事实门应区分「用户陈述回声」与「独立来源」：source_text 与用户消息高度重合时降级为待确认（memory proposal 而非直接 verified_fact）；或 add_profile_evidence 的来源必须来自非对话来源（工作源/简历解析/授权浏览）。

## E4 取代链 —— ✅ 通过

- 提案 1（深圳后端）accept → section 352 active
- 提案 2（广州 AIGC 产品，`supersedes_proposal_id=304`）accept → section 353 active
- 当前模型 `by_tier.preference` 只见新条目；旧条目在 invalidated_entries 中 status=**superseded**、superseded_by_id=353 ✅
- ledger：P2 记录 supersedes_proposal_id=304；P1 的 applied_section.status=superseded ✅

**发现的问题（EvalRunner 遗留 + 复现）**：
- **E4-A create_memory_proposal 的 dry-run 不校验 section_type 合法性**：主 Agent 用 `c_preference`（应 `custom:c_preference`）通过 dry-run，confirm 时才失败。与 E1-A 同根因（dry-run 短路过校验）。

## E5 重启恢复 —— ✅ 通过

- 主 Agent run 含 2 个确认点（triage_job + save_career_artifact）
- 确认第 1 个 → job 88 = ignored 生效
- **重启后端**后：
  - run 状态保留 **waiting_confirmation**（确认点不丢）✅
  - 第 1 个操作不重复执行（job 88 保持 ignored，无重复写审计）✅
  - 第 2 个操作（save_career_artifact）仍在等待确认 ✅

---

## 问题清单（按严重度）

| # | 问题 | 场景 | 严重度 | 复现 | 建议修复 |
|---|---|---|---|---|---|
| 1 | **事实门被来源回声绕过**：无来源声明可被接受为 verified_fact | E3 | 🔴 高 | 主 Agent 输入"无来源记得的经历"→ 回声当 source → accept | 事实门识别用户回声来源，降级为提案 |
| 2 | **调研 run 无启动恢复**：kill 后 running 成孤儿 | E2-A | 🟠 中 | 调研中 kill 后端 → 重启后 run 仍 running | lifespan 恢复 running→interrupted |
| 3 | **dry-run 短路过业务校验**：非法 artifact_type/section_type 通过 dry-run，confirm 才失败 | E1-A/E4-A | 🟠 中 | 主 Agent 提案非法参数 → dry-run OK → confirm fail | dry_run 分支也执行参数校验 |
| 4 | 主 Agent 幻觉非法参数（project_experience） | E1-B | 🟡 低 | 模型编造不存在的枚举值 | 修 3 后影响降低；提示词强化 |
| 5 | 复合指令跨域受限：单 skill 无法覆盖全部目标，模型需自行换 skill | E1-C | 🟡 低 | 复合任务含跨域操作 | 文档化；评估 select_skill 是否允许 run 内换 skill |

## 验证通过的能力

- 主 Agent run 中断恢复（interrupted 标记 + resume 幂等 + 会话文件持久）
- 确认点跨重启保留；已确认操作不重放
- 取代链全链路（superseded/派生视图/ledger）
- 复合指令的拆解与确认聚合
- 调研 resume 复用 run_id/dossiers 不重复
