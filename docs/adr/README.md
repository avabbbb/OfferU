# OfferU 决策账本

本文件是 OfferU 架构决策的唯一现行账本。ADR 编号保持稳定，其他文档只链接本文件中的编号锚点；后续决策直接追加到这里，不再为每个 ADR 新建文件。

- `accepted`：当前必须遵守。
- `accepted, narrowed`：决策仍有效，但适用范围已被后续决策收窄。
- `superseded`：仅保留历史关系，不再作为实现依据。
- 已提交过的旧 ADR 详细讨论、旧措辞和被拒方案可从 Git 历史恢复；本次整合新增的 ADR-0051–0054 以本账本为首个事实记录。本账本只保留足以指导实现与评审的现行结论。

## 产品边界与基础设施

<a id="adr-0021"></a>
### ADR-0021 — Python 是第一阶段唯一业务后端

`Status: accepted`

Python/FastAPI 是 Agent、记忆、简历、调研、投递、邮箱和面试领域逻辑的唯一事实源。Tauri/Rust 只承担桌面壳、托盘、钥匙串和进程管理等系统桥接；除非有可测量收益，不复制业务能力到第二后端。

<a id="adr-0023"></a>
### ADR-0023 — 第一阶段只建设本地单人版

`Status: accepted; supersedes ADR-0001`

系统只有一个本地拥有者和一份本地数据空间，不引入 `workspace_id`、租户、组织、登录、计费或 SaaS 预埋层。未来若出现真实 SaaS 需求，再按届时的身份、同步和隔离目标重新设计。

<a id="adr-0020"></a>
### ADR-0020 — 连接密钥只存操作系统钥匙串

`Status: accepted`

OAuth token、邮箱应用密码和后续连接密钥由 Windows Credential Manager、macOS Keychain 或 Linux Secret Service 保存。数据库只存账号元数据、授权范围和不透明凭据引用；原始密钥不得进入 SQLite、配置、日志、遥测或 Agent 上下文。

<a id="adr-0024"></a>
### ADR-0024 — 本地敏感数据与旁路副本统一静态加密

`Status: accepted`

由操作系统钥匙串保护主密钥，并统一加密数据库、简历附件、显式保存的邮件正文、搜索索引、缓存和备份。不得产生落在该保护边界外的索引、临时文件、日志或备份副本。

<a id="adr-0026"></a>
### ADR-0026 — 云端模型按供应商和数据类别授权

`Status: accepted`

确定性解析与脱敏优先在本地完成。敏感材料只有在使用者对具体模型供应商和数据类别明确授权后才可发送；配置 API Key 不等于数据授权，授权撤回后相关任务必须失败关闭。

<a id="adr-0047"></a>
### ADR-0047 — Tauri 前端使用 Vite 静态 SPA

`Status: accepted`

桌面前端使用 React 18、Vite 与 HashRouter；开发模式固定由 7410 端口提供，发布模式由 Tauri 加载 `frontend/dist`。业务事实仍归 Python 后端，前端不依赖 Node.js 服务端运行时。

## 职业事实、学习与记忆

<a id="adr-0048"></a>
### ADR-0048 — 以条目级变更账本演进职业模型

`Status: accepted; supersedes ADR-0002 and narrows ADR-0011`

单一长期职业模型由仍有效的变更条目派生，针对岗位只生成投影，不改写主模型。职业证据必须确认；使用者明确陈述的偏好可直接追加；行为信号、Agent 推断、职业假设和程序性策略先进入记忆收件箱。每次生效或撤销都记录前后值、来源、理由、影响和取代关系。

<a id="adr-0011"></a>
### ADR-0011 — 各模块只通过学习观察反哺职业模型

`Status: accepted, narrowed by ADR-0048`

面试、简历、研究和投递模块产生带来源的学习观察，由统一 Memory Service 决定后续处理，业务模块不得直接改写其他模块或整体职业模型。任何观察都不能自动变成虚构经历；写入权以 ADR-0048 为准。

