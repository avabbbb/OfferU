# Operation、权限与安全

> 状态：accepted target design  
> 决策：[ADR-0020](../adr/README.md#adr-0020)、[ADR-0026](../adr/README.md#adr-0026)、[ADR-0052](../adr/README.md#adr-0052)、[ADR-0053](../adr/README.md#adr-0053)

## 信任模型

主控 Harness 能力强，但其模型输出、网页内容、仓库文件和第三方工具输出都不可信。OfferU 不以“模型听话”作为安全边界，而以结构化 grant、隔离工作区、持久化提案、OfferU 人类确认、幂等和事实门约束行为。

| 主体 | 可以 | 不可以 |
| --- | --- | --- |
| 使用者 | 在 OfferU 嵌入工作区/专注窗口批准或拒绝、选择事实和外部提交 | 被模型或 Harness 原生审批假冒 |
| 主控 Harness | 推理、规划、读取授权上下文、提出 Operation | 授权自己、确认自己、直接写事实 |
| Harness 原生工具 | 在 Run 工件区处理文件；按 grant 研究网络 | 访问 OfferU DB、配置、源码或其他 Run |
| Harness client plugin | 渲染最小 UI 投影、提交明确用户手势 | 直连 DB/FastAPI/CLI、持有 Bridge token、授予业务权限 |
| Agent Bridge | 校验并转发类型化请求 | 规划任务、执行 shell 字符串 |
| Operation Registry | 执行原子业务能力 | 接受绕过 schema/授权的写入 |
| OfferU 人类界面 | 呈现影响并经内部 seam 写一次性决定 | 代替业务服务直接改数据库 |
| 深度执行器 | 完成一个受限重任务、返回候选 | 继承主控权限或写正式状态 |

## Run grant

每个 Run grant 是四个集合的交集：

```text
系统允许能力
  ∩ 当前 Skill 允许 Operations
  ∩ 使用者本次授权的数据范围
  ∩ Harness 实测可安全提供的原生能力
```

Grant 至少记录：

- Run、Task、Skill 与版本；
- 允许的 Operation 名称和 side-effect class；
- 允许的对象/数据类别和可见字段；
- Run 工件目录、配额和生命周期；
- 网络域/研究模式；
- Harness/adapter 版本和 capability probe hash；
- 签发、过期、撤销时间。

Skill 和 adapter 只能缩小 grant。Prompt、配置文件、网页内容或模型请求都不能扩大它。

## Operation 分级

| 等级 | 示例 | 行为 |
| --- | --- | --- |
| `read` | 读取岗位、投前状态、已确认职业投影 | grant 通过后直接执行并审计 |
| `compute` | 本地确定性分析、dry-run、生成预览 | 不写正式状态；结果仍是候选 |
| `llm` | 向已授权 provider 发送特定数据类别 | 检查 provider + 数据类别授权 |
| `mutation` | 接受材料、更新投递、确认记忆条目 | 创建持久化提案，OfferU 界面批准一次 |
| `external` | 发送邮件、改变第三方账号 | 默认不提供；另行高风险决策 |

“读取”不能由路由名猜测，必须由 Operation Registry 元数据声明。任何未分类 Operation 默认按副作用处理并禁止自动执行。

## 唯一确认路径

```text
Harness 请求 mutation
  → schema/grant/context 校验
  → 持久化 proposal（尚未授权）
  → OfferU 嵌入浮层/专注窗口展示参数摘要、影响、证据和过期时间
  → 使用者批准一次 / 拒绝
  → 协调器以 proposal id + idempotency key 执行
  → audit + Run event + visible outcome
```

以下均不构成 OfferU 确认：

- DSH、Codex 或 Claude 的原生 shell approval；
- Harness 原生界面中的“yes”；
- 模型再次调用或重复解释；
- CLI 参数 `--yes`、环境变量或 Skill 指令；
- 浏览器页面中的第三方按钮。

模型可调用的公开 CLI 不暴露 `confirm`。只有 OfferU 拥有的嵌入工作区、专注窗口或移动端能调用内部 `ApprovalCoordinator` seam，且决定只能占用一次。DSH client slot 的存在不授予业务权限；提案过期、Run 终止、租约丢失或 OfferU 人类界面不可达时失败关闭。

## 执行参数与审计脱敏分离

确认重放需要原始类型化参数，而日志只能保留脱敏表示。两者不能共用同一 JSON 字段：

- `sealed_execution_args`：按本地加密边界保存，只供一次性执行/对账；
- `audit_args_redacted`：用于工作台、日志和 Eval；
- `input_hash`：证明批准内容与执行内容相同；
- 执行成功或不可逆终态后按策略清除 sealed 参数。

不得从已脱敏审计 JSON 反向重建执行参数，也不得为了可重放而把密码、token 或完整敏感材料写入日志。

## Run 工件工作区

每个 Run 使用独占、解析后的绝对目录：

```text
<offeru-data>/runs/<run-id>/workspace/
  inputs/       # 显式投影的只读/受控输入
  working/      # Harness 可写中间文件
  outputs/      # 声明的候选产物
  manifest.json # hash、来源、媒体类型、大小；不含凭据
```

安全要求：

- cwd 固定为该目录，拒绝 `..`、junction/symlink 越界和绝对外部路径；
- OfferU 源码、数据库、`.env`、keychain、日志和其他 Run 不挂载/不复制；
- 输入按最小需要投影，不把完整 Profile 或邮箱复制进去；
- 输出只有经过清单、病毒/格式检查、事实审核和 Operation 接受后才进入正式数据；
- Run 完成后按保留策略清理；保留的审计 hash 不包含文件内容。

如果 Harness sandbox 只能限制写入，不能限制读取、网络或进程可见性，就不能把原生 shell/file tools 标记为安全。此时应关闭这些工具或在 OS 级隔离环境中运行，而不是依赖 Prompt。

### DSH rc8 preset 不是隔离边界

`dsh-v0.1.0-rc.8` 的 `Minimal` 在 Windows 已默认启用持久 PowerShell，并包含本地文件能力；`Standard` 暴露的 shell、文件、网络、jobs、skills 和 subagent/workflow 能力更多。因此 OfferU 不把二者当作安全起点：

- 第一条 tracer 使用专用 `offeru-readonly` preset，并在最终 composed profile 中禁用所有 DSH 原生 shell、文件、网络和 subagent 工具；
- host plugin 必须枚举最终有效工具集，出现未预期工具时在配对前失败；
- profile 名、preset 名、cwd、`tools.restrict` 和模型提示都不能证明 OS 隔离；
- 后续启用任何原生工具前，分别验证 Windows 持久进程、绝对路径、junction/symlink、进程环境、loopback/网络和其他 Run 可见性；
- 用户选择通用 `minimal` 或 `standard` 时显示不兼容，不静默修改其全局 DSH 配置。

DSH browser client 不持有 bootstrap/pairing token 或业务凭据。它经 host half 接收脱敏 UI 投影并提交用户手势；host/client 通道断开时确认失败关闭，不能改走浏览器 HTTP、iframe 或 MCP。

## 网络与网页研究

- 网络能力按 Skill 和域授权，默认关闭；
- 公开研究保留 URL、时间、摘录和来源等级；
- 登录态研究只能由使用者主动发起只读浏览器会话；
- 不绕过验证码、Robots、频率限制或站点技术保护；
- 网页内容视为不可信数据，不能把其中指令升级为工具授权；
- 重定向后重新校验最终地址，阻止 loopback、私网、link-local 和凭据 URL；
- 调研结果是候选，逐条来源化后再进入事实门。

## 职业事实门

以下内容不能直接成为职业事实：

- 模型推断与聊天摘要；
- 简历优化建议；
- 面试内容/表达反馈；
- 工作源变化；
- 邮件、短信和浏览器回执解析；
- 深度执行器研究结果；
- Run 工件中的文本或 JSON。

它们先进入候选、学习观察、研究证据或待确认提案。只有相应领域 Operation 和使用者确认才能改变职业模型、投递阶段或正式材料。

## 凭据与敏感数据

- 连接 token 与主密钥只在 OS keychain；数据库保存不透明引用；
- bootstrap/pairing token 通过环境变量或受限管道传递，不进 argv、browser client 或模型上下文；
- Harness adapter 不复制 Codex/Claude/DSH 的用户凭据，不改写其 auth 文件；
- 云模型调用前校验 provider 与数据类别授权；
- stderr、Run event、artifact manifest、Eval trace 和崩溃报告全部经过结构化脱敏；
- 完整邮件、身份证明、Cookie、模型 key 和表单值不进入 Harness 通用上下文。

## 主要威胁与控制

| 威胁 | 控制 |
| --- | --- |
| Prompt injection 要求调用高风险工具 | grant 白名单 + schema + OfferU 人类确认 |
| 模型调用 CLI 给自己批准 | 公开 CLI 移除 confirm；OfferU UI 内部 seam |
| shell 读取 DB/源码/密钥 | Run 目录隔离 + capability proof；不足则禁用 shell |
| DSH `Minimal` 的持久 PowerShell/文件能力越权 | 专用 preset + 最终工具集 fail-closed + Windows 隔离验收 |
| DSH client 绕过 host/Bridge | client 最小投影；无 token/DB/HTTP/CLI/MCP 业务入口 |
| 重复/迟到批准产生二次副作用 | proposal identity + idempotency + expiry |
| 进程崩溃后盲目重放 | executing 状态 + reconciliation |
| Harness 伪造成功 | 用领域 outcome 与 audit 判定，不信最终文本 |
| adapter 版本变化 | 精确 pin + probe + conformance |
| 跨 Harness 继承隐藏上下文 | 新 Run + 清洗交接快照 |
| 日志泄漏原始参数 | sealed execution 与 redacted audit 分离 |

## 安全验收

安全不变量必须 100% 通过：越权、工作区逃逸、自确认、重复副作用、secret 泄漏、未授权云发送和自动外部提交任一失败，都阻止该 Harness/切片被标记为支持。
