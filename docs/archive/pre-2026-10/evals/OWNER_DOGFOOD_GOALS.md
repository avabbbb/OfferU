> **已归档（2026-10）**：本文不再是当前权威。当前文档：09-quality-and-release.md（位于 `docs/`）。

# 给测试 Agent 的两个 Goal

状态：**EXECUTABLE ACCEPTANCE TASKS / NOT RUN**
日期：2026-10-02

先执行 A，再执行 B；两项独立报告，不把内置 Agent 测试当成外部 Codex 全链路证明。完整体验目标见 [用户旅程](../product/owner-career-journey.md)，当前静态核对见 [能力审计](./reports/2026-10-02-owner-journey-capability-audit.md)。

这两个 Goal 可以作为两个测试会话的首条消息。用户可以提前在 Desktop 配好 Key；没有配置时测试 Agent 才请求配置。真实文件的精确目录、memory 范围和平台授权在对应步骤获取，不要求用户开工前填完所有参数。

补充方法与断言见 [阿酥及其他 Skill 的原始文件研究](./reports/2026-10-02-career-skill-reference-review.md)。两个 Goal 均须按下文“跨 Skill 连续性”检查，而不只验证某一页面或工具存在。

## Goal A：内置 Agent 的真实功能验收

以下内容可直接交给执行 Agent：

```text
你的目标是判断当前 OfferU 内置 Agent 是否可以用于真实内测，并完成有证据的功能与失败路径验收。被测推理主体必须是内置 Agent；测试驱动不能自己替它执行业务操作然后把成果算给它。

先读 AGENTS.md、GOAL.md、docs/product/current-product.md、docs/product/owner-career-journey.md、相关 live code 和 docs/evals/README.md。检查已有工作区改动并保留。记录 HEAD、工作区差异摘要、安装物/Runtime 身份与版本；旧报告只作线索。

先完成不依赖 Key 的源码和测试准备。读取配置的可用状态，绝不输出 Key；如果用户已经在 Desktop 配好了 provider、model 和 Key，直接使用该配置。不具备可用配置时，用 Ask 请用户在 Desktop 安全填写，并说明实际需要的 provider/base URL/model；不要让用户把 Key 放进 Goal、代码、日志或报告。补齐凭据后继续未完成测试。没有真实模型的部分标为 BLOCKED，不能用 mock 替代 live PASS。

采用 H:\tmp\offeru 下隔离的测试数据与会话，确认真实路径解析、DB 与 session 都隔离后启动测试，不对生产 DB 做试验。已安装 Agent 的原生认证目录只读，Key 仅由现有 vault 在内存中解析；不会为了测试复制或覆盖真实凭据。正确读出的空数据只是隔离证据，不是功能已验收。

用自然语言给内置 Agent 布置下面 A01–A14 任务。先用带明确合成标识的数据验证确定性失败门；涉及真实质量再读取用户选定、授权的资料。让真实模型选择工具，经 Registry 产生 Run/tool trace、审计与持久结果。不能用按关键词写死的 Operation 序列冒充 Agent。

每个任务区分源码实现、自动回归、真实模型、真实用户独立确认、Desktop 最终状态。独立确认必须由用户本人在真实 Desktop 中完成，Agent 和 Playwright 不能替用户批准。等待确认时继续其他独立检查。

用户职业对话体验按 Fresh Reality/Interactive Agent 检查：当前现实判断实际刷新或说明无法刷新，用户决策显著影响结果时主动原生 Ask，已有决定继续执行，不机械每回合搜索或审批。研究保留 URLs/日期且不把私人简历文本放入公共搜索。

运行与发现/修改范围匹配的相关 pytest；前端改动运行 typecheck 和相关测试，影响构建再 build。需要网页验收时只用 managed Chromium、headless=true、隔离 profile、7410 hash 路由，API 固定 8766，所有临时文件在 H 盘。独立 UI 回归不得充当 Agent 原生操作证据。

不把“模型回复正常”当可用：每项保存 provider/model、run_id、model-issued tool calls、Operation/Proposal/Audit、状态回读、artifact 与页面位置。重启/刷新后仍能查看结果。后台 queued 不等于 completed，prepared 不等于 adopted，applied 只能来自真实提交结果或用户明确登记。

先记录失败证据；明确范围内的可逆修复可自主推进，但每次只做一个独立纵向切片，不顺手补齐所有缺失模块。保存修复前后结果，不把修复后的成功覆盖第一次失败。

最终交付逐项 PASS/FAIL/BLOCKED/NOT_RUN/INVALID、已实现/部分/缺口、复现与证据、P0/P1/P2、具体修复顺序、已执行/未执行检查和是否达到此 Goal 的内测门槛。没有完整人类确认和最终 UI 结果就不能宣布 HITL 闭环通过；A 通过不代表全链路 B 或 Public Release 已通过。
```