<a id="adr-0012"></a>
### ADR-0012 — 学习观察即时记录、空闲时巩固

`Status: accepted`

交互发生时立即、确定性保存观察；去重、冲突识别、过期判断和长期更新建议在托盘空闲任务中异步完成。巩固失败保留原始观察并可重试，不得静默创建职业证据或改写主控规则。

<a id="adr-0013"></a>
### ADR-0013 — 只同步显式登记的工作源

`Status: accepted`

只读增量同步使用者登记的仓库、作品目录或文档集合，不扫描整个磁盘。默认排除密钥、环境文件、依赖缓存和构建产物；实验或未交付内容不能自动表述为正式成果。

<a id="adr-0016"></a>
### ADR-0016 — 来源删除后级联失效派生记忆

`Status: accepted`

原始来源被删除或撤销授权后，其派生观察、候选证据、档案结论和下游引用立即退出检索、提示、评分与巩固。仅保留不含原文的最小审计外壳；拥有其他独立有效来源的结论可以继续存在。

<a id="adr-0018"></a>
### ADR-0018 — 只提炼匿名简历表达模式

`Status: accepted`

只从公开且允许使用的材料提炼匿名化结构、能力表达和量化方式。不得收集、长期保存或近似复刻候选人完整简历，也不得把他人经历写成使用者事实。

<a id="adr-0025"></a>
### ADR-0025 — 用记忆收件箱审核职业模型变更

`Status: accepted`

变更建议集中展示前后差异、理由、来源、影响和类型，支持接受、拒绝、稍后处理和撤销。系统不得先静默改写再通知，也不以频繁弹窗打断当前任务。

## 调研、投递与外部信号

<a id="adr-0003"></a>
### ADR-0003 — 登录态平台只做使用者授权的只读研究

`Status: accepted`

公开来源可自动研究；需要登录的平台只能由使用者主动发起本机只读浏览器会话。系统不保存平台密码、不绕过验证码或技术保护、不维持无人值守采集，也不执行发布、私信、投递等外部副作用。

<a id="adr-0004"></a>
### ADR-0004 — 研究产物采用公司与岗位双层档案

`Status: accepted`

维护可复用的公司档案和绑定具体公司岗位的岗位档案。证据快照带来源和时间戳，摘要可刷新但旧证据不被静默覆盖；简历、策略和面试准备读取同一岗位档案并引用共享公司档案。

<a id="adr-0017"></a>
### ADR-0017 — 调研来源分级且结论逐条引用

`Status: accepted`

硬事实优先使用官网、招聘官网和正式公告；主观信号至少由两个独立、近期来源交叉验证。单一来源必须标为单一信号，缺乏证据时标记未知，不允许模型补全。

<a id="adr-0005"></a>
### ADR-0005 — 外部消息先形成候选进展

`Status: accepted`

邮箱、短信等信号可同步、解析、去重和候选关联，但模型不能直接改变正式投递状态。高置信信号形成待确认候选，低置信信号进入待归属箱；只有使用者确认后才追加阶段事件。

<a id="adr-0006"></a>
### ADR-0006 — 邮箱采用托盘驻留的本地增量同步

`Status: accepted`

OfferU 运行期间，本地服务可在托盘持续增量同步、生成候选进展和通知；明确退出后停止。第一阶段不建设云端常驻服务或独立系统守护进程，各适配器必须保存游标并支持回补。

<a id="adr-0007"></a>
### ADR-0007 — 一行代表一次投递尝试

`Status: accepted`

每次投递是独立实体，分别保存所用简历、渠道、时间和阶段事件。重复投递可以引用同一公司与岗位档案，但不得覆盖历史尝试。

<a id="adr-0019"></a>
### ADR-0019 — Agent 可建议投递关联但没有写入权

`Status: accepted`

