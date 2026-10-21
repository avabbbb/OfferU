# OfferU 发展历史

> 状态：**历史蒸馏，不是当前权威**。更新于 2026-10-21。
> 当前设计只看 `docs/` 下 10 篇文档（入口 [README](../README.md)），实时进展看 `RELEASE_CHECKLIST.md`、`KNOWN_ISSUES.md`。
> 本页保留「做过什么、为什么改、留下了哪些约束」，不延续旧施工指令。原始材料见 [归档索引](./README.md)；2026-10-05 版的中英文蒸馏原文保存在 [pre-2026-10/history/development-history.md](./pre-2026-10/history/development-history.md)。

## 一句话演进

OfferU 从几个分散的职业工具和多轮 Agent 宿主实验出发，收敛为 **App-first、本地优先、一个岗位一个持久工作区、统一 Career Truth 与统一 Operation Registry** 的求职工作台；2026-10-21 起，产品方向进一步明确为 **Skill-first 引导的长期求职 Career OS**（见第 3 节，尚待验证）。

## 1. 阶段时间线

| 时间 | 发生了什么、为什么 | 保留下来的约束 | 证据与边界 |
| --- | --- | --- | --- |
| 2026-08 | 职业模块、可替换 Runtime 与能力插件同时推进。 | 业务写入统一走 Registry；模型输出不能直接成为职业事实。 | [8 月目标](./offeru-autonomous-2026-08/GOAL.md)、[状态](./offeru-autonomous-2026-08/STATUS.md)。Fixture/插件结果不代表公开可发布。 |
| 2026-08 ～ 09 | 尝试 DSH / 外部 Harness 作为唯一产品外壳，OfferU 作为嵌入工作区。 | 单 Run 单推理主体；用户独立批准；统一职业事实。 | [Harness 时代 Agent 设计](./architecture/agent-system-harness-era-2026-09.md)、[DSH 集成](./architecture/harness-integrations-dsh-era-2026-09.md)、[ADR 历史](./architecture/adr-history-pre-2026-09-23.md)。「Harness 是唯一外壳」后来被取代。 |
| 2026-09 上旬 | 发布工作扩展到持久化、隐私、恢复、安装包启动与失败可见性。 | 结论必须绑定被测 commit、运行时和证据层级。 | [9 月状态历史](./STATUS-history-2026-09.md)。其中端口、模型名、测试总数都是当时的测量值。 |
| 2026-09-14 ～ 16 | Codex-first 简化：降低首次配置、模型预设和过宽的工具发现面。 | 保留业务能力与 Registry；密钥留在系统钥匙串。 | [简化执行计划](./architecture/2026-09-14-simplification-execution.md)、[Operation 清单](./architecture/2026-09-14-operation-inventory.md)。257 个 operation 的数字和「暂不跑测试」不是现行规则。 |
| 2026-09-22 | Tool Surface V2：区分全部可执行能力、Agent 工具面、当前 Skill 工具面。 | Registry → Agent Tool Surface → Active Skill Surface 三层。 | 设计已并入 [08 §4](../08-module-agent-runtime.md)。 |
| 2026-09-23 | 文档围绕 Desktop、岗位工作区和明确的事实源顺序第一次重置。 | App-first 与 Skill-first 共用 Profile / Job / Application 状态；Agent 可替换。 | [重置前状态](./STATUS-2026-09-23-pre-doc-reset.md)、[旧术语](./architecture/context-pre-2026-09-23.md)。编号 ADR 不再是默认阅读路径。 |
| 2026-09-27 | Proactive Career Director 五个切片：首次建档发现、每日简报、岗位评估、面试准备与复盘、重新联系评估。 | 复用 `AutomationEvent → Rule → CareerTask → Agent/Runtime → Operation`；不另建无限循环，不自动对外联系。 | [检查点](./checkpoints/2026-09-27-STATUS.md)、[交接](./checkpoints/2026-09-27-HANDOFF.md)、[切片共享契约](./2026-10/internal/proactive-contract.md)。813 个测试只属于该检查点。 |
| 2026-09-19 | 20 个并行评审 agent 做 Apple-Bar 对抗评审：「骨架是对的，细节是问题」。 | 36 条可机械验证的评分项，达标线 ≥0.85。 | [评审汇总](./2026-10/review/apple-bar/00-SYNTHESIS.md)。评分与缺陷只属于当时代码。 |
| 2026-10-01 | 上游 Python 内置 Agent loop（`luyishui/OfferU@3a446ff9`）接入 OfferU Runtime 与界面。 | Loop 负责推理；Registry 负责执行；Career Runtime 负责持久化事实。 | commit `0cbfd54` → `fb72b34` → `265cad5`。工程接入不等于真人 Desktop 写入或安装升级已验收。 |
| 2026-10-02 | 真实求职旅程与 PR #51 蓝图评估，把验收重点转向用户的实际求职结果。 | 「源码存在」「产品路径可达」「真人可用」分别记账。 | [真实求职旅程契约](./2026-10/product/owner-career-journey.md)、[宣传片对齐审计](./2026-10/product/video-parity-audit.md)。蓝图、打包冒烟、合成档案都不等于真人 dogfood。 |
| 2026-10-02 ～ 05 | Proposal v2：语义决策组、精确授权、持久回执、原 Run 续跑。 | 批准绑定展示范围；修订保留历史；结果未知时不盲目重放。 | 合成检查与真实模型准备是有限证据；两套审批模型仍待收敛（见 [08 §10](../08-module-agent-runtime.md)）。 |
| 2026-10-05 | 本地分支从 29 条收敛到 3 条（可恢复归档）；旧根目录检查点蒸馏成历史。 | 保留未合并提交和用户文件；按切片交付并说明版本身份。 | 归档分支不等于合并或接受其功能；远端分支未删除。 |
| 2026-10 上旬 | **第二次文档重构**：`docs/` 收敛为 README + 01–09 共 10 篇，此前全部设计、ADR、Eval 说明和报告移入 `pre-2026-10/`。 | 当前文档上限 10 篇；文档与代码同 PR 修正；机器读取的 schema 移到 `docs/evidence/`。 | 映射表见 [归档索引](./README.md)。 |
| 2026-10-19 | 探索小红书招聘帖作为岗位来源（RED Skill，PR #124）；提出 Agent Benchmark v1。 | 平台未开放职位/投递 API；Benchmark 在 09 与 `backend/scripts/live_eval/` 上增量设计，不另起 runner。 | PR #124 仍为 OPEN，作者自述 Skill 未在真实 Agent 中安装运行；合并时应在发布清单标 `NOT_VERIFIED`。 |
| 2026-10-21 | **第三次归档**：把仍散落在 `docs/` 下的过时施工契约与评审移入 `2026-10/`；写下 Skill-first Career OS 与招聘官网投递助手方向。 | 见第 2、3 节。 | — |

