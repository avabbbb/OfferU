# 用户完整求职旅程：当前能力核对

日期：2026-10-02。状态：**SOURCE AUDIT COMPLETE / LIVE OWNER JOURNEY NOT_RUN**。

核对基线：`265cad5f49c1d68bd82bcd97a28d915881689200`，分支 `feat/agent-contract-desktop-binding`，**包含本次读取时已有的未提交改动**。HEAD 单独不足以复现本工作树；正式验收须冻结工作区差异和安装物。没有删除真实业务数据、读取用户简历/memory 正文、请求模型或操作真实招聘账号。

结论：当前已有大量业务能力和可审核草稿基础，但不能据此宣布用户要求的从零完整旅程已实现。主要待验收项集中于 Skill 独立准备产品、完整可见建档、真实多源每日岗位发现、决策 Ask/现实刷新、站外执行、真实面试学习反馈和再访历史整理。用户最新要求不机械逐回合 Ask/web。任务出口见 [两个 Goal](../OWNER_DOGFOOD_GOALS.md)，目标细节见 [用户旅程](../../product/owner-career-journey.md)。

## 1. 实现与本次验收分开

“已有实现”仅表示本次读到对应源码或正式工具声明；不是本次 live PASS。以下全部真实旅程验收为 **NOT_RUN**，凭据/平台/环境实际探测后才可改为 BLOCKED 或其他 verdict。