优先以申请编号、邮件线程、公司域名和岗位标识匹配外部信号；Agent 只能对非结构化候选进行排序和解释。多义或仅语义相似时由使用者选择，Agent 不得建立正式关联或写入阶段事件。

<a id="adr-0022"></a>
### ADR-0022 — 邮箱默认只保存最小证据快照

`Status: accepted`

默认只保存求职相关消息的标识、线程、发送者、时间、主题、相关正文片段和正文哈希。完整正文仅在同步和解析时短暂使用，除非使用者对单封邮件显式保存。

<a id="adr-0034"></a>
### ADR-0034 — 先完成可复核投前决策再生成简历提案

`Status: accepted`

主控 Agent 基于已确认职业证据和最近一次完成的岗位研究，提出投、有条件投、不投或证据不足，并逐条引用来源；最终决定与 Agent 建议分开保存。只有使用者确认投或有条件投，才提议生成可审核简历；其余结果和调研中断均是可恢复显式状态。

## 面试边界

<a id="adr-0008"></a>
### ADR-0008 — 内容评价与表达行为反馈分开

`Status: accepted`

默认报告不合并为单一总分。视觉与音频只提供可观察、可解释的行为统计，不推断人格、诚信、心理状态、录用概率或岗位胜任力；内容评价只能引用问题、回答、职业证据和岗位档案。

<a id="adr-0009"></a>
### ADR-0009 — 面试评分规则声明式、版本化

`Status: accepted`

自定义维度、权重、证据、阈值、提示词和聚合方式必须通过 schema 校验并记录规则 ID 与版本。评分 Skill 不得执行任意代码、访问未授权数据或突破内容与表达反馈隔离。

<a id="adr-0010"></a>
### ADR-0010 — 面试视觉只保存派生事件与汇总

`Status: accepted`

原始视频、截图和逐帧 landmarks 只存在于浏览器内存，不上传、不落盘。后端只保存表达事件和会话汇总，并支持按会话删除与导出。

<a id="adr-0014"></a>
### ADR-0014 — 第一阶段采用轮次式语音面试

`Status: accepted`

主控 Agent 逐题提问，使用者逐题录音或改用文字，本地端点检测结束后再转写和评价。默认不保存原始音频；第一阶段不建设可打断的全双工实时语音。

## Operation、Skill 与主控 Agent

<a id="adr-0029"></a>
### ADR-0029 — 所有入口共用一个 Operation Registry

`Status: accepted`

GUI、机器 CLI、TUI、斜杠 Skill 和本地 Harness 都是同一 Python Operation Registry 的适配器，共享 schema、权限、dry-run、确认提案、数据授权、审计、幂等和错误语义。任何入口都不得直接写数据库、执行隐藏 shell 或创建旁路业务状态机。

<a id="adr-0037"></a>
### ADR-0037 — 结构化 Skill Registry 是技能唯一事实源

`Status: accepted`

版本化 Registry 定义 Skill 身份、路由、适用目标、允许的 Operation 和确认边界，并生成各 UI 与 Harness 所需的薄入口。宿主 Markdown 只说明如何发现实时能力，不独立声明业务流程。

<a id="adr-0041"></a>
### ADR-0041 — 旧确定性 Harness 逻辑降为 Guardian

`Status: accepted`

已有阶段判断、异常检测、提醒和记忆候选提取作为确定性前后置 Guardian 保留，但不再拥有独立意图路由、工具注册、工具循环、对话入口或写路径。Guardian 通过同一 Run 事件与事实门呈现结果。

<a id="adr-0042"></a>
### ADR-0042 — 主控执行持久化为求职任务内的 Agent Run

`Status: accepted`

每次执行作为一个求职任务下的 Run，保存输入、Skill、标准化事件、Operation 调用、待确认动作、输出和恢复位置。对话是任务交互记录，领域对象是事实源；不建设跨任务全局 Session，也不按 GUI 页面拆 Run。

