# Harness 接入设计

> 状态：accepted architecture；宿主 API 仍需实时 probe，当前验收状态见下文  
> 优先级：DeepSeek Harness 与 Codex 第一批，Claude Code、OpenCode、Pi 第二批  
> 共同协议：[Agent Bridge](./agent-bridge-protocol.md)

## 当前验收状态（2026-08-28）

- Main Agent UI 消费 provider-neutral `AgentRuntimeProvider`；Pi/Replay 是当前已覆盖的本地适配路径。
- Operation Registry 的全局 Route mutation 审计为 `PASS_GLOBAL`；适配器、插件和自动化不能把领域写入当作自己的事实。
- Codex App Server 适配器有结构化协议边界，但本机真实认证仍为 `BLOCKED_EXTERNAL_AUTH`，不得由 OfferU 修改凭据或静默切换 Provider。
- DSH 仍是可替换的后续 Provider；现有协议/插件资料不等于独立 DSH AgentRun live 验收。
- `job-search` 是首个真实公开源 Capability Plugin 的实现与契约验证；它的 live Role Intelligence 采集结果必须另行记录为 `PASS` 或 `INSUFFICIENT_SAMPLE`，不能用 fixture 结果代替。

## 接入原则

每种 Harness 保留自己的会话、模型、compaction、原生工具和事件语义；OfferU 只编写薄接入包，把这些差异映射为同一行为契约。适配层不得包含岗位、简历、投递或职业记忆逻辑。

```ts
interface HarnessAdapter {
  probe(): Promise<CapabilityReport>;
  start(input: StartRunInput): Promise<HarnessSessionRef>;
  resume(ref: HarnessSessionRef): Promise<void>;
  steer(input: UserInput): Promise<"accepted" | "unsupported">;
  interrupt(reason: string): Promise<void>;
  stream(cursor?: string): AsyncIterable<HarnessEvent>;
  close(): Promise<void>;
}
```

对插件型宿主，adapter 可以运行在宿主进程内；对 app-server/RPC 型宿主，adapter 运行在 OfferU 管理的本地进程边界。两者都通过 stdio Bridge 调用业务能力。

## 统一支持门

“已安装”不等于“已支持”。每个 adapter 必须通过：

| 维度 | 必须证明 |
| --- | --- |
| Identity | 真实可执行文件、版本、协议和接入包版本可记录 |
| Session | 创建、恢复、完成与失败可区分 |
| Input | 初始提示、后续提示与运行中转向语义明确 |
| Control | 中断、取消、超时和退出码可归一 |
| Tools | 只暴露当前 Run Operations；参数通过 schema |
| Approval | OfferU 提案只由工作台决定，宿主不能自批 |
| Events | 文本、工具、工件、终态可映射到标准事件 |
| Workspace | 原生文件/shell 工具不能越出 Run 工件区 |
| Recovery | 断开后能恢复或显式标记不可恢复 |
| Failure | 不用假结果、普通文本或另一个 Harness 静默兜底 |

能力矩阵由 `probe()` 生成并写入 Run，不由文档硬编码。某版本失败时状态为 `unavailable` 或 `incompatible`，不能显示绿色“支持”。

## DeepSeek Harness rc8：第一条 tracer

### 精确审计基线

本设计只以官方 tag [`dsh-v0.1.0-rc.8`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.0-rc.8) 为实现基线，对应 commit `141eb6fef83422698aef7a981029e843e8161534`，不是滚动 `master`。DSH 仍明确标记为 Developer Preview；“rc8 源码存在”只表示可为该 tag 编写接入，不表示接口已成为稳定的第三方兼容层。

审计时 npm 的 `next` 指向 `0.1.0-rc.8`，而 `latest` 仍可能指向较早 rc。因此安装器、lockfile、capability report 和验收记录都必须写出 `@deepseek-ai/dsh@0.1.0-rc.8`；裸 `npx @deepseek-ai/dsh ...`、`@latest` 或 GitHub `master` 不能证明运行的是本设计版本。运行时仍以 `dsh --version` 和 composed profile 为事实源。

rc8 已直接证实的宿主能力，与 OfferU 的使用方式如下：

