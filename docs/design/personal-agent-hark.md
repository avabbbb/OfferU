# OfferU Personal Agent 设计与验收清单（对标 Hark 级体验）

> 2026-11-27。在严格遵守 OfferU 本地优先、五种记录模型（`profile / memory / job / event / doc`）、无服务端用户存储、不碰风控平台的前提下，补齐对标 Hark Pro 的 5 项 Personal Agent 核心体验。

## 1. 对标映射

| Hark 核心体验 | OfferU 落地模块 | 代码位置 |
| --- | --- | --- |
| **Action Buttons（主动建议 + 一键触发）** | 确定性主动建议引擎 + 今天页 / Agent 空状态一键卡片 | [proactive.ts](../../packages/core/src/agent/proactive.ts)、`GET /api/agent/proactive`、[ProactiveActionStrip.tsx](../../frontend/src/components/workbench/ProactiveActionStrip.tsx) |
| **Projects（按目标隔离的工作空间）** | 按岗位编码的专属对话线程（`conv_job_<id>_<hex>`，零表迁移）+ 系统提示自动注入岗位上下文 + 历史列表按项目筛选 | [run-state.ts](../../packages/core/src/agent/run-state.ts)、[prompt.ts](../../packages/core/src/agent/prompt.ts)、[AgentHistoryList.tsx](../../frontend/src/components/workbench/AgentHistoryList.tsx) |
| **Memory Layer（透明记忆与偏好治理）** | Agent 顶栏 / `/memory` 记忆抽屉：待确认记忆一键生效、生效偏好列表与「记住一条偏好」、已确认记忆检索与可撤销「忘记」 | [AgentMemoryDialog.tsx](../../frontend/src/components/workbench/AgentMemoryDialog.tsx) |
| **Panels（交互式产出迷你面板）** | 从真实工具结果自动生成可点击的岗位卡、日程卡（直达链接 + 一键完成）、文档卡、新记忆确认条与改动一键撤销条 | [AgentOutputPanels.tsx](../../frontend/src/components/workbench/AgentOutputPanels.tsx)、[agentToolPresentation.ts](../../frontend/src/lib/agentToolPresentation.ts) |
| **Live Execution Transparency（实时可视化执行窗）** | 将 24 个核心工具的运行态与完成态翻译为中文步骤标题、参数摘要与结果统计 | [EmbeddedAgentStreamView.tsx](../../frontend/src/components/workbench/EmbeddedAgentStreamView.tsx) |

## 2. 验收清单

1. **主动建议 & 一键执行**：打开今天页或新开 Agent 对话，自动出现基于真实库数据的优先动作（如「N 条职业记忆待确认」「评估 N 个未打分岗位」「48 小时内笔面试准备」）；点「全部确认」一次生效且可撤销；点其他动作自动打开 Agent 并带入对应岗位项目上下文执行。
2. **岗位项目隔离**：从带 `job_id` 的动作或岗位卡片触发对话，会话自动使用 `conv_job_<id>_*`，Agent 顶栏显示紫色项目胶囊，后端系统提示自动注入该岗位状态、分数、关联文档与日程，历史对话支持按「岗位项目」筛选，分叉对话保持同一项目归属。
3. **长期记忆透明可控**：点 Agent 顶栏大脑图标或输入 `/memory`，可见待确认记忆、生效偏好与已确认记忆；支持一键确认、记住新偏好、忘记任意一条（均写入 `changes` 表可撤销）。
4. **交互式产出面板**：Agent 写入岗位、日程、文档、记忆后，消息流下方直接出现结构化迷你面板，支持直达详情页、一键定制简历、标记日程完成、确认新记忆和一键撤销。
5. **实时中文执行步骤**：Agent 调用工具时不再显示裸英文名（如 `save`、`list`），而是展示中文动作、关键参数与结果条数。
6. **跨形态一致**：所有能力基于 `packages/core` 与无状态 HTTP 路由，在网页版（IndexedDB）、网页直连本机伴侣（`offeru start --web`）与本机桌面伴侣上行为完全一致。