<a id="adr-0051"></a>
### ADR-0051 — 外部 Coding Agent Harness 拥有唯一主控 Loop

`Status: accepted; supersedes ADR-0036, ADR-0043 and ADR-0046`

DeepSeek Harness、Codex、Claude Code、OpenCode 或 Pi 承载唯一主控 Agent 的推理会话、任务规划和工具循环。OfferU 只保留确定性工作台、Agent Bridge、Operation Registry、权限、确认、审计和业务事实源，不运行第二套内置主 Agent。

所有宿主通过各自薄接入包连接同一 CLI-first Bridge，不提供 MCP 业务入口，不允许直接访问数据库或使用隐藏 shell。Codex 与 DeepSeek Harness 优先实现；五种宿主只有通过同一行为一致性契约后才标为支持。

<a id="adr-0052"></a>
### ADR-0052 — 主控 Harness 原生工具只作用于 Run 工件区

`Status: accepted`

Harness 可以保留文件产物能力和经 Skill 授权的网络研究，但 Bash、编辑器和文件工具只能作用于当前 Run 独占工件目录。数据库、配置、源码、其他 Run 和未授权职业数据不可见；所有业务读取、提案和写入只能经 Agent Bridge 与 Operation Registry。

接入包必须实际探测隔离能力；若宿主只能限制写入，无法限制读取、网络或进程可见性，就不能标记为安全可用。工件始终是候选，只有经过审核和 Operation 接受后才能成为正式状态。

<a id="adr-0053"></a>
### ADR-0053 — OfferU 拥有的确认界面是唯一确认权威

`Status: accepted`

Harness 可以提出副作用 Operation 并等待，但只有 OfferU 拥有的嵌入工作区或专注窗口中的独立人类交互能够批准或拒绝。该界面即使渲染在 DSH Web 内，也直接连接 OfferU 控制面，不复用 Harness approval；接入包和模型可调用 CLI 不暴露确认能力。离线、断连和超时一律失败关闭，批准按提案 ID 与幂等键只生效一次。

<a id="adr-0054"></a>
### ADR-0054 — 跨 Harness 故障切换必须创建新 Run

`Status: accepted`

无法恢复时不在同一 Run 内静默换宿主。使用者显式交接后，原 Run 保持中断或失败；新 Run 只继承已确认事实、可审计工件、未决提案和清洗后的执行摘要，并使用新的 Run ID、Harness session 和幂等命名空间。同一 Harness 的原生会话恢复可以保留原 Run。

<a id="adr-0055"></a>
### ADR-0055 — Harness 原生界面是主外壳，OfferU 作为嵌入工作区

`Status: accepted; reframes ADR-0031; UI sharing boundary refined by ADR-0056`

本地 Coding Agent 使用者的日常入口是 Harness 原生界面，因此 OfferU 不再以独立工作台或第二聊天应用争夺主界面。接入包在宿主允许时注册固定 OfferU 入口、任务内主视图和 OfferU 自有确认浮层；简历深编、摄像头面试等大画布任务才打开共享同一状态边界的专注窗口。首个 DSH 实现只使用可加式 UI extension points，不替换 DSH 的 Workspace/Session 导航、对话区或核心 details 面板；不支持安全 UI 嵌入的 Harness 使用 companion window，但主控 Loop 和提示输入仍留在 Harness。

OfferU 工作区是同一套 UI 与领域状态，但不承诺宿主提供全局中央页面：入口与确认可以是全局的，主视图按当前求职任务和 DSH Session 投影。它仍可浏览所有求职阶段和对象，但 Agent 执行绑定独立 Session/Run；界面统一不意味着多个岗位共享一个长期模型隐藏上下文。

DSH 接入采用原生 React client plugin，不把现有完整 OfferU SPA 作为 iframe 套入 DSH。host half 负责 CLI stdio Bridge 与生命周期，client half 使用 DSH 可加式 slots 注册界面；现有前端与接入包复用无头领域投影和交互状态机，独立壳只承载专注窗口或不支持嵌入的宿主。

