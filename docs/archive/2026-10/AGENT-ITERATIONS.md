# OfferU Agent 迭代记录

> 已归档（2026-10-30），2026-10-26 后停更，只作参考。

记录内置 Agent 与「我的 Agent」接入相关的产品设计讨论、评估测试过程和数据指标。按时间倒序追加；每条写清：问题、决定、证据、遗留。

约定：
- 数据只写实测值，并注明来源（命令、接口、日志）。推断要标「推断」。
- 不记录密钥、个人档案内容等敏感信息。
- 未合并的改动注明所在分支 / PR。

---

## 2026-10-26 迭代：Agent 面板、我的 Agent 接入、模型默认值

分支：feat/agent-panel-polish（PR #153，worktree H:/tmp/offeru/wt-agent-ui）。首个 commit 64f7333，其余改动尚未提交。

### 1. 右侧 Agent 面板 UI

用户反馈：
- 面板要能左右拖动调宽。
- 原样式「毛糙」，文字对齐和排版乱；工具调用行、Ask 卡片不够扁平紧凑。
- 第一版恢复了植物编织纹理，用户随后要求：背景改回纯色，只优化消息气泡和工具调用气泡。
- 顶部「使用我的 Agent」大卡片、托管 / 内置助手 / 模型设置 / 阶段 / ready 那排 chip 不清晰，要删。
- Skill 下拉框改为输入框里的 / 斜杠菜单（参考 Codex 客户端）。
- 空态提示改为浅色小字。

决定与实现：
| 项 | 决定 |
|---|---|
| 右栏调宽 | 范围 300 到 760px，默认 380；主内容至少留 480px；方向键步进 16，Shift 步进 64；Home/End；双击复位；窗口缩放自动 clamp；宽度持久化到 offeru.contextRail.width |
| 背景 | 撤销编织纹理（SVG 噪声、repeating gradient、fabric 变量、backdrop-filter），面板与标题栏用纯色 var(--surface) |
| 用户气泡 | surface-muted 纯色，圆角 14/14/4/14 |
| 工具调用 | 合并成一个纯色分组块，每次调用一行 26px，细分隔线，hover/展开高亮，错误标红 |
| Ask 卡片 | 去掉半透明白色，改用设计 token，扁平紧凑 |
| 顶部 | 只留一行极简标题栏：左侧会话标题（点开看历史），右侧「模型」和新对话；外部执行器图标仅在有托管会话时出现 |
| Skill 选择 | 删除下拉框和「确认身份 / 异常检测」快捷按钮；输入 / 弹出技能菜单（数据来自 GET /skills），上下键选择，Tab/Enter 插入 /skill_id |
| 记忆导入/导出 | 移入历史对话面板 |
| 空态 | 居中浅色小字，不用气泡 |

Skill 生态方向（用户确认）：OfferU 内置 + 本机共享目录（只读导入，~/.agents/skills、~/.claude/skills）。需后端扩展扫描路径，单独 PR。

回归问题：
- 报错卡片里「配置内置 Agent」按钮文字不可见。原因：该按钮是 Link，全局链接颜色覆盖了 Tailwind 的 text 颜色类，深色字压在深色背景上。修复：背景色和文字色改为内联 style，加 no-underline 和 hover 效果。其他深色按钮是普通 button，未受影响。

### 2.「使用我的 Agent」接入链路

用户问题：怎么导入、用的是哪个 Agent、记忆怎么导入、历史对话在哪看、怎么知道导入成功。

代码确认的事实：
- 方向是反的：offeru connect（backend/app/entry.py）不是把用户的 Agent 导入 OfferU，而是让用户的 Agent 能调用 OfferU。它把 OfferU Skill 装进每个检测到的 Agent 的 skills 目录，再装一份到 ~/.agents/skills；检测到 codex / claude 时注册 offeru mcp 为 MCP 服务。
- 「已连接」只在 connection_verified 且 status 为 ready 时成立，需要在 Agent 里实际调用一次 OfferU 完成回读。只装 Skill 不算连接。
- 候选优先级：claude, codex, omp, gemini, pi。界面此前从未展示候选列表和当前选中项，属于设计缺陷。
- 记忆不会自动读取：POST /api/agent/memory/import 只接收用户手动选择的文件。
- 用户在 Claude Code / Codex 里的本地对话 OfferU 读不到；只能看到 OfferU 派发的托管会话。
- 「复制提示词」那段长文本是给只能聊天、装不了 Skill 的 Agent 的兜底（材料协作），不是主流程。

决定与实现：
- 设置页「我的 Agent」改为逐个 Agent 的清单：名称、状态、程序路径、Skill 状态与路径、MCP、最后验证时间，每行有自己的连接 / 验证按钮；未安装的汇总成一行「本机未发现」。
- 后端 agent_connection.py 新增字段 executable_path、skill_path、mcp_status。MCP 状态只读 Codex config.toml 和 Claude .claude.json 判断，不启动 CLI。

待做（方案已提，待用户确认范围）：
1. Skill 增加「首次使用」初始化：先只读回读点亮验证，再读档案摘要和岗位工作区，只问一句本次目标；把材料协作提示词里的规则并入 Skill。
2. 安装后每行给一条短启动指令和复制按钮（按 Agent 区分）。
3. 材料协作长提示词只留在折叠项，文案写明适用场景。
4. 记忆导入向导：列出各 Agent 已知记忆文件位置，勾选、预览后导入。
5. 历史：托管会话并入历史列表；读取本地 Agent 会话需用户明确同意，单独做。