| 用户要求 | 当前读到的实现证据 | 源码结论与缺口 |
| --- | --- | --- |
| 内置 Agent 真正推理与工具循环 | [embedded host](../../../backend/app/services/embedded_agent_host.py)、[worker](../../../backend/app/services/embedded_agent_worker.py)、[迁移记录](./2026-10-01-embedded-agent-source-migration.md) | 有生产 kernel、Registry allowlist、Run 与会话；迁移记录中的 list_jobs live smoke 是历史只读证据，不是本次功能/HITL 验收 |
| 用户已有 Key / 没有 Key | [配置路由](../../../backend/app/routes/config.py)、embedded provider resolution | 支持 canonical config/vault；新测试须核对可用状态再请求配置；不需要提前把 Key 发给测试 prompt |
| 无源码环境 EXE 安装 | [Tauri config](../../../frontend/src-tauri/tauri.conf.json)、本机 bundle 文件 | 发现 NSIS/MSI 产物，但当前 NSIS 修改时间 2026-09-07 17:28:21，早于新 Agent 迁移；未验证对应源码/hash/clean install，不能当作当前版本验收物 |
| 只有 Skill、没有 Desktop | [公开 OfferU Skill](../../../.agents/skills/offeru/SKILL.md) 的 bootstrap 段 | 当前未绑定时要求打开 Desktop 并连接；不提供已验收的缺产品自动下载安装流程。用户要求的 Skill 引导安装仍有缺口 |
| Desktop 宿主接入 | [agent integration](../../../backend/app/services/agent_integration.py)、[connection panel](../../../frontend/src/components/workbench/AgentConnectionPanel.tsx) | 有安装/绑定与 nonce/readback 路径；发现宿主或回读成功不能证明 Ask、web、完整职业任务可用 |
| 有简历建立 Profile | [ResumeSetup](../../../frontend/src/components/onboarding/ResumeSetup.tsx)、[profile builder](../../../backend/app/services/profile_builder_agent.py) | 有 PDF/DOCX 本机 mechanical 导入、候选核对与访谈代码；读到的导入 wizard 不是完整对话建档体验证明 |
| 没有简历、只有背景 | profile builder、[ProfileOnboarding](../../../frontend/src/app/profile/components/ProfileOnboarding.tsx) | 有访谈相关代码；当前 wizard 主要提供导入简历/可跳过路径。需独立测试无简历入口、完整度与最终可见 Profile，不把 skip 当建档完成 |
| 真实目录发现简历 | ResumeSetup file input；[work source](../../../backend/app/services/agent_skill_registry.py) 的显式登记契约 | 当前 UI 是用户选文件；未验收自然语言指定嵌套目录→发现多个版本→选择→建档。不能全盘扫描补缺口 |
| 与本地 Agent memory 联动 | [MemorySetup](../../../frontend/src/components/onboarding/MemorySetup.tsx)、[memory import](../../../backend/app/services/memory_import.py)、[local memory](../../../backend/app/services/local_memory.py) | 有授权摘要/候选机制；不代表所有宿主完整 memory 联动。不得无授权读全历史或把摘要当验证事实 |
| 首次轻量、按需配置 | [wizard](../../../frontend/src/components/onboarding/OnboardingWizard.tsx)、[entry contract](../../product/entry-onboarding-and-dogfood.md) | 现有四步：准备 Agent、简历、memory、Job；可跳过/保留进度。用户本次要求“环境+Profile 后按需设置”，具体无简历、功能内配置体验待验收 |
| Fresh Reality + 决策 Ask | 公开 OfferU Skill | 当前规则与用户最新纠正一致；内置与外部宿主实际联网/交互能力分别实测，不能用规则文本证明执行成功 |
| 每日发现官网/BOSS 新岗位 | [Skill Registry](../../../backend/app/services/agent_skill_registry.py) 的 scan_jobs、[JobSource adapter](../../../backend/app/services/job_sources/adapters/boss.py) | scan_jobs 标 partial，缺抓取 Operation 与页面存活检查；只读 source 能力存在不等于 Agent 可用的每日新岗位链路 |
| 岗位评分与排序 | evaluate_job、compare_jobs、batch_evaluate；[batch evaluations](../../../backend/app/services/batch_job_evaluations.py) | 有评估/比较与产物路径；需验证评分理由、未知项、用户偏好和 Desktop 筛选是否一致，不能宣称推荐质量已验收 |
| 共性要求 × 独特点 | role_intelligence Skill；[Role Intelligence](../../../backend/app/services/role_intelligence.py) | 有 benchmark/Delta/Focus 操作；必须真实采集、去重、cohort、展示样本与来源，现有 native 标签不等于 live 研究成立 |
| 公司/团队双档案与匿名表达参考 | [job research](../../../backend/app/services/job_research.py)、company_research Skill | 已有研究任务和 artifact 相关契约；具体事业群、团队/流程、社区信息来源与 UI 可见性待真实场景验收 |
| 每次简历修改可 check | [resume workspace](../../../backend/app/services/resume_workspace.py)、[resume page](../../../frontend/src/app/resume/[id]/page.tsx)、[PendingProposalReview](../../../frontend/src/components/workbench/PendingProposalReview.tsx) | 有逐段对比/外部草稿/证据与采用相关实现；本工作树也有未提交修订。需真人审核、过期保护、拒绝/编辑/导出一致性验收 |
| 官网注册/登录/填写/最终提交 | [application actions](../../../backend/app/services/application_actions.py)、application_assistant Skill | 模块明确 preview only，Skill 标 partial，缺外部执行器；不能把预演、登记或导出当成已真实投递。账号注册未发现已验收正式路径 |
| 邮箱同步进展 | reply_watch / follow_up Skill | 有同步记录、候选与审核路径；账号、实际通知、跨页一致性与幂等需要真实验收 |
| BOSS 投递/邀约同步 | [boss progress](../../../backend/app/services/job_sources/boss_progress.py)、[boss signals](../../../backend/app/services/job_sources/boss_signals.py)、[ops](../../../backend/app/ops.py) 的 sync_boss_application_status | 有 me deliver / interviews→信号→候选；当前总 Skill 文件未直接列这个工具，执行 Agent 必须实时核对可用 Skill/公开工具路径，不能绕过 Registry |
| 更新简历后重新打招呼 | [Career Director](../../../backend/app/services/career_director.py)、[proactive contract](../../product/proactive-career-director.md) | 有 re-engagement review 准备链路，不能发送；未发现 OfferU 当前完整再次招呼执行路径 |
| 面试准备与模拟 | interview_prep/practice；[AI interviews](../../../backend/app/services/ai_interviews.py) | 有计划 artifact、题目、评分与 Focus；分轮反问、历史弱点与近期研究是否实际被采用仍待测 |
| 面试复盘、学习回流 | interview_debrief；[career interviews](../../../backend/app/services/career_interviews.py) | 有 get_interview_career_context 的 previous_learning 与 submit_interview_debrief、候选学习链路；不能说完全没有复盘，也不能说逐题真实复盘→下一轮完整闭环已经可用 |
| 全清重新开始 | [local reset](../../../backend/app/services/local_data_reset.py)、ops reset_local_business_data | 有受保护业务清空，保留配置/凭据/备份/审计；未验收面向普通用户的完整路线，也未核对前端 local cache。详见下方会话目录问题 |
| 蒸馏成短历史节点 | [distiller](../../../backend/app/services/memory_distiller.py)、[consolidation](../../../backend/app/services/memory_consolidation.py) | 有观察/对话蒸馏→Memory Inbox 提案；尚不能证明全业务历史的预览→接受→归档→可追溯恢复路线 |
| 几天后打开、更新并刷新数据 | GOAL 的 upgrade/recovery 要求、startup recovery、现有任务/同步基础 | 多个底层部件存在；安装升级、数据刷新、历史整理的一键用户体验与真实多日稳定性未验收 |
| OfferU Skill 生态 | 总 Skill、generated projections、Registry 的功能 Skill | 支持方法 Skill 组合与任务路由基础；独立多 Skill 分发仓库、功能初始化契约和更新兼容性未单独验收 |

