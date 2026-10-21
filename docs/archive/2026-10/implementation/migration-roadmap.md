> 已归档（2026-10-21）：本文不再是当前权威，只用于考古。当前文档：08-module-agent-runtime.md（位于 docs/）。外部 Harness 主控路线已被 App-first + 可替换 Agent 取代。

# 外部 Harness 主控迁移路线

> 状态：approved implementation path；尚未开始代码迁移  
> 目标：[Agent 系统总览](../architecture/agent-system.md)  
> 原则：一次只实现一个端到端纵向切片，旧 Pi 主路径在替代链路通过真实验收前保留

## 结果定义

迁移完成后：

- DSH、Codex、Claude Code、OpenCode 或 Pi 之一承载唯一主控会话；
- OfferU 只保留嵌入工作区/专注窗口、Agent Bridge、Operation Registry、确认、审计与事实源；
- 用户在 DSH、Codex 等 Harness 原生外壳中运行主控会话，并从 OfferU 原生入口选择任务、附着或跳转；两侧看到同一 Run、事件、审批和结果；
- 所有业务调用 CLI-first，无 MCP；
- Harness 原生文件/shell 只能接触 Run 工件区；
- Pi SDK Worker 不再是主路径；
- 五个 Harness 通过同一 conformance 后才显示为支持。

## 运行时探测规则

设计文档保存每个 tracer 的精确上游兼容基线，但不把它冒充本机已安装版本。每次安装、启动和 Eval 仍由 adapter `probe()` 记录 executable、真实版本、协议/schema、接入包版本、profile composition 和能力缺口。

DSH 第一条 tracer 固定为官方 `dsh-v0.1.0-rc.8` / commit `141eb6fef83422698aef7a981029e843e8161534`。截至 2026-08-20，本机 `dsh --version` 仍为 `0.1.0-rc.6`，仓库也没有 `integrations/dsh/`；因此下面是实施路线，不是 rc8 已可用声明。裸 `npx @deepseek-ai/dsh` 或 npm `latest` 不作为版本证据。

| Harness | 首选 seam | 必需门槛 |
| --- | --- | --- |
| DeepSeek Harness | dual-face plugin + bundle + profile + native slots | 精确 rc8 pin；专用 OfferU preset、composed profile、host/client 和有效工具集核验 |
| Codex | `codex app-server --listen stdio://` | 导出当前 schema；dynamic tools 与生命周期能力逐项 probe |
| Claude Code | stream-json / native session protocol | 第二批验证 session、interrupt、events 与隔离 |
| OpenCode | JSON run/session seam | 第二批验证 session identity、续接、取消与 cwd 限制 |
| Pi | 外部 RPC/CLI session | 不得复用 OfferU 内置 Worker |

## 复用与替换

### 保留并深化

| 现有位置 | 目标角色 |
| --- | --- |
| `backend/app/ops.py` | Operation Registry 唯一事实源 |
| `backend/app/services/operation_projection.py` | OperationGateway + ApprovalCoordinator 内部实现 |
| `backend/app/services/agent_run_state.py` | RunCoordinator + provider-neutral EventLog |
| `AgentRunRecord` / `AgentRunEvent` | 外部 Harness Run 元数据与标准事件 |
| 工作台 SSE、提案 UI 与领域视图 | 拆出无头领域投影与交互状态机；各 Harness 使用宿主原生渲染器，保持 Run 镜像、唯一业务确认和中断控制 |
| `coding_agent_runtime.py` | 仅保留托管深度执行器职责 |

### 退出主路径

| 现有位置 | 迁移结果 |
| --- | --- |
| `backend/app/services/pi_agent_host.py` | 外部 Harness 验收后删除主控职责 |
| `backend/app/services/pi_agent_worker.py` | 删除内置 Pi Worker 管理 |
| `agent-runtime/src/worker.mjs` | 删除主控 Pi sidecar |
| `routes/main_agent.py` 中 `PiAgentRunRequest` 与 Pi `/runtime` | 改为 provider-neutral Run/Workbench API |
| 前端 Pi 命名 type/API | 改为 Harness/Run 中性命名 |
| `backend/app/cli.py confirm` | 从模型可调用 CLI 移除；确认只走工作台内部 seam |
| `backend/app/mcp_server.py` 与挂载入口 | Bridge 覆盖现有能力后删除；不得作为兼容或隐藏业务入口保留 |

## Slice 0：协议与 conformance 骨架

目标：在不改变当前产品行为前，固定 Bridge schema 和统一 Harness 支持门。

允许范围建议：