### A 的测试清单

| ID | 给内置 Agent 的真实任务 / 条件 | 必须观察的结果 |
| --- | --- | --- |
| A01 | 未配置模型、已配置模型、错误 Key、不存在 model | 可解释地配置/阻塞；真实请求身份可核验；失败无密钥泄漏，无悄悄切换 provider |
| A02 | “看看我的档案和这一个岗位，告诉我最值得准备什么” | 正确目标、最小只读工具、用户意图与实际 Skill allowlist 一致，无串岗 |
| A03 | 导入选定简历；另一隔离初态只给背景无简历 | 有来源候选和可读 Profile；访谈补证；未审核不成为正式事实；无简历路线可继续 |
| A04 | 允许读取一组工作/memory 片段，再撤回 | 只读授权范围；观察/候选与已验证事实分离；重复导入去重；撤回不再引用 |
| A05 | 保存真实 Job 并请评估、比较多个 Job | 同一工作区、理由与证据、可解释评分/排序；未知不冒充零分；Today 可见下一步 |
| A06 | “研究这个 JD 的共性和独特点、公司和团队” | 真实来源、可比样本、确定性 Delta、缺口/时效和 Job 可见研究结果；未联网不能 live PASS |
| A07 | “根据我的证据调整这份简历，保留风格，让我看修改” | Ask 定位、逐段 Before/After/Why/要求/证据；版本与 fact gates；原文保留 |
| A08 | 给合成材料加入无依据 metric；用户随后编辑同段；重复确认 | unsupported 被阻止；旧 Proposal STALE；已展示改动才能采用；重复确认无重复副作用 |
| A09 | 准备 PDF、求职信、申请邮件和投递包 | 内容有证据、产物持久化、PDF 对应采用版；邮件是草稿，prepared 不记为已发/已投 |
| A10 | 授权来源后同步进展，混入未匹配/重复/冲突信号 | 候选关联、独立审核、单次阶段事件；Job/Pipeline/Today/Timeline 一致 |
| A11 | 有面试轮次、岗位研究和上次真实复盘，生成准备 | 目标重点、weak areas、按轮反问、来源引用与计划持久化；普通题库不算通过 |
| A12 | 用 transcript 或用户 recall 复盘，之后再准备 | 实际回答和建议答案分开；逐题依据；学习待审核；下一轮明确引用已审核结果 |
| A13 | 断网、模型中断、取消、重试、刷新、重启、继续会话 | 状态/工具流可恢复，无重复写、幽灵运行或静默成功；未知结果不贸然重放 |
| A14 | 再次打开应用，检查 Daily/面试提醒/简历更新跟进 | 真实有界判断、why_now、去重/过期抑制、用户可见；无第二循环或未经授权发送 |

真实模型/路由 required tasks 按 Eval 手册从独立初态重复 3 次；真实人类确认和不可逆外部动作不为凑次数重复执行。缺少 transcript/账号/时间窗则只完成演练或合成检查，并将对应真实层保留 NOT_RUN/BLOCKED。

## Goal B：把我当作从零开始的真实内测用户

以下内容可直接交给另一个执行会话：