| rc8 能力 | OfferU 用法 | 边界 |
| --- | --- | --- |
| `profile` 按顺序组合 bundles、profile patch、home patch 和 argv patch | 创建独立 `offeru` profile | 启动前检查最终组合，不能只检查包已安装 |
| bundle 用 `dsh.bundle.patch` 声明配置层 | 分发一份 OfferU bundle | bundle 与可运行 profile 不是同一概念 |
| plugin 可用 `ctx.tools.register()` 注册类型化工具 | 注册当前 Run 的最小 OfferU tools | 业务调用仍经 CLI-first Bridge，不用 MCP |
| package 可声明 `dsh.client` 并导出 `./client` | 加载原生浏览器 client half | 这是 rc8 源码支持的预览接缝，不宣称稳定 API |
| Cordis client slots 支持可加式贡献 | 嵌入入口、任务视图与确认浮层 | 只用 list/additive slots，不替换核心单席位 |
| Codex/Claude Code 可按需安装为 DSH Profile Bundles | 作为 DSH 内部 subagent | 不等于 OfferU 的 Codex/Claude 主控 adapter |

rc8 新增的图片输入、`@` 文件/会话引用、Windows 持久 PowerShell、subagent bundle 和 `dsh web` 自动开浏览器可以保留为 DSH 原生体验；OfferU 不复制这些能力，也不把它们改造成业务入口。

### 产品形态：一个安装入口，两面 plugin

OfferU for DSH 是非官方原生集成，不是 iframe，也不修改 DSH 核心。按 rc8 的 bundle/profile/client 结构拆分：

- `@offeru/dsh-plugin`：同一插件包的 host half 与 client half；根导出运行于 DSH host，`./client` 是预构建浏览器入口，并在 manifest 声明 `dsh.client`；
- `@offeru/dsh-bundle`：声明 `dsh.bundle.patch`，依赖并启用 plugin，提供专用 preset 的配置资产；
- `offeru` profile：按顺序组合 `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app` 和 `@offeru/dsh-bundle`；
- 使用者通过精确版本的 `dsh --profile offeru` 进入 DSH 原生界面，DSH 持有提示输入和唯一主控 Loop。

建议目录：

```text
integrations/dsh/
  packages/
    bundle/
      package.json          # dsh.bundle.patch；依赖 plugin
      cordis.patch.yml      # 启用 host/client row 与专用 preset 配置
      presets/offeru/**
    plugin/
      package.json          # host export、./client、dsh.client、rc8 peers
      src/
        host/
          index.ts          # apply(ctx) / cleanup
          bridge-client.ts  # 唯一能启动 offeru bridge --stdio 的一侧
          tools.ts
          events.ts
          capability-probe.ts
        client/
          index.ts
          OfferULauncher.tsx
          OfferUTaskView.tsx
          OfferUOverlay.tsx
        shared/contracts.ts
  pnpm-lock.yaml
```

发布包必须包含预构建 `lib/client.js`、类型与所有运行资产。rc8 的 browser half 使用宿主提供的 React 18 模块；OfferU 必须 externalize/复用宿主 React，不能捆绑第二份 React 或在 DSH 内挂载完整 OfferU SPA。

### rc8 原生 UI 投影

rc8 没有安全的“全局中央 OfferU 页面”席位。正确投影是由 DSH 原生渲染器消费同一 OfferU 无头契约并呈现的三个表面：

| OfferU 表面 | rc8 slot | 类型/作用域 | 用途 |
| --- | --- | --- | --- |
| 固定入口 | `sidebar.footer.action` | list / root | 显示连接状态并打开/配对 OfferU |
| 任务主视图 | `conversation.view` | list / session | 作为当前 DSH session 的 `OfferU` tab |
| 全局浮层 | `shell.overlay` | list / root | 配对、业务确认、断连和全局状态 |
| 可选快捷动作 | `conversation.session.header.actions` | list / session | 中断、打开专注窗口等小动作 |

任务主视图可以浏览全局职业数据，但 Agent 动作始终绑定当前 Task/Run/DSH session。没有活动 session 时，只显示固定入口或浮层中的“选择/创建求职任务并创建 DSH session”流程；不能假造一个脱离 session 的中央 Agent 工作区。

严禁注册 `root`、`sidebar`、`conversation`、`details`、`conversation.session`、`conversation.session.header`、`sidebar.workspaces` 或 `sidebar.settings`。这些是单席位或 DSH 核心已占用表面，注册会替换而不是并排扩展核心 UI。