```text
backend/app/services/agent_bridge/protocol.py
backend/app/services/agent_bridge/errors.py
backend/app/bridge_cli.py
backend/tests/agent_bridge/test_protocol_*.py
integrations/conformance/**
```

交付：

- `offeru bridge probe --json`；
- `offeru bridge schema --json`；
- JSONL envelope、错误码、stdout/stderr contract；
- fake Harness adapter 和 transcript fixtures；
- conformance runner 能对同一场景替换 adapter。

验收：畸形 JSON、未知版本、未知 message、stdout 噪音、背压与关闭行为都有确定结果；不调用真实业务 Operation。

## Slice 1：只读 Agent Bridge

目标：真实创建/附着一个外部 Harness Run，并通过 Bridge 读取一个真实 Operation。

实现：

1. 新建 `agent_bridge/server.py`、`run_coordinator.py`、`context_projector.py`、`operation_gateway.py`、`event_stream.py`；
2. 复用 `AgentRunRecord/Event`，增加 Harness identity、session ref、protocol、capability、lease、cursor 和 context version；
3. OfferU UI 新增 pending pairing 与 Run identity 投影；
4. 只投影一个已存在的只读 Operation，例如 `get_pre_application_state`；
5. Run event 覆盖 attach、operation started/completed、message completed、finish。

不做 mutation、OfferU UI follow-up、跨 Harness 交接或旧 Pi 删除。

验收：Bridge 进程重启后可从 cursor 恢复；另一个进程不能抢有效租约；未配对或越权 Operation 失败；OfferU UI 投影看到与 Harness 原生界面相同的 Run/Operation/outcome。

## Slice 2：DeepSeek Harness rc8 原生 plugin tracer

目标：用户运行精确版本 `0.1.0-rc.8` 的 `dsh --profile offeru`，在 DSH 原生外壳内看到 OfferU 固定入口、session 级任务 tab 和全局浮层，并用专用只读 preset 完成一条真实求职链路。

首版任务主体固定为一个已存在的真实岗位：一条空白 DSH session 只能选择一个岗位并创建对应求职任务，绑定后不可改绑。档案维护、通用简历编辑、邮箱处理、面试训练和自由文本目标不在本切片中单独创建 DSH 求职任务。

OfferU tab 的信息架构展示该岗位从投前到 Offer/结束的完整生命周期，但本切片只有投前决策闭环提供真实可执行动作。投递后进展、面试与 Offer 阶段只能显示已有事实、进入条件和“尚未接入”的明确状态，不得放置假动作、伪造结果或用静默降级冒充可用。

任务视图首屏只呈现一个最高优先主状态，顺序固定为待确认、失败或断连、正在执行、下一动作、最近完成；其余信息降级到阶段详情和 Run 时间线，不实现同权卡片仪表盘。

建议目录：

```text
integrations/dsh/
  pnpm-lock.yaml
  packages/
    bundle/
      package.json         # dsh.bundle.patch
      cordis.patch.yml
      presets/offeru/**
    plugin/
      package.json         # host export + ./client + dsh.client
      src/host/index.ts
      src/host/bridge-client.ts
      src/host/tools.ts
      src/host/events.ts
      src/host/capability-probe.ts
      src/client/index.ts
      src/client/OfferULauncher.tsx
      src/client/OfferUTaskView.tsx
      src/client/OfferUOverlay.tsx
      src/shared/contracts.ts
```

实现顺序：

1. 精确安装并锁定 `@deepseek-ai/dsh@0.1.0-rc.8`，记录 tag/commit、npm tarball hash 和 `dsh --version`；
2. 构建预编译 `@offeru/dsh-plugin`：host 根导出、browser `./client`、`dsh.client` manifest，复用宿主 React；
3. 构建 `@offeru/dsh-bundle`，用 `dsh.bundle.patch` 启用 plugin，并让 `offeru` profile 按顺序组合 base、`dsh-web-app`、OfferU bundle；
4. 证明随包 preset 的 rc8 发现/选择机制，创建 `offeru-readonly`，禁用原生 PowerShell/Bash、文件、网络和 subagent 工具；
5. 在启动前输出/检查 composed profile、active preset 与最终有效工具集；不符合精确基线就失败关闭；
6. host half 启动 `offeru bridge --stdio`，通过 `ctx.tools.register()` 只注册一个真实只读 Operation；
7. client half 用 `ctx.slots.inject(...register...)` 注册 `sidebar.footer.action`、`conversation.view` 和 `shell.overlay`，可选注册 `conversation.session.header.actions`；
8. 证明 DSH 的 host/client 类型化通道，让 browser client 只经 host half 读取状态和提交用户手势；
9. 在全局浮层完成 Task/Skill 配对；DSH Chat 是唯一提示输入端，OfferU tab 只镜像和中断；
10. 使用真实 Job/Task 读取状态并给出非空回复；unload/interrupt 清理 slots、Bridge、订阅和租约。