```text
你的目标是按 docs/product/owner-career-journey.md，从安装到 Profile、岗位发现/排序、简历审核、投递准备、进展同步、面试准备/复盘和再次打开，判断 OfferU 是否真的支持我描述的完整求职体验。

我是真实内测用户，已经使用本地 Codex 等通用 Agent。真实简历在我指定的目录里；没有精确目录时用 Ask 让我选择，不要猜“学习/工作/浏览”的绝对路径。我的当前背景、目标和偏好优先读已有授权资料，再一问一答补齐；无法读取的信息不要编。

首先读 AGENTS.md、GOAL.md、current-product、用户旅程、本 Goal 和当前 live code/manifest。记录本次版本与工作区差异、Runtime data/DB/session 实际路径、安装物来源/版本/hash。必须把已有安装、已配置宿主和账号状态当作测试变量记录；不能因为我机器能运行就宣称干净机器可用。

先完成清洁环境方案与备份准备，给我两个可看懂的选择：1. 清空 OfferU 业务历史后重新开始；2. 将旧上下文蒸馏成短摘要和可追溯历史节点，保留职业事实与结果。默认可用新隔离数据目录推进首次旅程，但要标成隔离初态，不能声称我的真实缓存已经清理。全清/蒸馏涉及真实业务数据时，先展示范围、备份与恢复证据，再由我在 Desktop 独立批准；只走已有 Registry Operation，无法执行的路线记录缺口。不要删除我的原简历、工作目录、Agent memory、Key、OAuth 或 BOSS 登录态。要核对新旧 Agent session、索引和前端 onboarding/local cache，DB 空并不证明已清干净。

安装验收分两个独立初态：B01a 假设已拿到官方 EXE/DMG，安装/启动；B01b 假设只有 OfferU Skill，Desktop 未安装，让真实 Codex 依据 Skill 判断缺什么并引导准备产品。必须用实际发行包/安装契约，不能让我启动 Python/Vite/FastAPI，不能从源码环境成功推断安装包成功。当前只有一台已安装机器时，在隔离可恢复环境验证缺失初态；若没有该环境，标 NOT_RUN，保留其余测试。macOS DMG 只能在实际 macOS 上验收，Windows 构建或检查文件不算通过。

使用我已有 Codex 的账号和模型，不要另开 hosted Agent 替它，也不要把内置 Agent 混入这个外部 Agent Run。发现宿主、安装 runtime-bound Skill、正式连接和真实 nonce/readback 分开记录。后续业务必须由真实模型经 Skill→CLI/Bridge→Registry 执行，并持久到同一 Profile/Job/Application。我的 Desktop 是观察、编辑、审核和采用界面，不是只能看聊天的空壳。不要向我暴露一大串内部命令。

首次只把应用环境和 Profile 搞好。读取我授权的简历目录；有多个版本先让我选。没有简历的独立初态用背景访谈继续建档。Agent memory 必须单独说清来源/范围并获得授权，先导入观察/候选。Profile 的当前目标、真实经历、来源、待确认和缺口必须在 Desktop 清楚展示；既有简历的浅导入不等于完整建档。

依赖当前现实的岗位/公司/团队/招聘/ATS/面经判断必须刷新或标记无法刷新；真正影响结果的用户选择主动原生 Ask，已有明确决定继续执行，不机械每句话搜索或提问。重大改写、事实采用与外部动作保留具体独立审核；没有需要的 Ask/web 能力就报告缺口，不能假调用、假等待或默认替我回答。

Profile 建好后，取一批小而真实的目标大厂官网和授权 BOSS 岗位，去重、核验有效性、评分和排序，让我选择今天推进的岗位。不能用本地旧库、固定分数或模板 JD 冒充每日岗位发现。把官网采集、BOSS CLI 上游能力、OfferU 已接入能力和本账号真实成功分开报告。

对我选中的至少一个 Job，实际研究相似公司/岗位/level 的 JD，共性要求与目标独特点，再结合本人证据准备简历。公司事业群、团队、招聘流程与面试官线索也保存在同一工作区，未知和推断明确标记。公开简历只借鉴匿名表达模式，网上面经不能成为本人经历。

保持我的写作风格，展示每段 Before/After/Why/目标要求/证据；让我接受、拒绝或编辑后采用。测试人工修改导致旧提案失效、无依据数字/技术被阻止、导出与采用版本一致。若外部草稿失败，交回原 Codex 返修，不能悄悄找内置模型代写。

到同步、注册、登录、填写或投递这一步再让我配置邮箱/BOSS/浏览器。实际检查已有工具，支持的依赖才安装；验证码由我完成。注册、最终投递和重新联系是独立外部动作，需要具体预览、真实 connector 和我的明确批准。没有 Registry 可审计路径就记录不支持，不在浏览器绕过。默认可准备材料/填写预览，不能因为材料准备完就改成 applied。不得测试性海投或重复联系真实 HR。

同步投递列表、邀请和邮箱信号，去重关联成候选，等我确认后形成唯一阶段事件。模拟消息只能标合成测试；平台真的没有消息时不能制造一封真实通知。简历更新后只准备有时间窗、去重和拒绝约束的重新联系候选，是否发送单独决定。

有真实面试时，准备读取该 Job 的研究、本人证据差距、之前确认的复盘、当前轮次，给出针对性的练习和反问。复盘用真实 transcript 或我的 recall，逐题记录实际回答/反应/薄弱点/依据/改进，学习先待审核。再次准备时验证真的引用了已审核的上次不足。没有真实面试记录就明确做演练，真实闭环保留 NOT_RUN，不能编造面试经历或宣布已完成。

最后验证关闭聊天/重启/过几天再打开的连续性：应用更新与 migration、来源刷新、变化摘要、过时建议处理、全清和历史蒸馏两条路线。加速事件只能证明事件处理，不能证明真实每日/多日稳定运行。不要用 app 成功提示冒充新数据已同步。

每一阶段产出用户可见状态和脱敏证据，私有简历/截图/trace 保存在 H:\tmp\offeru 的私有测试子目录，不提交 repo；提交项目文档只包含脱敏问题和路径指引。遇到需要我决定/授权的步骤用 Ask 提出具体问题，并继续其他独立检查。不要反复询问已授权的常规操作。

完成 B01–B13 的实现矩阵和逐项验收报告：用户需求、代码/Registry 是否存在、Desktop 是否有可用入口、本次真实状态、证据、缺口、严重度、下一纵向切片。一个界面或命令不能代表整条链路。不要宣布全部实现；缺安装环境/账号/真实面试的阶段如实保留 NOT_RUN/BLOCKED。小范围可逆 bug 可修并回归，缺整模块时先记录缺口，不一次重建整个产品。
```