## 2. 两个直接影响测试可信度的发现

**安装包身份，验收阻塞。** 本机 `frontend/src-tauri/target/release/bundle/nsis/OfferU_0.4.0_x64-setup.exe` 文件大小 190526002 字节，修改时间为 9 月 7 日。时间戳不是内容 hash 或版本绑定证明；但没有任何本次证据允许把它视为包含当前未提交改动的安装物。Goal B 必须先获得/构建可绑定本次源码的发行物，在对应操作系统做真实安装。现有开发 Runtime 的成功只证明开发路径。

**新内置会话目录未进入清理清单，P1 候选。** embedded host 使用 `runtime_data_path("python_agent_sessions")`；local_data_reset 的 `_DATA_DIRECTORIES` 包含 `pi_sessions`，不包含 `python_agent_sessions`，而 `_reset_runtime_files()` 只遍历该清单和明确的 harness JSON。源码显示新目录可能保留，尚未执行隔离 reset 复现。应在合成隔离目录放入新会话 canary，经 Registry 清理并检查残留、旧上下文恢复可能性与前端缓存。不能在真实业务目录直接试验，也不能将 `file_cleanup_complete=True` 当充分证据。

## 3. BOSS CLI 到底能做什么

区分三个层次：上游声明、本机安装版本与当前账号、OfferU 集成结果。