验收必须使用实际安装的 rc8、真实 profile/preset 和 DSH browser session，不以 unit mock 代替，并同时证明：

- 记录 DSH、bundle、plugin、Bridge、React/module graph 与 composed profile；
- OfferU 三个表面出现且卸载后消失，DSH Workspace/Session、Chat、Trajectory、details 和 settings 均未被替换；
- `conversation.view` 与当前 session 绑定；切换求职任务会切换/创建 session 和 Run；
- browser client 没有 Bridge token，不直连 OfferU HTTP/DB/CLI，不使用 MCP、iframe 或第二份 React；
- 通用 `minimal`/`standard` 或出现额外 native tool 时无法配对；首个 tracer 因能力关闭而无法读取/写入 Run 工件区外内容；
- client slot 或 host/client seam 不兼容时明确报告 `incompatible`，不使用 companion/HTTP 旁路伪造 DSH 原生支持。

### rc8 升级门

rc8 release 声明 SQLite 格式不兼容。第一次验证使用独立/已备份的 DSH home 和新 `offeru` profile，不覆盖用户现有 rc6 状态。将来升级 rc9 或正式版时，先在新 profile 重跑 package manifest、bundle order、preset discovery、client boot graph、slots、host/client relay、tool set 和 conformance；通过后才扩大支持范围。

## Slice 3：副作用提案与 OfferU 原生确认

目标：DSH 提出一个真实 mutation，OfferU 的 rc8 `shell.overlay` 浮层批准/拒绝后，同一工具调用得到最终结果。

实现：

1. 把现有 proposal/confirm coordinator 接入 OperationGateway；
2. 将原始执行参数加密保存，与脱敏 audit 分离；
3. 移除/封闭模型可调用 `confirm`；
4. 删除旧 MCP 业务模块和挂载入口，确认新 Harness 只能使用 stdio Bridge；
5. plugin 把 pending 映射为工具暂停/事件 follow；
6. OfferU 浮层显示 Task/Run、影响、证据、过期和批准一次；专注窗口/移动端共享同一决定；
7. 崩溃、重连、重复批准和迟到批准进入幂等/对账路径。

首选验收 Operation 应是可撤销、影响明确的内部状态变更，不能用真实外部发送或投递。批准恰好执行一次；拒绝、超时、OfferU client/host 断连和 Bridge 崩溃执行零次。DSH 原生 approval 不能改变 proposal。

## Slice 4：Run 工件与深度执行委托

目标：主控 DSH 在独占工件区生成候选研究产物，并委托现有托管执行器完成一个公开岗位调研任务。

实现：

- ArtifactWorkspaceManager 创建/验证目录与 manifest；
- adapter 原生工具 cwd 固定到 Run 目录；
- ContextProjector 只投影当前 Job 和必要已确认事实；
- 深度执行器使用独立 session、workspace、grant 和事件；
- candidate 经事实门/OfferU UI 接受后才进入公司/岗位档案。

DSH rc8 自带的 Codex/Claude Code subagent bundles 默认只是主 DSH Run 的嵌套活动，不复用为 `ExecutorSupervisor`。只有经过 OfferU 委托 Operation 创建独立 session/workspace/grant 的任务才计为托管深度执行。

验收包括路径逃逸、symlink/junction、读取 DB/.env/源码、网络越权、未授权数据与跨 Run 访问。任一无法可靠隔离时关闭该原生工具，不用 Prompt 兜底。

## Slice 5：Harness 中性投影与宿主原生渲染

目标：前后端不再假设 Pi 是主控 runtime。

改造：

- `/runtime` DTO 与 UI type 改为 Harness-neutral；
- Run header 显示 Harness/adapter/capability/lease；
- SSE 只消费标准 Run events；
- 配对、审批、中断、恢复、失败和对账成为明确状态；
- Pi 专属 status/文案退出默认路径；
- 把任务视图所需的领域投影、交互状态机、确认语义和事件模型抽成无头共享契约；
- DSH client 使用 DSH 原生组件与设计令牌实现薄渲染器，companion window 使用 OfferU 自有渲染器；两者不共享 React 页面，也不维护第二份业务状态；
- 首版保持 Harness-native input，不同时开放 OfferU 任务视图自由文本输入。

验收：DSH client 刷新、专注窗口刷新、后端重启、Harness 断开和 proposal pending 后 UI 状态不丢；用户能分辨 Harness native approval 与 OfferU confirmation；DSH 内无 iframe 或第二套领域状态。