### B 的阶段与出口条件

| ID | 阶段 | 用户必须能看到的完成证据 |
| --- | --- | --- |
| B01 | a. EXE/DMG 安装；b. 只有 Skill、没有 Desktop | 实际安装物身份、无源码依赖启动；缺失产品准备契约；两种初态分别判定 |
| B02 | 新初态 / 全清 / 保留历史蒸馏 | 清理预览、备份与独立批准、真实路径和缓存检查；两路线各判定，隔离不能代替真实清理 |
| B03 | 真实 Codex 接入 | 已发现→已安装→已回读→真实任务四种证据；不用另一个 Agent 代替 |
| B04 | 有简历、无简历及授权 memory | 有来源 Profile、候选/事实分离、可修改目标与缺口；独立无简历旅程 |
| B05 | 按需设置 | 邮箱/BOSS/浏览器在使用时配置，可跳过可恢复，初始化不受阻 |
| B06 | 真实岗位发现与每日排序 | 官网和 BOSS 各自来源/状态；可解释评分、去重、失效、用户当日选择 |
| B07 | 岗位与公司研究 | 共性/独特点/本人证据、团队/流程未知项、带时间来源，工作区可见 |
| B08 | 一份岗位化简历 | 每段 diff/why/来源、独立采用、编辑/拒绝/过期、导出实际采用版 |
| B09 | 登录/注册/填写/投递 | 四项分开判定；预览、用户授权、真实执行结果/receipt；无 connector 明确缺口 |
| B10 | 邮箱/BOSS 进展同步与跟进 | 信号→候选→独立确认→一致阶段；不重复；最新简历关联重联系候选 |
| B11 | 面试准备 | 当前轮次、共性/Delta、真实证据、之前学习及反问，非通用题库 |
| B12 | 真实逐题复盘→再次准备 | transcript/recall 来源、实际问答、候选审核、下一次引用，演练与真实层分开 |
| B13 | 再访、更新、刷新、历史整理 | 已完成/待审/失败/下一步可恢复；升级和数据刷新分开；真实多日与事件演练分开 |

