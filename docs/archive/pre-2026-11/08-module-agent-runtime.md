# 08 · 模块：Agent 运行时与安全

> 状态：**当前设计权威** · 取代 agent-system、agent-control-plane、harness-integrations、agent-bridge-protocol、agent-tool-contract、run-lifecycle、operation-security、tool-surface-v2、proposal-v2-*、embedded-agent-* 等
> 用户入口：设置 → 「连接我的 Agent」；各页面底部的 Agent 面板 · 主要代码：`backend/app/agent/`（内置内核）、`backend/app/ops.py`（Registry）、`backend/app/services/agent_*`、`proposal_plan_*`、`decision_*`、`career_director.py`、`career_policy.py`；`backend/app/services/agent_bridge/`；`agent-runtime/`；`.agents/skills/offeru/`

## 1. 目的

OfferU 不在通用推理能力上和 Coding Agent 竞争。它的价值是一套 Agent 可以**安全使用**的职业状态、工具、证据、权限和引导体验。

```text
外部本地 Agent（优先）或 OfferU 内置 Agent（兜底）
  → OfferU Skill + 可选的第三方职业 Skill
  → Active Skill Surface（当前任务最小的工具集）
  → Operation Registry
  → Career Runtime
```

## 2. Agent 宿主与连接

- 宿主元数据以代码为准（`agent_host_registry.py`），本文档不写死支持列表。宿主状态区分：已发现 / 已安装 Skill / 已验证 / 认证被阻塞 / 不兼容 / 不可用。**找到可执行文件 ≠ 已支持。**
- **一个窗口**「连接我的 Agent」：发现本地宿主 → 把 runtime-bound Skill 安装到共享的 Agent Skills 目录（宿主专用位置作为可选适配）→ 宿主读取当前视图并完成短时 Registry nonce 回读 → Desktop 显示验证证据。
- 发现阶段不跑 CLI 的 `--help` / `--version` 探测，不启动推理会话。nonce 回读只证明工具链路通了，**不能**冒充「模型已登录、原生 Ask 可用、可联网、支持流式」的验收。
- 宿主自己管理账号、登录和模型；OfferU 不复制宿主凭据，也不改写它的 auth 文件。
- 消费级 Agent 只使用官方开放、并且实际验收通过的 Connector 或 Remote MCP。不能让云端 Agent 去访问「它自己的 localhost」，假装那是用户的电脑。
- 只能聊天的用户：复制协作说明，主动分享最少的材料，再通过 OfferU 界面审阅后保存。这条路**不算**已验证的连接，也不算 Agent Run。
- 公开的规范 Skill：`https://raw.githubusercontent.com/avabbbb/OfferU/main/.agents/skills/offeru/SKILL.md`。本地 Desktop 只提供与安装绑定的 CLI 投影。各宿主目录（`.claude/`、`.codex/`、`.copilot/`）下的 Skill 都由生成器投影，并有漂移测试保护，不要手改。

## 3. 内置 Agent

- 唯一的内置内核：从 `luyishui/OfferU`（commit `3a446ff9`）迁入的 Python 循环，位于 `backend/app/agent/`，由 `embedded_agent_worker.py` 适配到 Career Runtime、Registry 和持久 Run 生命周期。
- 内核负责模型轮次、流式输出、上下文压缩和会话控制；事实、权限、提案、幂等和审计仍由现有 Python 服务负责。
- `agent-runtime/` 只用于可选的外部 Claude 托管执行器。Replay 是确定性的测试基础设施。外部宿主**不能**另建第二个内核。

## 4. Skill 与工具面（三层）

```text
Operation Registry      全部受治理的业务能力（开发和审计可见）
  └─ Agent Tool Surface      有意暴露给 Agent 的子集
      └─ Active Skill Surface    选定 Skill 后按需加载的最小集合
```

