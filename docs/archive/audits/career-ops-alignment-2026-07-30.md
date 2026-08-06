# OfferU 与 CareerOps 的 Agent 对齐状态

> 状态日期：2026-07-30  
> 对比基准：CareerOps `main`（审计时提交 `dab8517`）  
> 范围：外部 Coding Agent、内置主 Agent、Skill/CLI/MCP 控制面和求职操作交互。
> 当前架构事实源：[Agent System](../../architecture/agent-system.md)；动态能力事实源：`python -m app.cli manifest`。

## 1. 结论

OfferU 不能称为 CareerOps Agent 的“完美复刻”，也不应把完全同构作为目标。

CareerOps 把外部 Coding CLI 作为 Agent loop，`modes/*.md` 作为执行大脑，人类可读文件作为永久事实源。OfferU 借鉴其外部 Host + Skill/CLI-first 入口，但把业务执行重构为统一 Operation Registry，并增加 Pi 内置主 Agent、持久 Agent Run、任务能力授权、独立确认、审计和职业事实门；Python/SQL 仍是唯一业务事实源。

推荐定位：**CareerOps-inspired external-agent interaction，OfferU-native control plane and embedded Agent runtime。**

## 2. 当前可验证快照

| 项目 | 当前状态 |
|---|---|
| Operation Registry | 111 个原子 Operation；56 个需要独立确认 |
| 结构化输入契约 | 57 个 Operation 发布严格 `input_schema`，其余仍需补齐 |
| Skill Registry | `2026-07-30.2`；34 个 Skill，其中 28 个 native、6 个 partial |
| 内置主 Agent | Pi SDK Worker；一个 Run 一个受限 Session，只暴露 Run allowlist 中的 Operation |
| 外部托管执行器 | Codex App Server 与 Claude Agent SDK adapter；任务级 session、统一事件、取消、恢复和候选结果 handback |
| 外部手动入口 | CLI 与 MCP 均为 Operation Registry 薄投影，无 raw API 逃生口 |
| 外部 Skill 投影 | `.agents`、`.claude`、`.codex`、`.copilot` 由同一 Registry 确定性生成 |
| 图形控制面 | AgentPanel 展示 Agent Run、待确认动作、托管执行事件及证据审核 |
| 操作员 TUI | 已有领域定义，尚无 `offeru tui` CLI 实现 |

Skill Registry 生成时会拒绝任何不存在于 Operation Registry 的 allowlist 项。2026-07-30 的完整性收敛移除了 `run_scraper`、`list_email_notifications` 和 `auto_fill_calendar` 等未注册幽灵工具；日程、题库和主 Agent Run 则建立了真实只读 Operation 后才重新加入 allowlist。受剩余缺口影响的 Skill 会如实标为 partial，而不是静默过滤。

## 3. 与 CareerOps 的对齐矩阵

| CareerOps 能力 | OfferU 当前落点 | 判定 |
|---|---|---|
| 外部 Coding CLI 充当操作宿主 | Skill + CLI/MCP；必要时由 OfferU 托管 Codex/Claude session | 已成立，但控制权更集中于 OfferU |
| 单一 Router 与自然语言/模式路由 | Registry 支持 `/offeru`、`/skill-id`、alias 与模型选择；外部投影读取 live manifest | 基本成立，不提供 CareerOps 式隐藏 `auto_pipeline` |
| 多宿主一致入口 | 四种投影共享 Registry 版本、哈希、allowed Operations 与确认边界 | 已完成首批宿主；覆盖面仍小于 CareerOps |
| JD 评估、简历、追踪、邮件、面试 | 34 个结构化 Skill 组合 111 个 Operation | 主路径大部分具备，6 个 Skill 明确 partial |
| 单一投递事实模型 | 外部候选进展写入 `ApplicationAttempt` 事件；工作区 `ApplicationRecord` 与遗留 `Application` 仍并存 | 部分完成，尚不能称为单一追踪模型 |
| 浏览器 ATS 扫描与岗位存活检查 | 当前无注册 Operation | 未完成 |
| 浏览器表单识别与受控填充 | `application_assistant` 仅准备材料与待办 | 未完成 |
| 联系人发现与来源验证 | 可起草角色化外联，不发现或虚构联系人 | 未完成 |
| 文件/PDF/报告 handback | 现有 PDF/DOCX 简历可经确认读取、逐页解析并生成候选项；简历 PDF 与 career artifact 已有；通用托管文件产物审核契约仍缺 | 部分完成 |
| TUI Dashboard | 领域定义已接受，CLI 未实现 | 未完成 |
| 插件、自更新与系统/用户层回滚 | OfferU 尚无 CareerOps 同等级机制 | 未完成 |
| Human-in-the-loop | proposal、独立 confirm、幂等、审计、事实审核门 | 已完成，治理强于 CareerOps |