跨 Harness 的一致性约束针对 Operations、Run、确认、事件和审计，而不是要求每个宿主提供相同 UI extension API 或视觉组件。DSH 使用原生嵌入；没有安全扩展点的 Codex、Claude Code、OpenCode 或 Pi 可以打开消费同一无头契约的 companion window，但不能因此降级业务契约。

<a id="adr-0056"></a>
### ADR-0056 — Harness 共享无头交互契约，各自使用宿主原生 UI

`Status: accepted; refines ADR-0055`

DSH 内的 OfferU 工作区完全遵循 DSH 原生组件、布局、设计令牌与交互习惯，不形成 OfferU 品牌岛。跨 Harness 只共享类型化领域投影、交互状态机、Operation 合约和一致的确认语义；不共享同一套 React 页面或宿主无关视觉组件。每个支持 UI 扩展的接入包提供薄的宿主原生渲染器，companion window 则使用 OfferU 自有渲染器，但所有渲染器消费同一无头契约且不得维护第二份业务状态。

这一边界接受少量宿主渲染代码重复，以换取原生可用性、宿主升级适配和可访问性一致性；不得把领域判断、生命周期规则、权限或业务动作复制进渲染器。跨 Harness 一致性验收比较可见事实、状态转移、可执行 Operation、确认与错误语义，不做像素级一致性验收。

<a id="adr-0057"></a>
### ADR-0057 — Codex Agent Engine 与 OfferU Career Control Plane 解耦

`Status: accepted`

OfferU 不 Fork 或魔改 Codex Core；第一阶段通过 provider-neutral `AgentRuntimeProvider` 适配 Codex App Server stdio，并保留 Replay/Fixture 与未来其他 Harness provider 的替换 seam。Agent Runtime 只负责 thread、turn、event、skill/plugin、审批中断和执行生命周期，不拥有 Job、Profile、Resume、Application、Interview 或 Memory 真相。

CareerTask 是控制面的持久化执行信封，Provider Health 只保存脱敏的可用性和认证阻塞状态。所有会改变 OfferU 业务状态的 Agent、CLI、MCP、浏览器扩展和插件调用都必须回到 Operation Registry，经 Proposal/HITL、幂等和审计后才能进入 Domain Runtime；Agent 返回的意图、候选和报告不等于事实。`workspace.delegate` 也必须先创建 CareerTask，不能直接调用执行器或 Runtime。

OfferU Capability Plugin 使用自有版本化 Manifest，组合 CLI、Skill、capability、side effect、权限和输出契约。CLI 的 stdout 只能返回机器可读 JSON，stderr 只用于诊断；安装只改变本地能力发现状态，卸载不删除插件文件。插件输出由 OfferU Runtime 验证、去重、统计和持久化，不能把 Codex Marketplace 或任一 Harness 私有协议提升为业务契约。

当前 Codex 认证故障属于 Provider Health/G2B live verification，不阻塞 Fixture/Replay 的架构和产品验收；不得因此自动修改凭据、代理或切换用户 Provider。

自动化采用持久化 `AutomationEvent` → 显式 `AutomationRule` → `CareerTask` → Operation 的有限分发链，不引入常驻 Agent Loop。后台产生的岗位情报、简历建议和面试 Focus Plan 进入 Automation Inbox 作为候选或复核项；只有既有 Proposal/HITL 与 Career Memory 生命周期才能改变正式职业事实。

## 深度执行器

<a id="adr-0015"></a>
### ADR-0015 — 本地深度执行器只承担可审计重任务

`Status: accepted`

执行器只处理公司/岗位深度调研、批量 JD 评估和登记工作源摘要等可取消、可重放、可查来源的长任务。它只返回候选结果，不得直接写职业模型、晋升证据、确认投递阶段或决定面试评分。