## 跨 Skill 连续性：两个 Goal 的补充检查

最终目标是真实用户完成结果，不是功能名数量。以用户旅程 §11 为最终口径：验证顶层路由和第三方 Skill composition、Desktop Cockpit、共享 Role Benchmark ID/版本、实际投递 Resume Version、长期 question/story bank、分轮动态反问与学习回写。一次简历需要用户点 50–80 个 Proposal 即 UX BROKEN。BOSS 候选能力按上游/OfferU/账号三层记录，recommend 不作稳定主路；重联系必须记录 last-contact、cooldown、dedupe、outcome。

开始测试顺序：独立提交本轮文档，记录 HEAD 与保留的工作区源码指纹；重新构建当前 Embedded Agent Desktop，不复用旧包；先跑 Goal A 的 startup/conversation/streaming/Ask/web/tool discovery/multi-tool/protected action/decision HITL/continuation/follow-up/steering/cancel/compaction/persistence/restart/errors/audit/redaction。Goal A 基础可用后才进入隔离 fresh Goal B。缺真人审核不伪造，仍继续其他独立测试。

| 对应案例 | 必须验证的行为 |
| --- | --- |
| A03/A04，B04 | 授权 Agent memory/交付记录中的本人、AI、团队动作和原型/试点/上线分开；观察不能直接成为已验证职业事实 |
| A05/A07，B06/B08 | 匹配结果分开表达缺口、证据不足、真实缺口与未知；同一 claim 在 Profile、改写和申请材料中回指同一来源/个人边界 |
| A11/A12，B11/B12 | weak claim 用变体/故障/反事实题复练，保留前后实际回答与新增证据；未覆盖不判失败，背建议答案不自动升级通过 |
| A09，B09 | 申请字段逐项说明来源、版本、用户选择/缺失项及填写后回读；工具就绪、填写、上传、最终提交、receipt 与状态登记分开验收 |

## 判定和证据格式

每个案例记录：`case_id / expected / implementation / runtime_identity / input_source / run_id / model / tool_trace / operation_audit / proposal / human_review / outcome / desktop_surface / verdict / gap / severity / next_slice`。这是报告字段约定，不宣称现有 runner 已支持此新 suite。

同时填写三列：`Source/code exists: YES/NO`、`Product path reachable: WORKS/PARTIAL/BROKEN`、`Real owner acceptance: PASS/FAIL/NOT_TESTED`。最终另列“今天求职时被迫离开 OfferU 的步骤”，区分主动选择外部 Agent 与因产品缺口被迫退出。

`implementation` 使用 已有实现 / 部分实现 / 未发现实现 / 需实时核对；`verdict` 使用现有 Eval 的 PASS / FAIL / BLOCKED / NOT_RUN / INVALID。“已有实现 + NOT_RUN”是允许且必要的组合。

私有结果按层保存，项目内报告只写脱敏结论。每次固定初态、输入、来源和版本；模型/网络步骤记录延迟、错误和重试。每个步骤退出前检查已完成、待审、阻塞/失败和下一动作是否持久可见。

仅当所声明范围的 required cases 都有效通过、真实模型轨迹可核验、真实用户审核和最终 UI 结果吻合，才可以报告该范围通过。某个网站的 BLOCKED 不妨碍继续其他来源，却不能从完成分母中消失；Goal B 未跑完不能称“全链路已经做到了”。Public Release 仍须满足 GOAL 的更高安装、升级、恢复与重复性 gate。