## 2. 2026-10-21 归档清单

| 原路径 | 归档位置 | 被谁取代 |
| --- | --- | --- |
| `docs/product/owner-career-journey.md` | [2026-10/product/](./2026-10/product/owner-career-journey.md) | 01–07 各模块 |
| `docs/product/video-parity-audit.md` | [2026-10/product/](./2026-10/product/video-parity-audit.md) | 02、04（审计绑定 commit `c58c069`） |
| `docs/review/apple-bar/**` | [2026-10/review/apple-bar/](./2026-10/review/apple-bar/00-SYNTHESIS.md) | 09 |
| `docs/plans/jobsource-contract-v1.md` | [2026-10/plans/](./2026-10/plans/jobsource-contract-v1.md) | 04；实际接口以 `backend/app/services/job_sources/` 为准 |
| `docs/internal/proactive-contract.md` | [2026-10/internal/](./2026-10/internal/proactive-contract.md) | 08 §8 |
| `docs/implementation/migration-roadmap.md` | [2026-10/implementation/](./2026-10/implementation/migration-roadmap.md) | 08；外部 Harness 主控路线已被 App-first + 可替换 Agent 取代 |

每篇归档文件顶部都加了「已归档（2026-10-21）」说明。仍留在 `docs/` 下的草案（`product/tailor-regenerate-design.md`、`product/defensive-cleanup-inventory.md`、`research/xhs-job-source.md`、`evals/agent-benchmark-v1.md`）是进行中的提案，不是历史。