<a id="adr-0035"></a>
### ADR-0035 — OfferU 托管可替换的深度执行会话

`Status: accepted, narrowed to deep executors by ADR-0051`

OfferU 负责深度执行会话的发起、恢复、事件呈现、取消和审批，并以可替换适配器使用 Codex、Claude Code 等。该托管边界只属于重任务执行器，不拥有主控 Agent 会话；结果仍经过 Operation Registry、事实门和使用者确认。

<a id="adr-0038"></a>
### ADR-0038 — 每个托管执行会话只服务一个重任务

`Status: accepted`

会话保存任务输入、执行器、标准事件、待确认动作、结果和恢复位置，完成后封存，不跨任务继承隐藏对话。跨任务连续性只来自已确认事实、学习观察和显式材料。

<a id="adr-0039"></a>
### ADR-0039 — 深度执行器权限限定到当前任务

`Status: accepted`

创建会话时只暴露该任务所需 Operation 与数据范围。执行器不能发现白名单外能力、用通用 API 或 shell 扩权，也不能直接写正式业务状态。

<a id="adr-0044"></a>
### ADR-0044 — 托管深度执行器使用原生协议适配器

`Status: accepted`

对支持托管会话的 Coding Agent，优先使用官方 SDK、App Server 或 Agent SDK，并归一为 OfferU 的事件、审批、取消和恢复契约。通用 CLI subprocess 只用于能力探测、一次性兼容或无托管协议的执行器；供应商差异留在无业务逻辑的适配层。

<a id="adr-0045"></a>
### ADR-0045 — 用岗位调研闭环验证主控与执行器边界

`Status: accepted, reframed by ADR-0051`

首个联合纵向切片嵌入投前决策：主控 Harness 通过 Skill Registry 创建受限深度执行会话，执行器形成带来源候选研究，OfferU 再通过证据规则、事实门和使用者审核决定是否进入档案。切片必须覆盖事件、取消、重启恢复、审计和显式失败。

## 工作台与交互

<a id="adr-0030"></a>
### ADR-0030 — GUI 按求职流程组织

`Status: accepted`

一级导航采用今日、机会、材料、进展和面试，而不是平铺技术模块。“今日”优先展示待确认、临近截止、进行中任务与下一动作；档案、设置和贯穿流程的主控 Agent 与阶段导航分离。

<a id="adr-0031"></a>
### ADR-0031 — 使用任务中心的 Agent 工作台外壳

`Status: accepted, reframed by ADR-0055`

任务优先交互仍围绕求职任务展示状态、证据、审批和结果，但主外壳改由 Harness 原生界面承担。OfferU 工作区嵌入宿主并采用渐进披露；简历深编与面试进入专注窗口；GUI/TUI 呈现可不同，但仍共享 Operation Registry。

<a id="adr-0032"></a>
### ADR-0032 — 移动端只承担轻操作

`Status: accepted`

桌面和平板承载完整工作区；手机聚焦查看、确认、更新投递进展和续接主控 Agent。简历深度编辑与面试训练保留在桌面或平板。

<a id="adr-0033"></a>
### ADR-0033 — 一级页面收敛进五阶段导航

`Status: accepted`

现有页面归入今日、机会、材料、进展与面试；邮箱成为进展信号收件箱，抓取成为机会导入入口，独立 Agent 与演示页面退出一级导航。收敛只改变页面组织，不合并领域事实或改变权限边界。

## 浏览器扩展

<a id="adr-0049"></a>
### ADR-0049 — 一个 OfferU 扩展统一岗位采集与安全填表

`Status: accepted`

只保留可维护的 OfferU WXT 扩展；外部已发布扩展只能作为 clean-room 行为参考。扩展使用版本化 `SiteRuleRegistry` 和内置 `ControlDriver`，只暴露岗位采集、填表和提交候选证据三类动作；它不提交申请、不保存独立简历或模型密钥，也不直接写数据库。

