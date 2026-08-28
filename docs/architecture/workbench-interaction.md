# OfferU 原生工作区交互

> 状态：accepted target design；DSH 映射校准到 `dsh-v0.1.0-rc.8`
> 决策：[ADR-0030](../adr/README.md#adr-0030)、[ADR-0031](../adr/README.md#adr-0031)、[ADR-0053](../adr/README.md#adr-0053)、[ADR-0055](../adr/README.md#adr-0055)、[ADR-0056](../adr/README.md#adr-0056)
> DSH 接缝：[Harness 接入](./harness-integrations.md#deepseek-harness-rc8第一条-tracer)

## 交互结论

本地 Coding Agent 使用者已经把 Harness 当作日常主应用。OfferU 因而不是第二个聊天应用，也不是悬浮在旁边的完整独立工作台，而是嵌入 Harness 的职业操作工作区：Harness 保留提示输入、会话导航和唯一主控 Loop；OfferU 提供求职任务、事实、证据、Operations、候选工件、业务确认和审计。

在 DSH rc8 中，同一套 OfferU 领域投影与交互状态由 DSH 原生渲染器呈现为三个表面：

```text
┌ DSH sidebar ─────────┬ DSH active session ─────────────────────┐
│ DSH workspaces       │ Chat | Trajectory | OfferU              │
│ DSH sessions         │                    ┌───────────────────┐ │
│                      │                    │ OfferU 任务视图   │ │
│                      │                    │ 当前 Task / Run  │ │
│ [OfferU 入口/状态]   │                    └───────────────────┘ │
└──────────────────────┴──────────────────────────────────────────┘
                         └─ OfferU 全局配对/确认浮层（按需出现）
```

OfferU 不注册一个永久占据 DSH 中央区域的全局页面。入口和确认可以是 root/global，主视图则属于当前 DSH session。全局职业数据可在任务视图中浏览，但 Agent 动作、授权和事件必须绑定当前求职任务与 Run。

## 视觉与共享边界

DSH 中的 OfferU 页面直接使用 DSH 原生组件、布局、设计令牌、焦点行为和响应式规则，视觉上属于 DSH，不建立 OfferU 品牌岛。跨 Harness 共享的是类型化领域投影、交互状态机、Operation 合约、确认语义和标准事件，不共享同一套 React 页面或宿主无关视觉组件。

DSH client 只实现薄的宿主原生渲染器；领域判断、生命周期规则、权限和业务动作仍由 OfferU 控制面与无头契约拥有。companion window 使用 OfferU 自有渲染器，但必须消费同一投影和状态机，不能因此维护第二份业务状态。跨 Harness 验收业务与交互语义一致，不要求像素一致。

## rc8 原生表面

| 表面 | rc8 slot | 交互职责 |
| --- | --- | --- |
| OfferU 固定入口 | `sidebar.footer.action` | 连接状态、配对、打开当前 session 的 OfferU tab |
| OfferU 任务视图 | `conversation.view` | 当前 session 内的求职任务、Run、证据、Operations、工件和结果 |
| OfferU 全局浮层 | `shell.overlay` | 配对、业务确认、断连、冲突和跨 session 提醒 |
| 可选 session 动作 | `conversation.session.header.actions` | 请求中断、打开专注窗口等小型快捷动作 |

这些都是 list/additive slots。实现不得占用 `root`、`sidebar`、`conversation`、`details`、`conversation.session`、`conversation.session.header`、`sidebar.workspaces` 或 `sidebar.settings`；它们是 DSH 核心单席位，注册会造成替换，不是“加一个 OfferU 区域”。

## 无活动 session 的入口

`conversation.view` 是 session-scoped，因此首次启动或没有活动 session 时只使用固定入口与全局浮层：

1. 入口显示 `未连接 OfferU`、`待配对`、`已连接` 或 `需要处理`；
2. 点击后在浮层中探测本机 OfferU Bridge，不跳到 iframe；
3. 只有完全空白且未绑定的 DSH session 才显示岗位选择器；使用者从 OfferU 已存在的真实岗位中选择一个，并在 DSH 内创建对应求职任务；
4. OfferU 将该任务一次性绑定当前 DSH session，并展示 profile、preset、cwd 与能力摘要；
5. 关联完成后进入该 session 的 `OfferU` tab；
6. 失败时保留 DSH 当前会话，给出明确原因，不自动切换 Harness 或 preset。

“允许此 DSH 接入 OfferU”是配对决定，不是副作用批准。两者必须使用不同标题、对象、有效期和审计事件。

## OfferU 任务视图

任务视图不复制 OfferU 全局的“今日、机会、材料、进展、面试”导航，也不复制 DSH 的 sidebar、聊天 composer 或 details panel。它只服务当前 session 已绑定的一个真实岗位，并采用任务驾驶舱布局：

```text
┌ 公司 / 岗位 / 任务与 Run 状态 ────────────────────────────────┐
│ 生命周期：准备 → 已投递 → 可选环节 … → Offer / 拒绝          │
├────────────────────────────────────────────────────────────────┤
│ 当前状态 / 下一动作 / 待确认 / 最近结果                        │
├────────────────────────────────────────────────────────────────┤
│ 事实、证据、候选工件与阶段详情                                 │
├────────────────────────────────────────────────────────────────┤
│ Run 事件 / Operation / outcome / 诊断（渐进披露）              │
└────────────────────────────────────────────────────────────────┘
```

生命周期轨道沿用九个现有业务状态，但不是线性完成度：

```text
准备 → 已投递 → [笔试?] → [测评?] → [一面?] → [二面?] → [HR 面?]
          └──────────── 任一投递后阶段 ────────────→ Offer
          └──────────── 任一投递后阶段 ────────────→ 拒绝
```

方括号节点是可选里程碑。后续阶段已有事实而前置可选节点没有事件时，显示“未发生/已跳过”，不显示“已完成”；`offer` 和 `rejected` 互斥。投前选择“不投”是投前任务结果，不进入 `rejected`，也不创建投递尝试。首个 tracer 虽展示完整轨道，但只有投前决策闭环提供真实可执行动作；后续阶段只显示已有事实、进入条件与明确的“尚未接入”。

### 首屏主状态

任务视图不把待确认、错误、运行、下一动作和最近结果铺成同权卡片。首屏只突出一个主状态，按以下固定优先级派生：

1. `待确认`：显示提案对象、影响、证据、有效期和确认入口；
2. `失败/断连`：区分 Bridge 离线、adapter 断开、Run 失败、状态待对账，并给出对应恢复条件；
3. `正在执行`：显示当前 Skill/Operation、开始时间、最新可理解事件和请求中断；
4. `下一动作`：显示现在应做什么、为什么、所需前置事实以及动作归属；
5. `最近完成`：显示经过 outcome 校验的结果以及任务是否仍有下一动作。

较低优先级信息保留在阶段详情和 Run 时间线中，但不得与主状态争夺首要按钮。主状态是注意力投影，不写回或覆盖任务、Run、提案和投递阶段事实。

不再设计一个侵入 DSH 核心布局的常驻“右侧 OfferU 控制栏”。窄幅状态与动作留在 OfferU tab 内；简历深编、摄像头面试等大画布任务打开同一状态边界的 OfferU 专注窗口。

任务视图不能在当前 session 内切换浏览其他岗位。切换岗位必须从固定入口新建或恢复该岗位对应的 DSH session；不能在 A 岗位 session 中仅靠前端选中 B 岗位，就把 B 的上下文注入同一个隐藏模型会话。

## Run 顶栏

每个关联 Run 明确显示：

- Harness 名称、真实版本、adapter 与 Bridge 版本；
- DSH profile、agent preset、session ID、Run ID 和 Skill；
- 输入主权，例如 `DSH Chat` 或 `Codex 原生界面`；
- Operations、数据范围、网络和 Run 工件目录；
- 当前阶段：运行、等待确认、中断、对账、完成或失败；
- 主动作：返回 Chat、请求中断、取消 Run、打开专注窗口。

不使用“AI 在线”“自动运行中”等模糊状态。adapter 断开但 Run 仍可恢复时，应显示“连接中断，尚未确认失败”。

## rc8 tracer 路径

首个纵向切片只证明一条只读求职链路：

1. 精确版本 `0.1.0-rc.8` 的 DSH 以 `offeru` profile 启动；
2. OfferU 固定入口显示 host plugin 与 Bridge 探测结果；
3. 使用者在全局浮层中选择求职任务与 Skill，确认配对；
4. DSH session 的 `OfferU` tab 出现相同 Task/Run identity；
5. 使用者回到 DSH Chat 输入目标，DSH 是唯一提示输入端；
6. host plugin 调用一个真实只读 Operation，任务视图显示同一事件与结果；
7. DSH 给出非空最终回复，OfferU 以领域 outcome 判断是否完成；
8. 刷新 client、重启 Bridge 或卸载 plugin 后，不留下幽灵入口、重复订阅或失控租约。

OfferU client half 不向 DSH 会话悄悄注入普通聊天文本。将来若支持工作区 follow-up，仍须经过单输入写入者协议，并显示来源、顺序与宿主接收确认。

## 全局确认浮层

副作用 proposal 使用 OfferU 自有 `shell.overlay` 表面；DSH 原生 tool approval 与 OfferU 业务确认永远是两件事。确认卡至少包含：

```text
OfferU 业务确认
动作：更新投递阶段
对象：示例公司 / 后端工程师 / Attempt #2
变化：Interview → Offer
依据：邮件候选 #123（发生于 2026-08-19）
来源：DSH session / Run / Operation update_application_status
有效期：还剩 9 分钟

[拒绝] [批准一次]
```

规则：

- 参数、影响、来源、Task/Run 和证据同时可见；
- 敏感值脱敏，但不能脱敏到无法判断动作；
- 只有“批准一次”，没有“本会话全部允许”；
- 重复点击返回同一决定，不执行第二次；
- proposal 过期、Run 结束、数据版本变化或 host 断连时按钮禁用；
- 浮层关闭不等于批准或拒绝，Harness 继续等待或按超时失败关闭；
- DSH 对 shell/file 的原生批准只能进入诊断事件，不能授权 OfferU proposal。

浮层由 client half 渲染，但决定必须交给 OfferU 控制面持久化。client half、DSH 模型和 host plugin 都不能自行生成批准。

## host/client 数据边界

DSH browser client 只取得渲染所需的最小投影：连接状态、Task/Run identity、标准事件、脱敏 proposal、可见领域数据和用户决定结果。它不得：

- 直接调用 OfferU FastAPI、SQLite、Operation Registry 或任意 CLI；
- 持有 Bridge bootstrap token、数据库密钥或云 Provider 凭据；
- 执行 shell，或把 DSH browser 当作业务 API 客户端；
- 使用 iframe 加载完整 OfferU SPA；
- 捆绑第二份 React，或依赖 DSH 内部 DOM 选择器覆盖核心界面。

所有业务请求经过 DSH host half 与 `offeru bridge --stdio`。host/client 类型化通道、断线恢复、背压和身份绑定是 rc8 tracer 的强制验证项；尚未证明时界面显示 `incompatible`，不降级成 HTTP/MCP 旁路。

## 事件与工件

默认时间线只展示用户可理解的标准事件：读取了哪些已确认事实、选择了哪个 Skill、调用了哪个 Operation、为何等待确认、生成了哪些候选工件、改变了哪些业务状态，以及失败发生在哪一层。模型 token delta、provider JSON、内部 reasoning 和命令噪音折叠到诊断视图；OfferU 不展示或持久化隐藏思维链。

Harness 生成的文件先进入候选区：

| 状态 | 含义 |
| --- | --- |
| `candidate` | 已声明并完成安全扫描，尚未进入正式业务 |
| `needs-fact-review` | 含可能的职业事实，需逐项核对 |
| `accepted` | 已经相应 Operation 接受并关联领域对象 |
| `rejected` | 使用者拒绝，不进入正式状态 |
| `stale` | 上下文或来源变化，需重新生成/核对 |

“生成成功”不等于“已应用”。任务视图必须说明哪个工件已接受、哪个仍待审核。

## 中断、恢复与专注窗口

“请求中断”先调用 Harness 原生 interrupt，并显示宿主是否确认、是否有 executing Operation、是否需要对账和能否恢复同一 session。不能恢复时，使用者可以结束 Run，或显式交接到另一 Harness；交接创建新 Run，不迁移隐藏推理或原生进程状态。

专注窗口只用于简历深编、面试摄像头/音频、复杂证据核对等大画布任务。它复用同一无头领域投影、交互状态机、Task/Run identity、proposal 与 Operation Registry，并由 OfferU 自有渲染器呈现；它不启动第二个主控 Agent，也不改变 DSH 的提示输入主权。

对于没有安全 UI extension point 的 Codex、Claude Code、OpenCode 或 Pi，OfferU 打开消费同一无头契约的 companion window。跨 Harness 一致性要求是 Run、Operations、确认、事件和审计一致，不强求相同组件、slot 名称或布局。

## 移动端

移动端只支持查看 Run、批准/拒绝、更新投递进展和请求中断。安装 DSH bundle/profile、工件深度审核、简历编辑和面试训练保留在桌面/平板。移动端与 DSH client 共享决定和事件，不建立第二套控制面。

## 交互验收

- rc8 中出现固定 OfferU 入口、session 级 OfferU tab 和全局确认浮层，卸载后全部清理；
- DSH 的 Workspace/Session 导航、Chat、Trajectory、details 和 settings 仍正常，未被 OfferU 替换；
- 没有 session 时可完成配对/创建流程，但不会显示伪造的全局 Agent 主视图；
- 切换求职任务会切换或创建对应 DSH session/Run，不共享隐藏上下文；
- DSH Chat 是 tracer 唯一提示输入端，OfferU UI 不暗中注入文本；
- 配对、DSH 原生 approval 与 OfferU proposal 确认可清楚区分；
- client 不直连业务 HTTP/数据库/CLI，不使用 MCP、iframe、第二份 React 或核心 slot replacement；
- proposal 参数和影响可核对，批准恰好生效一次；
- 中断、断连、对账、失败和业务 outcome 都有不同状态与下一步；
- 键盘、窄宽度和 reduced-motion 场景可以完成配对、确认与中断。