## Slice 6：Codex 完整 adapter

目标：在同一 conformance 下，以 Codex 替换 DSH 而不改业务代码。

实现：

1. 启动 `codex app-server --listen stdio://`；
2. initialize 并按实际版本生成/验证 schema；
3. thread start/resume、turn start/interrupt 与事件映射；
4. 使用当前版本支持的 dynamic tools 投影 Run Operations；
5. cwd 固定 Run 工件目录，保留用户原生 Plus/OAuth；
6. OfferU proposal 仍由 OfferU companion/native UI 决定，不映射为 Codex 自批。

如果该 Codex 版本的 dynamic tools 或生命周期不满足要求，adapter 标记 incompatible；Skill + shell CLI 只能用于调试，不能宣称完整支持。

## Slice 7：Claude Code、OpenCode、Pi

每个 Harness 独立完成同一流程：probe → read tracer → mutation approval → interrupt/recovery → workspace isolation → conformance。不得为了快速打勾降低行为标准。

Pi 必须作为外部 adapter 重接，不复用现有内置 Node Worker。只有所有仍需支持的真实 Run 都能由外部 adapter 接管后，才进入清理切片。

## Slice 8：删除旧 Pi 主路径

删除前必须同时满足：

- DSH 与 Codex 各有一条真实端到端通过记录；
- 至少一个 adapter 通过重启恢复、确认幂等和工作区隔离；
- OfferU UI 与控制面已完全 provider-neutral；
- 回滚只需要重新启用上一 adapter，不依赖 Pi 业务状态；
- Eval suite 不再把 Pi-specific event/route 当作合同。

随后删除 Pi host/worker/sidecar、Pi DTO 和死配置；保留 Pi 外部 adapter（若已通过）。不要同时重构 Operation Registry 或领域模型。

## 浏览器扩展并行轨

浏览器扩展不阻塞 Agent Bridge tracer，也不能被主控迁移顺手重写。它按 [浏览器扩展](../architecture/browser-extension.md) 的 EXT-1/2/3 独立纵向实施，仍通过同一 Operation Registry。

## Conformance 场景

所有 Harness 至少跑同一组：

1. probe 与版本不兼容；
2. Harness 原生界面与 OfferU UI 配对；
3. 真实只读 Operation；
4. 越权 Operation；
5. mutation approve/reject/expire；
6. 重复 invoke 与重复批准；
7. interrupt 与 cancel；
8. adapter/Bridge/app 重启恢复；
9. executing 副作用对账；
10. Run 工件逃逸与 secret 扫描；
11. completed 但业务 outcome 缺失；
12. same-Harness resume 与 cross-Harness new Run。

DSH rc8 还需附加：bundle/profile composition、三个 additive slots、核心 slot 未替换、host/client 断连、client 无业务凭据、通用 preset 拒绝、Windows 持久 PowerShell 被禁用，以及 DSH 内部 Codex/Claude subagent 只记录为同 Run 嵌套事件。

报告必须同时包含 contract trace 和数据库/领域 outcome；模型最终文字不能作为唯一 grader。

## 风险顺序

| 风险 | 处理 |
| --- | --- |
| DSH Developer Preview/client slot 破坏兼容 | 精确 tag + source-backed seam probe + conformance；不兼容即禁用原生嵌入 |
| npm dist-tag 未指向 rc8 | exact package version + lockfile + tarball hash + runtime version |
| rc8 SQLite 格式不兼容 | 独立/备份 DSH home + 新 profile + 升级门 |
| rc8 `Minimal` 含持久 PowerShell/文件能力 | 自有 preset + 最终工具集 fail-closed；首个 tracer 禁用 native tools |
| Codex dynamic tools 实验性 | 版本 schema + incompatible fail closed |
| Harness sandbox 不是完整隔离 | OS 级实测；不足则关闭 native tools |
| OfferU UI 与 Harness 原生界面双输入竞态 | 首版 Harness-native-only；后续单输入协议 |
| 确认重放泄漏/失真 | sealed args 与 redacted audit 分离 |
| 删除 Pi 太早 | 最后一个切片才删除，先双轨验收 |
| 五 adapter 复制业务逻辑 | Bridge/Registry 单一 contract + conformance |

## 每个切片回传格式

```text
修改文件：
验收目标 → 证据：
真实 Harness/adapter/Bridge 版本：
未执行命令：
已知风险与下一切片：
```

实现 Agent 不得自行新增 ADR、扩大文件范围、引入 MCP 或删除旧主路径。遇到协议/领域冲突、需要新外部权限或必须改变 OfferU 人类确认权威时停止并回传一个阻塞问题。