## 3. 2026-10-21 产品方向：Skill-first 的长期求职 Career OS

> **PROPOSAL · 下一阶段待验证**。以下来自产品负责人 2026-10-21 的描述，记录方向与理由；不表示已经实现。当前代码已有 `profile_onboarding`、岗位导入和档案冷启动，但发布清单中浏览器自动填表仍为 `NOT_VERIFIED`。要落地时，须同 PR 更新 01 §4、04 §7、08 §2 与 09。

### 3.1 定位

OfferU 不只是帮用户找岗位、改简历的 Agent 工具，而是**引导用户完成长期求职过程的 AI Career OS**。

用户第一天不需要理解职业档案、Job Workspace、Operation Registry、Workflow 或 Eval，只需要对自己的 Codex、DSH 或其他支持 Skill 的 Agent 说：

> 「我最近准备找工作，帮我安排一下。」

OfferU Skill 先理解用户的求职阶段，指导完成最必要的准备；随着求职推进，再逐步引入岗位研究、简历定制、投递管理、面试准备、复盘和自动化。

两种渐进式披露需要一起设计，但不能混为一谈：

- **技术层**：Agent 先加载 OfferU Skill，需要某项能力时再加载对应说明、调用 OfferU 工具。
- **产品层**：不一次性让用户配置所有功能，而是根据求职阶段、已有档案和当前任务引导下一步。

Skill 负责告诉 Agent 如何工作；OfferU 工作台负责保存长期职业事实、任务、投递状态和人工审核结果。

### 3.2 真实需求样本：百度社招在线简历

用户已进入百度招聘系统、上传 PDF 并点击简历解析，但自动填充存在遗漏、混杂和语义错位。当时实际走过的流程：

```text
找到职位进入官网 → 上传 PDF 获得解析结果 → 用户提供页面内容与填写状态
→ 对照原始简历检查各字段 → 发现错位/遗漏/重复/不准确 → 针对目标岗位生成结构化填写内容
→ 用户检查并填写表单（敏感字段与招聘要求由用户确认）→ 用户保存、预览、决定是否投递
```

**事实边界**：当时完成的是网页信息分析、内容整理、字段填写建议和简历文件制作，**没有**证明 Agent 能自动控制百度招聘网页或完成提交。

| 步骤 | 实际发现或操作 | 应沉淀的能力 |
| --- | --- | --- |
| 1. 识别招聘类型 | 2025 届毕业生，百度当时校招面向 2027 届，因此选社招 | 根据毕业时间和招聘批次判断申请类型 |
| 2. 检查基本事实 | 核对学校、专业、起止时间、正式职位名称、在职状态 | 从职业档案读取已确认事实 |
| 3. 检查自动解析 | CLIProxyAPI 项目职责混入个人总结、AIGC 工作成果等无关内容 | 对照原文件检测字段错配 |
| 4. 调整岗位叙述 | 工作经历改为 AIGC 产品、企业 Agent 方案和技术推广 | 根据目标 JD 生成不同侧重点 |
| 5. 重新组织项目 | CLIProxyAPI、OfferU、Flovart 分开填写 | 从项目档案生成符合字段长度的内容 |
| 6. 补齐作品集 | 个人网站、GitHub、产品作品链接 | 复用可验证的作品与成果 |
| 7. 用户确认 | 年薪、工作时间、数据真实性、目标城市、是否投递 | 高风险字段审核与最终提交授权 |

这是一条「招聘要求识别 → 职业事实校验 → 岗位定制 → 字段映射 → 表单填写 → 申请核对」的完整工作流，暂名 **Official Application Assistant｜招聘官网投递助手**。

### 3.3 招聘官网投递助手：六步