client half 必须用 `ctx.slots.inject(slot, () => ctx.slots.register(...))` 等待目标 slot 声明并随 plugin 卸载清理。`dsh.client.inject` 只是包关系信息，不保证 slot 激活顺序。rc8 自带的 trajectory client 是 `conversation.view` 的参考实现，但 OfferU 仍需用 tracer 证明目标 slots 在发布包与实际 profile 中存在。

### host/client 与 Bridge 边界

浏览器 client half 只负责渲染和用户手势，不能直接启动 CLI、访问 FastAPI、持有数据库凭据或调用 Operation。host half：

1. probe DSH、Node、adapter 与 OfferU Bridge 的真实版本；
2. 校验 active profile、专用 preset、最终工具集和工作目录；
3. 启动 `offeru bridge --stdio` 并发起配对；
4. 取得 Run、Skill、grant 后注册最小 OfferU tools；
5. 把工具调用、事件和 pending proposal 映射到 Bridge；
6. 通过 DSH 的类型化 host/client 通道向 client half 投影最小 UI 状态；
7. unload 时关闭 Bridge，撤销工具、订阅和租约。

第 6 步的具体 rc8 remote seam 必须在 Slice 2 用编译与真实浏览器 tracer 证明；在证明前它是实施验证项，不在文档里臆造稳定方法名。若该 seam 或任一目标 slot 不存在，adapter 报告 `incompatible`，不能在 DSH 内静默退回 iframe、浏览器直连 HTTP 或 MCP。

业务确认不能复用 DSH Web/CLI 的原生 approval。DSH 原生 approval 只管理其 shell、文件等宿主工具；OfferU Operation 只能由 OfferU client half 的浮层或同状态边界的专注窗口决定。

### 专用 preset 与 rc8 安全边界

rc8 的 `Minimal` 不是 OfferU 的最小权限预设：其 Windows 配置已默认启用持久 PowerShell，并包含本地文件能力。`Standard` 还会启用更多 shell、文件、网络、jobs、skills、subagents/workflows 能力。因此第一条 tracer 必须使用 OfferU 自有 preset：

- 初始只暴露 Bridge 投影的一个只读 Operation；
- 不启用 DSH 原生 PowerShell/Bash、文件读写、文件搜索、网络或 subagent 工具；
- profile 启动后读取最终有效工具集，发现额外工具就拒绝配对；
- 不把 cwd、preset 名称、`tools.restrict` 或提示词当成 OS 隔离证明；
- 后续只有通过 Windows 路径逃逸、secret、进程和网络验收后，才逐项加入原生工具。

Bundle 如何让 rc8 发现并选择随包发布的 agent preset 必须由安装 tracer 证明。安装器只调用 DSH CLI/profile 机制，不直接改 DSH 核心；用户选用通用 `minimal`/`standard` 时明确失败，不自动改写其全局默认值。

### rc8 subagent 不扩大主控边界

rc8 可把 Codex 与 Claude Code 安装为 Profile Bundles，并支持 Codex 的非交互 permission mode 与 named instance。这些是 DSH 主会话内部的 subagent：它们的活动映射为同一个 OfferU Run 下的嵌套事件，不能被记录成第二个 OfferU 主控 Run，也不能借此获得额外 Operations。

OfferU 自己的 Codex 主控 adapter 仍是独立第一批接入；`ExecutorSupervisor` 仍只用于 OfferU 明确托管的隔离重任务。不得利用 rc8 subagent 再造一个跨 Harness 业务编排器。

### 升级、发布与品牌

- 只发布预构建、带 hash 和 lockfile 的 npm/tarball，不依赖 Git 安装时临时构建；
- rc8 release 声明 SQLite 格式不兼容，升级验证使用独立/已备份的 DSH home 与新建 `offeru` profile；
- 每次 DSH 升级重新验证 manifest、profile composition、client boot graph、slots、tool set、host/client relay、Bridge schema 与生命周期；
- 版本或能力不匹配在配对前失败，不在运行中静默降级；
- 产品描述使用“OfferU，兼容 DSH / based on DSH”，包名采用 `@offeru/dsh-*`，并注明非官方、未获 DeepSeek Harness 背书；不把“DeepSeek Harness”放入 OfferU 项目名，也不挪用官方品牌资产。