上游 [README](https://github.com/can4hou6joeng4/boss-agent-cli) 与 [能力矩阵](https://github.com/can4hou6joeng4/boss-agent-cli/blob/master/docs/capability-matrix.md) 声明了搜索/详情/推荐、投递沟通、聊天、跟进、面试邀请和简历相关功能；能力真源是实际版本的 `boss schema`。本人本地简历/在线拉取与招聘者读取/下载候选简历属于不同角色。文档有能力并不证明本账号、本网站当前调用成功。

OfferU 当前 `BossJobSource` 明确只读 search/detail，status 成功也保持 EXPERIMENTAL；另有投递/面试进展的手动同步服务。没有把 greet/apply 映射到这个只读适配器，站外写入层仍是 preview。OfferU 没接入上游全部能力，不能把上游功能清单当成集成清单。

重新打招呼必须单独检查已沟通状态、对方拒绝、频率与消息执行结果；首次招呼能力不证明重复触达可用。本次没有跑 boss CLI、安装工具、读取 Cookie 或访问账号，所以没有实时登录/账号成功结论。

## 4. 本次确实研究的外部参考

检索日期 2026-10-02；以下是公开官方仓库文档/方法核对，不是运行竞品或历史研究完成声明。同名项目分别记录：

| 参考 | 本次读取的原始文件 | 可借鉴与边界 |
| --- | --- | --- |
| career-ops-hq/career-ops | [总 router](https://github.com/career-ops-hq/career-ops/blob/main/.agents/skills/career-ops/SKILL.md)、[访谈](https://raw.githubusercontent.com/career-ops-hq/career-ops/main/modes/interview.md) | 模块化路由、渐进上下文、一问一答追问实际经历；不照搬命令菜单或把估算成果当 OfferU 事实 |
| 同一项目的 master profile | [master-profile](https://raw.githubusercontent.com/career-ops-hq/career-ops/main/modes/master-profile.md) | 来源引用、review_status、保留原 CV；文件还明确写出其首版下游集成边界，不能把 schema 当全流程证明 |
| 同一项目的复盘 | [interview/debrief](https://raw.githubusercontent.com/career-ops-hq/career-ops/main/modes/interview/debrief.md) | transcript 优先、逐题问答与改进分开、下一轮重点、retracted claim、实际记录持续复用；其直接文件写入不能替代 OfferU Registry |
| poferraz/career-ops | [Skill](https://github.com/poferraz/career-ops/blob/main/SKILL.md) | 访谈挖掘真实事实、按模块工作、会话后保存已知信息；OfferU 不复制它的平行 user-profile.md 状态 |
| boss-agent-cli | 上述 README、能力矩阵；[命令参考](https://github.com/can4hou6joeng4/boss-agent-cli/blob/master/docs/commands.md) | 将上游能力、角色、登录、OfferU 适配与真实用户状态分别验收 |

用户随后纠正名称为“阿酥 Skill”。已主动检索并读取 [Hisn00w/ASu-skills](https://github.com/Hisn00w/ASu-skills) 的当前 registry、证据复盘、简历、岗位匹配、浏览器填写和面试复练原始文件；另核对 Claycui828 的同风格仓库及 JimLiu 的多 Skill 分发结构，详见 [补充参考研究与验收映射](./2026-10-02-career-skill-reference-review.md)。JOme 仍有名称歧义，但不再将它或链接缺失当成研究其他项目的前置条件。公开仓库 `main/master` 可变，正式实现引用应补充具体 commit。

## 5. 下一步顺序与本次检查

P0 安全否决条件仍是未经审核事实写入、Agent self-confirm、泄密、越权站外动作或损坏真实数据。本次未执行这些场景，不宣称 0 次运行风险已被证明。

建议首先完成 Goal A 的真实内置 Agent/独立审核与恢复检查；Goal B 从安装物身份、可恢复清洁环境和可见建档起步，再闭环一个真实 Job 的研究→逐段简历审核。每日多源发现、站外 connector、真实复盘和历史节点分别作为后续切片，不能用更多规划页替代实现。

本次已执行：产品 authority / proactive / Skill / 对应源码读取、工作区与 HEAD 检查、安装物元数据检查、外部原始文档联网核对。7 份文档的 65 个本地链接均存在，代码块成对检查通过；已修改文档的 `git diff --check` 通过。新产品契约原被仓库文档默认忽略规则排除，已添加仅此文件的版本化例外，其他本地文档仍沿用原策略。

本次未执行：pytest、frontend typecheck/test/build、真实模型任务、人类 Desktop 审核、浏览器 UI 验收、真实平台登录/同步/发送、clean install、macOS、清空/恢复、真实多日运行。此任务产出是文档与源码审计，运行结果保留 NOT_RUN；历史报告中的测试数不作为本次结果。