1. **读取岗位与投递方式**：先判断入口类型——大厂官网（百度：创建职位记录，进入在线简历）、招聘帖指定邮箱（小红书：解析岗位和邮箱，制作定向 PDF 与邮件草稿）、招聘平台（BOSS：按已连接能力处理，避免重复联系和投递）、校招系统（建立申请任务，识别材料与测评要求）。
2. **从职业档案建立事实基线**：学校/专业/学历/毕业时间直接映射不改写；正式职位名称与实际职责分开；只用真实可追溯的项目；描述可调整表达但不添加虚构经历；年薪、到岗时间、求职城市以最新用户决定为准，不从旧简历猜；缺失就问。保存**事实来源**，而不只是字段值——「典型视频制作周期由约 1.5 个月缩短至 2 周」可复用，但不能无证据改写成「AI Agent 效率提升 70%」。
3. **按官网字段生成不同版本**：同一段经历可能要写成 200 字工作内容、500 字工作业绩、项目职责或 100 字个人优势。区分三层：`Career Truth（事实）→ Tailored Resume（岗位定制表达）→ Application Field Draft（该网站的字段草稿）`。官网表单不得修改职业事实，也不得成为下次投递的唯一事实来源。
4. **辅助填写网页，三级能力**：
   - **L1 辅助填写**：用户粘贴页面文本或截图，Agent 识别字段，生成逐项清单与一键复制内容（百度案例已实际验证这种协作）。
   - **L2 浏览器半自动**：在用户授权的浏览器会话里读取字段、填写确定信息；遇到不确定下拉、验证或登录时交还用户。作为第一个需要端到端验收的浏览器版本。
   - **L3 受控批量投递**：针对已验证适配器执行多个申请，识别异常、记录回执、去重，最终提交仍需明确授权。需要平台适配、真实回归与合规验证，不能当作现有能力。
5. **填写结果核对与人工确认**：先读回页面状态再报告。例如学校需从标准院校下拉中选中，只在文本框输入「华南师范大学」不代表已绑定内部选项。保存简历、申请职位、同意声明、最终提交是不同操作：`DRAFT_READY → FILLED → VERIFIED → READY_TO_SUBMIT → SUBMITTED → RECEIPT_VERIFIED`。`SUBMITTED` 必须有执行证据，不能由 Agent 自称；没有回执就显示「提交结果待确认」。
6. **回写 OfferU**：保存岗位、简历版本、填写记录、待补材料、提交状态和下次跟进时间；之后收到面试通知时直接复用这些内容准备面试。

**设计原则**：职业事实单一来源，不因单次申请被静默修改；优先复用既有简历、证据和材料；区分生成、填写、保存、提交、提交成功；可靠的低风险操作自动执行，不确定字段交给用户；遇到登录验证、页面不兼容或权限限制时退化为人工辅助；所有提交具备授权、去重、结果核验和失败恢复；每次申请都沉淀为长期职业数据，而不是一次性聊天结果。

### 3.4 Skill-first 冷启动

现有主 Skill 偏向「Desktop 已安装后 Agent 连接工作台」，未连接时要求先打开 Desktop。新方向反过来：

```text
用户在 Codex / DSH 安装 OfferU Skill（不要求先理解工作台）
→ Agent 检测 OfferU 是否已安装
   未安装：说明必要性并请求授权安装 ／ 已安装：执行连接验证
→ 最小职业档案初始化（导入一份简历，确认目标岗位和求职阶段）
→ Agent 推荐第一个可执行任务（岗位分析、简历优化或官网填表）
→ 长期求职循环：今日计划 → 岗位搜索 → 申请 → 面试 → 复盘 → 调整计划
```

不另造 Agent Runtime：一个 Agent、一个 OfferU 业务事实源。Agent 负责理解和推理，Skill 负责工作方法与能力发现，Operation Registry 负责可靠的业务操作与持久化。首次安装要有清晰的权限提示、可信安装来源与连接验证；安装失败时仍可帮用户整理简历，但不能假装已写入 OfferU。

### 3.5 校招测评：准备与流程助手

可以识别性格测评、能力测验、技术笔试、材料上传和截止日期，生成准备计划、模拟练习、知识点复盘与提醒。**不以替用户完成测评为目标**：实际测评由用户本人完成；考试限制 AI 辅助时不代答，不规避身份核验或监考。

### 3.6 首个官网填表 Eval