rc8 官方事实源：[tag 源码](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.1.0-rc.8)、[发布说明](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.0-rc.8)、[Developer Preview](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.0-rc.8/README.zh.md)、[CLI/profile 组合](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.0-rc.8/apps/cli/README.zh.md)、[plugin 开发](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.0-rc.8/docs/user/develop/basic/index.zh.md)、[tool 注册](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.0-rc.8/docs/user/develop/basic/tool.zh.md)、[bundle/profile 发布](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.0-rc.8/docs/user/develop/basic/publish.zh.md)、[品牌规范](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.0-rc.8/BRAND_GUIDELINES.zh.md)。client half 与 slots 还应逐 tag 对照 [`ui-trajectory`](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.0-rc.8/packages/client/ui-trajectory/src/client/index.ts) 和 rc8 client package manifests；它们属于源码级预览证据，不提升为稳定兼容承诺。

## Codex：第一批完整接入

首选接入为 `codex app-server --listen stdio://`，不是屏幕抓取或固定 `codex exec` argv。App Server 提供 thread/turn 生命周期、JSONL 通知、中断和版本匹配的 schema 导出。

目标 adapter：

```text
integrations/codex/
  adapter/
    app-server-client.*
    schema-probe.*
    event-map.*
    tool-dispatch.*
  skill/
    SKILL.md              # 只含 OfferU 工作方式与实时发现入口
```

启动流程：

1. probe `codex --version`，导出当前 app-server JSON Schema；
2. 以 Run 工件目录作为 cwd，启动 stdio app-server；
3. initialize 后创建/恢复 thread；
4. 把当前 grant 投影为 dynamic tools；
5. 收到 `item/tool/call` 时调用 OfferU Bridge；
6. 把 pending proposal 保持为工具等待或结构化 pending 结果；
7. 映射 item/turn events，并用原生 `turn/interrupt` 中断。

Codex 官方当前把 `dynamicTools` 标记为 experimental，因此第一版必须精确 pin 版本并执行 capability probe。若 dynamic tools 不可用，生成 Skill + shell CLI 只能作为开发兼容模式，不能标记为完整支持。OfferU 不修改用户的 Codex Plus/OAuth 配置，不写 `auth.json`，不把会话切到第三方 API bridge。

Codex 自己的 command/file approval 与 OfferU 业务批准是两层独立权限。Codex 只能在 Run 工件目录使用原生工具；即使 Codex UI 批准了一条 shell 命令，也不能因此批准 OfferU proposal。

官方资料：[Codex App Server](https://developers.openai.com/codex/app-server)。

## Claude Code、OpenCode 与 Pi

第二批仍需完整同构，不做“只能发一次提示”的缩水支持。

| Harness | 首选原生 seam | 进入实现前必须证明 |
| --- | --- | --- |
| Claude Code | stream-json / Agent SDK 能力 | session resume、结构化事件、interrupt、受控工具/权限 |
| OpenCode | JSON run/session 或稳定 server seam | session identity、续接输入、取消、事件与 cwd 限制 |
| Pi | 外部 RPC/CLI session | 不依赖 OfferU 内置 Worker；Run 独占 session、工具投影和终态 |

如果某宿主当前版本缺失 steer、恢复或工具暂停能力，adapter 应报告具体缺口。只有补齐或明确改变产品一致性契约后才能标记为支持，不能用轮询普通文本冒充事件协议。

## 主控与深度执行 adapter 不共用

同一个 Codex 或 Claude 可同时出现在两类目录，但 adapter 职责不同：

- 主控 adapter：服务一个 Agent Run，拥有用户目标和完整对话；
- executor adapter：服务一个受限重任务，只返回 candidate 和来源。

两者不得复用 session、工作目录、幂等命名空间或未清洗上下文。`coding_agent_runtime.py` 等现有 hosted executor 代码不直接升格为主控 adapter。

## 发布与升级

- 每个 adapter 独立版本，记录支持的 Harness 版本区间与 Bridge 版本；
- 所有安装/升级入口先显示将安装的本地包、来源、hash 与权限；
- 禁止在线下载并执行未固定版本的脚本；
- conformance 报告包含 Windows 环境，因为 OfferU 首要桌面环境是 Windows；
- 升级失败保留上一已验证 adapter，不改变当前 Run；已运行 Run 不在中途换版本。