- Agent 先读取精简的 Skill 元数据，再按需加载 Operation schema。默认目录为空，内部 Operation 一律拒绝（失败关闭）。
- 第一方 Skill（如 `profile_onboarding`、`company_research`、`role_intelligence`、`tailor_resume`）的方法文件带有版本号和 sha256。方法本身**不**增加 Operation，也不授予权限。
- 第三方职业 Skill 提供方法论、分析、点评和草稿；它们的产出进入 OfferU 后只是草稿或候选。第三方 Skill 不能自动提交、发消息、读取密钥、直接写数据库，也不能把推断升级为事实。
- **路由**：根据用户目标、最近对话、职业状态、当前页面实体、记忆和实时能力目录自动选择 Skill。失败时的处理见 [02 D-5](./02-interaction-design.md#5-防死锁规则必须可测试)。
- 能力发现的结果按版本缓存，见 [02 H-6](./02-interaction-design.md#6-不硬编码规则)。

## 5. Operation 分级与 Run 授权

| 类别 | 示例 | 行为 |
| --- | --- | --- |
| `read` | 读取岗位、已确认的职业投影 | 授权通过即执行，并审计 |
| `compute` | 本地确定性分析、dry-run、预览 | 不写正式状态 |
| `llm` | 向已授权的 Provider 发送特定类别的数据 | 检查 Provider 和数据类别授权 |
| `mutation` | 采用材料、更新投递、确认记忆 | 按 [02 §4](./02-interaction-design.md#4-打断规则agent-什么时候来找你) 判定为 AUTO 或 REVIEW；受保护的改动走 Proposal |
| `external` | 发信、改动第三方账号 | 默认不提供；必须 AUTHORIZE |

- 读或写由 Registry 元数据声明，不能根据路由名称猜测。未分类的 Operation 一律按有副作用处理，禁止自动执行。
- **Run grant = 系统允许的能力 ∩ 当前 Skill 允许的 Operation ∩ 用户本次授权的数据范围 ∩ 宿主实测可以安全提供的能力。** Grant 记录 Run、Skill 版本、Operation、数据范围、工件目录、网络范围、宿主版本、签发 / 过期 / 撤销时间。Prompt、配置、网页内容都**只能缩小** grant，不能扩大。

## 6. 唯一确认路径

```text
Agent 请求 mutation → schema / grant / context 版本校验 → 持久化 Proposal（尚未授权）
  → OfferU 界面展示摘要、影响、证据、过期时间
  → 用户采用 / 修改 / 跳过（或授权 / 取消）
  → 协调器以 proposal id + 幂等键执行 → 审计 + Run 事件 + 可见结果
```

以下**都不构成** OfferU 的确认：宿主原生的 shell 审批、宿主界面里的「yes」、模型重复调用、CLI 的 `--yes`、环境变量、Skill 指令、网页上的第三方按钮。

- 决定接口只接受当前 Desktop 进程启动时生成的**一次性能力**，由前端通过 Tauri 原生命令提交；这个能力不交给网页 JS、Skill、CLI、MCP 或 Agent 子进程。没有这个能力的普通 HTTP 请求一律失败关闭。
- CLI 和 MCP 可以创建 Proposal，但不暴露确认或拒绝工具。
- **Agent 永远不能批准自己的受保护改动。**

## 7. Run 生命周期

「求职任务」（跨多次对话的目标）、「Agent Run」（一次有授权、可审计的执行）、「宿主会话」（宿主隐藏的模型上下文）是三个不同的对象。**对话和页面导航都不是 Run 的生命周期**（见 [02 D-2](./02-interaction-design.md#5-防死锁规则必须可测试)）。

```text
pairing → ready → running ⇄ waiting_user（ask / review / authorize）
                     │  ↘ interrupted → running（同一宿主会话恢复）| failed
                     ├→ completed（OfferU 已验证必需的结果）
                     ├→ failed（显式错误）
                     ├→ cancelled（用户明确取消，且已确认）
                     └→ reconciliation_required（副作用可能已发生但结果未知；先对账，绝不自动重放）
```

- 一个 Run 同一时刻只有一个写入连接（单写入租约）。Run 创建时冻结 Task、Skill 版本、宿主版本、grant、上下文快照版本和幂等命名空间；每次写调用都要带上它所基于的版本。
- 等待用户时，只读 Operation 仍然可以执行，对话仍然可用；只是不再发起新的副作用。
- 换宿主时，结束原 Run 并创建新 Run，不从 `interrupted` 状态跨宿主恢复。

## 8. Career Director 与自动化

- 唯一的自动化骨架：`AutomationEvent → AutomationRule → CareerTask → Agent / Runtime → Operation`。Runtime 负责租约、检查点、恢复和去重；外部 Agent 每次只做一个有边界的任务并返回持久产出，**不能**自建调度器。
- 第一批触发器：首次建档发现、每日职业简报（打开「今天」时幂等触发一次）、保存岗位后的评估、面试准备与复盘、简历更新后的重新联系评估。
- 输出必须结构化（行动、目标、证据引用、Operation、Skill、自主等级、`why_now`），由 Runtime 根据 Registry 策略和来源指纹校验，再物化到「今天」、收件箱、CareerTask 和 Proposal。
- 自主等级的交互判定见 [02 §4](./02-interaction-design.md#4-打断规则agent-什么时候来找你)。当前 `career_policy.py` 要求所有 L2 及以上的动作都设置 `requires_user=true`，属于需要放宽的机械规则（L2 应按可逆性和已有授权判断）。
- 主动性的质量指标：用户主动发起的任务比例、主动建议的接受率、首个动作是否有用、重复或过期建议、用户纠正率；同时保证自我确认、未审核的事实写入、未授权的外部动作都为 0。

## 9. 凭据与数据安全

- 连接 token 和主密钥只存在 OS keychain，数据库只保存不透明引用；pairing token 通过环境变量或受限管道传递，不进入 argv、浏览器或模型上下文。
- stderr、Run 事件、工件清单、Eval trace、崩溃报告都经过结构化脱敏。完整邮件、身份证明、Cookie、模型 Key、表单值不进入通用上下文。
- 网页、JD、日历标题、简历 diff、用户的复盘回答都视为**不可信输入**（防提示词注入）。
- 宿主子进程使用最小环境变量白名单（例如 CodeBuddy 的会话变量会污染子进程，详见 `AGENTS.md`）。

## 10. 已知技术债

- 数据模型中存在两套审批模型：`ProposalExecutionPlan / ProposalConfirmationGroup / ProposalOperationNode / ProposalConfirmationDecision / ProposalExecutionReceipt` 与 `ProposalPlan / DecisionGroup / OperationNode / ConfirmationDecision / ExecutionReceipt`。必须收敛为一套，并统一调用方和 schema（见 `RELEASE_CHECKLIST.md` 中审批迁移相关条目）。
- `ops.py` 中 `requires_confirmation = is_mutation and not preparation_only`，把「是否写入」和「是否打扰用户」耦合在了一起。
- PROPOSAL：Run 的 interrupt 与恢复语义对齐 AG-UI 1.0（见 [02 §10](./02-interaction-design.md#10-协议对齐方向)）。