## 4. 两条 Agent 路线

### 4.1 外部 Coding Agent 路线

外部 Agent 必须先读取 CLI manifest 和 playbook，再从 `skill_registry.skills` 选择 Skill，只能调用其 allowlist 中的 Operation。读操作直接执行；写入、LLM 和外部副作用形成持久 proposal，只有使用者明确确认后才能通过独立 `confirm` 命令执行一次。

Codex/Claude 也可以作为 OfferU 托管的本地深度执行器。它们不拥有求职工作流控制权、数据库写入权或长期隐藏记忆，只提交任务结果、证据和待确认动作。

### 4.2 内置主 Agent 路线

Pi 负责 AgentSession、模型适配、上下文压缩、流式事件和工具循环；Python Run Host 持有 Skill 版本、Operation schema、权限、确认、审计、幂等和事实门。Pi 的文件、Shell 等通用 Coding Agent 工具默认关闭，不能成为第二业务后端。

两条路线共享同一 Skill Registry 和 Operation Registry，但不共享进程边界：内置 Agent 使用进程内工具投影，外部 Agent 使用 CLI/MCP 或托管 adapter。

## 5. 当前 partial Skill

| Skill | 缺失能力 |
|---|---|
| `scan_jobs` | 岗位抓取 Operation、浏览器岗位存活检查 |
| `application_assistant` | 浏览器表单识别与填充 |
| `contact_outreach` | 联系人搜索与来源验证 |
| `interview_risk_review` | 实时雇主口碑研究 |
| `market_calibration` | 实时市场与政策数据 |
| `offer_review` | 法律结论；产品只应提供条款引用和问题清单 |

## 6. 后续顺序

1. 把剩余 Operation 的参数模型迁入严格 JSON Schema，目标是已发布 Operation 的 schema 一致率 100%。
2. 选择并落盘唯一投递事实模型，迁出仍直接读写遗留 `Application.status` 的 Operation。
3. 完成托管执行器的通用文件产物 handback、审核、接受与拒绝契约。
4. 建立浏览器 read/fill/send 风险分层，先完成岗位存活检查，再考虑受控表单填充。
5. 实现 `offeru tui`，但只能作为 Operation Registry 的薄控制面。
6. 扩展 Cursor、OpenCode、Qwen、Kimi、Grok、Antigravity 等宿主投影；不得复制独立业务流程。

## 7. 生成与漂移检查

```powershell
Set-Location backend
python scripts/generate_agent_skill_projections.py --write
python scripts/generate_agent_skill_projections.py --check
```

生成文件禁止手改。需要改变 Skill 身份、alias、版本、allowlist 或 partial 状态时，只修改 `backend/app/services/agent_skill_registry.py`，再重新生成投影。

本轮按项目约束未执行构建、语法检查或测试；状态来自当前代码、CLI manifest 和外部投影的静态核对。表中数量是 2026-07-30 快照，不是永久能力清单。