给定一份真实简历、一份百度 JD 和一份含解析错误的模拟在线表单，检查 Agent 能否生成正确的填写结果：

| 维度 | 验收标准 |
| --- | --- |
| 字段完整性 | 需要填写的字段都有正确映射 |
| 事实准确性 | 工作时间、正式职位、个人成果没有被编造 |
| 解析修复 | CLIProxyAPI 项目职责不混入其他项目内容 |
| 岗位适配 | 表述针对 JD 调整，但不篡改事实 |
| 人工确认 | 年薪、地点、在职状态等不确定项不擅自决定 |
| 执行安全 | 填写成功不等于提交成功；不出现未经授权的申请 |
| 结果恢复 | 页面刷新、任务中断后不重复投递，保留已确认材料 |

先让 L1 字段草稿模式稳定通过，再进入 L2 浏览器执行评测。

### 3.7 与现有设计的对照（2026-10-21 盘点）

- 官网投递助手的骨架已在 [04 §3/§7](../04-module-job-workspace.md)：扫描表单（不填写）→ 字段分级 → 计划绑定 URL、字段指纹与过期时间 → 逐字段结果 → 扩展永不提交。`agent_skill_registry.py` 已有 `application_assistant`（partial），复用而不新建 Skill。
- 状态链映射到现有 `ApplicationAttempt` 与回执流程，不另造第二套状态机；Agent 永远不能产出 `SUBMITTED`。
- 真正的缺口：写入侧连接器为空（`list_application_action_connectors` 返回空矩阵）；没有任何真实招聘官网的表单规则包；缺「字段草稿」这一层；Skill 在未装 Desktop 时直接停住。
- 建议顺序：P0 L1 字段草稿 + 百度 Eval → P1 Skill 冷启动改为「检测 → 说明 → 授权 → 安装 → 连接」（改生成器，不手改 SKILL.md）→ P2 百度表单规则包从 fixture 走到 verified 后再开放 L2 → P3 L3 批量投递暂只写 PROPOSAL。

用户要的不是一个有十几个模块的 AI 求职软件，而是：「我想找到一份适合自己的工作，但不知道每天该做什么、怎么准备、怎么投递。你能不能一直帮我推进，直到我拿到 Offer？」Skill-first 让用户容易开始，工作台让长期成果不丢失，招聘官网半自动投递是其中最具体、最值得优先验证的高频场景。

## 4. 已被取代的旧要求

| 旧要求 | 现行处理 |
| --- | --- |
| 某个 Harness 独占产品外壳；禁止任何内置推理。 | Desktop 是 App-first 默认入口；已验证的用户 Agent 与显式选择的内置 Agent 共用同一 Registry。 |
| 静态 operation 总数和宿主优先级列表定义当前能力。 | 以实时 Registry、宿主适配器和一致性证据为准。 |
| 编号 ADR 自动有效。 | 决策已并入 01、08；旧 ADR 只说明来由。 |
| 旧 PASS 总数或能跑的源码服务器证明可发布。 | 结果绑定代码与产物，模型、人工、安装包分层记录。 |
| 每个底层 mutation 都单独要人工决定。 | 按语义分组审核具体修改；不扩大授权，不自我批准。 |
| 外部 Harness 主控迁移路线（migration-roadmap）。 | App-first + 可替换 Agent（08）。 |

## 5. 施工经验

1. 先把一条业务链闭环（状态、审计、续跑、恢复），再扩展覆盖面。
2. 先冻结共享接口，再小包持续集成。
3. 验证整份任务，覆盖前序分组改动过的源码版本。
4. 区分业务成功、执行回执和后续模型续跑。
5. 明确用户的 checkout 和正在运行的 App 是否包含本次改动。
6. 填写成功 ≠ 保存成功 ≠ 提交成功；没有可验证证据的「成功」一律视为 False Success。

这些经验补充 `AGENTS.md`，不放宽安全、数据迁移或发布门槛。

## 6. 阅读策略

先读 `docs/` 下当前文档；需要理解演进时读本页；只为具体历史问题再打开原始归档。旧证据保留原日期与范围：不把未知项写成通过，也不把无法确认仍适用的旧失败无限扩大为当前门槛。