填表先生成绑定 URL、字段指纹和短时有效期的 `FillPlan`，经使用者二次确认后只填空白、非敏感、高置信字段，永不触发最终提交。提交后只能形成最小证据候选，确认后由 Operation Registry 原子创建投递尝试与阶段事件。扩展按需使用 `activeTab + scripting`，主界面采用 side panel，构建入口与产物以 WXT 约定为准。

<a id="adr-0050"></a>
### ADR-0050 — 远程规则包必须版本化并签名

`Status: accepted`

远程更新只允许 JSON 选择器、字段映射和能力声明，不得携带代码。单一 bundle 使用单调递增版本、schema 校验和 ECDSA P-256/SHA-256 签名，公钥内置、私钥不入库；失败、离线、重放或坏包时保留内置规则，并提供熔断与回滚。远程发布前仍需复核浏览器商店政策。

## 交付与验收

<a id="adr-0027"></a>
### ADR-0027 — 按垂直闭环交付

`Status: accepted`

依次交付共同底座，邮箱与投递，公司/岗位研究与证据化简历，以及语音/视觉面试。每阶段都从用户触发贯通处理、领域事实、确认界面和可见结果，不按数据库、API、前端等技术层横向铺开。

<a id="adr-0028"></a>
### ADR-0028 — 使用三层量化验收门槛

`Status: accepted`

安全不变量必须 100% 通过；概率能力必须在固定、版本化标注集达到阈值；完整场景必须通过端到端、重启恢复、重试和重复输入验证。页面可访问、构建成功或单次演示都不代表交付完成。

## 被取代的历史决策

<a id="adr-0001"></a>
### ADR-0001 — 本地优先并预留 SaaS 边界

`Status: superseded by ADR-0023`

旧决策曾要求避免全局单例以保留 SaaS 演进边界。当前明确不为未来 SaaS 预埋模型，以 ADR-0023 为准。

<a id="adr-0002"></a>
### ADR-0002 — Profile 分层写权限

`Status: superseded by ADR-0048`

旧决策允许主控 Agent 自动更新求职偏好。当前统一改为条目级账本和更严格的记忆收件箱规则，以 ADR-0048 为准。

<a id="adr-0036"></a>
### ADR-0036 — 内置 Agent 使用进程内 Operation 投影

`Status: superseded by ADR-0051`

旧决策假设 OfferU 内置主 Agent Core。当前主控 Loop 已迁移到外部 Harness，OfferU 只提供 CLI-first Agent Bridge。

<a id="adr-0040"></a>
### ADR-0040 — 在 Python 内借鉴 Pi 运行时契约

`Status: superseded by ADR-0046, then ADR-0051`

该方案先被 Pi SDK Worker 取代，随后内置主 Agent 路线整体被 ADR-0051 取代。

<a id="adr-0043"></a>
### ADR-0043 — 内置主 Agent 工具协议按模型能力分型

`Status: superseded by ADR-0051`

该决策属于已取消的内置模型适配层。现在由外部 Harness 处理模型协议，OfferU 只验证统一 Bridge 与 Operation 行为契约。

<a id="adr-0046"></a>
### ADR-0046 — Pi SDK Worker 承载内置主 Agent

`Status: superseded by ADR-0051`

不再以 Node.js Pi Worker 承载第二套主 Agent。Pi 只能作为外部 Harness 接入目标或迁移期兼容实现。

## 编号索引

| 范围 | 主题 |
| --- | --- |
| ADR-0001–0028 | 产品边界、职业事实、研究、投递、面试、交付与验收 |
| ADR-0029–0034 | Operation、Skill、工作台与投前决策 |
| ADR-0035–0046 | 主控/执行器架构演进与被取代路线 |
| ADR-0047–0050 | 桌面前端、职业模型账本、浏览器扩展 |
| ADR-0051–0056 | 外部 Harness 主控、工具隔离、确认、交接与宿主原生工作区 |