本机接入实测（GET /api/agent/runtime/connections，2026-10-26）：
| Agent | Skill | MCP | 已验证 |
|---|---|---|---|
| Codex | 未安装 | 未注册 | 否 |
| Claude Code | 需更新 | 未注册 | 否 |
| OpenCode / OMP / 通用目录 | 需更新 | 不适用 | 否 |
| DSH / Pi / CodeBuddy | 未安装 | 不适用 | 否 |
| Gemini | 本机未发现 | - | - |

结论：当时没有任何一个 Agent 通过验证，4 个装的是旧版 Skill。

### 3. 并发与 Subagent 现状

代码确认：
| 维度 | 现状 |
|---|---|
| 内置 Agent | 每个会话一把锁（embedded_agent_worker.py），同一时间只跑一轮；运行中再发消息作为 steer 注入，或报 A model turn is already running |
| 前端 | 只跟踪一个 activeRunId；等待确认的任务可挂起后开新任务，但不能并行 |
| 批量岗位评估 | 并发默认 2，上限 4 |
| 托管 Codex | 只读沙箱，禁止 subagent、MCP、skills |
| Subagent 编排 | 无 |

建议：先支持多会话并行（每会话独立 worker）并在面板加运行列表；Subagent 编排单独 PR。

### 4. 模型服务默认值

问题：用户从未配置模型服务，却看到「LLM API Key 未配置（provider=deepseek）」，且设置页里删不掉这个 deepseek。

原因：backend/app/config.py 和 routes/config.py 把 llm_provider / llm_model 默认写成 deepseek / deepseek-v4-flash；agents/llm.py 在没有激活配置时自动按 deepseek 处理。它不在配置列表里，所以无法增删改。

决定（当前无存量用户，不考虑旧 .env 兼容）：
- llm_provider、llm_model 默认值改为空，不替用户隐式选择服务。
- 无配置时报「还没有配置模型服务，请先在设置里添加一个。」，仍弹出「配置内置 Agent」按钮。
- 已配置 Key 的读取逻辑保留。
- 残留检查：运行时 config.json（H:/tmp/offeru/wt-agent-ui/backend/config.json）不存在，无 deepseek 残留，llm_api_configs 为空。

### 5. Agent 评估测试（E2E）

E2E 1：让内置 Agent 基于档案写通用简历并导出 PDF。
| 指标 | 值 |
|---|---|
| run_id | run_3f6152e047bf44a2（skill tailor_resume，routing auto） |
| 耗时 | 52.5s |
| 状态 | completed，但未产出简历和 PDF |
| 事件数 | 23 |
| 工具调用 | get_profile、list_resumes 等只读调用 |
| 简历相关表 | resumes 等均为 0 行；无新 PDF |

Agent 行为：判断档案为空，拒绝编造，提示用户补充资料。拒绝编造的行为符合预期。

发现的问题：测试库 djm.db 里 profile_sections 有 16 条有效记录（agent_confirmed），profiles 主表基本字段为空，但 get_profile 汇报「没有任何经历」。推断：get_profile 只读主表字段，没有读 profile_sections，导致 Agent 误判档案为空。待查。

环境问题：一度存在游离数据库 wt-test/backend/offeru.db（根 .env 的 DATABASE_URL 指向相对路径），已把游离的 agent 数据合并进 djm.db（合并前已备份到 backups/20261026-103819，integrity_check 为 ok），并注释掉根 .env 的 DATABASE_URL；对应修复见 PR #152。

### 6. 验证指标

| 检查 | 结果 |
|---|---|
| 前端 tsc --noEmit | 0 错误 |
| 前端 vitest | 2 个文件，15/15 通过 |
| 前端 vite build | 通过 |
| 后端 pytest tests | 59 通过，7 失败 |
| 后端失败原因 | 全在 tests/test_boss_sync.py，WinError 193：假 boss 脚本在 Windows 上不能直接执行。既有环境问题，与本次改动无关 |
| 改动规模 | 首个 commit 5 个文件 +300/-73；面板第二轮 3 个文件 +168/-147 |

### 7. 过程问题（复盘）

- 预览开在 5180，后端 CORS 只允许 7410，页面卡在「正在启动 Python 工作台」。之后预览固定用 7410。
- 两次自动打开浏览器导致出现两个 OfferU 标签页。之后只给地址，不自动打开。
- 有一段时间只做只读调研、没有改代码，约 1 小时无进展。之后改为每步改完立即给预览。
- 命令传输会吞掉星号、反引号和部分 URL，导致 CSS 注释、模板字符串、SVG xmlns 损坏，多次返工。写入后需检查这类字符。
- worktree 用 junction 链接主仓库 node_modules，缺 @tiptap/markdown 导致 tsc 失败；改为在 worktree 里 npm ci。主仓库依赖需重新 npm ci。

### 8. PR 处理记录

| PR | 内容 | 处理 |
|---|---|---|
| #144 / #145 | Dependabot undici | 已 squash 合并，main 到 cf1c929 |
| #146 | BOSS 扫码登录路由 | 用户同意合并，但分支保护要求 approving review，作者不能自批；未用 --admin，阻塞中。BOSS 扫码 404 的原因就是该路由未合并 |
| #147 | — | CI 失败：mcp_server.py 的 import os 被写进 docstring，运行时 os 未定义 |
| #149 / #153 | 都改 AgentPanel.tsx | 建议先合 #149，再 rebase #153 |
| #153 | 本次 Agent 面板 | 待用户预览后提交并推送 |

### 下一步

1. 用户预览 7410 后，提交本轮所有改动并推送到 #153。
2. Skill 首次使用初始化与启动指令（范围待定：并入 #153 或单开 PR）。
3. 排查 get_profile 未读取 profile_sections。
4. 本机 Skill 只读导入、记忆导入向导、多会话并发：各自单独 PR。
5. #146：等待 approving review 或用户调整分支保护。
