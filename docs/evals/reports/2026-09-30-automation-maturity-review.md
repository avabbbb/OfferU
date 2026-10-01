# OfferU 外部求职自动化成熟度评估

审计日期：2026-09-30。代码基线：本地 HEAD `67a1d9da49d81530a83d5fe40bb40f0f5c0d070d`，含现存未提交改动；不是已发布 main 或安装包验收。此次只审计、研究和运行隔离测试，没有更改业务实现，没有访问真实邮箱、BOSS 会话，也没有对外提交、发送或联系。

“那个”暂按前文 Ashore + Muse 理解；用户尚未提供可独立核实的 Ashore 官方入口。以 Simplify、Huntr、JobCopilot 官方能力补充对照。Muse 是兼容目标之一，不是用户选定的主力 Agent。

## 结论与判定方法

OfferU 的进度候选、审核、时间线等领域实现已有实质基础，邮箱接近可进行受控试用的链路；多站点填表仍是部分字段的辅助能力，站外写执行器和提交回执闭环尚未完成，BOSS 为实验性只读接入。不能宣称“各类大厂全流程自动投递、自动跟踪成熟可用”。

采用“未接通 / 实验性 / 有实现及隔离测试 / 实际账户验收 / 持续稳定运行”区分证据层次，不给没有样本支撑的总分或成功率。选择器、单元测试、离线 DOM、第三方 README、Agent 连接成功分别不能替代真实表单、真实授权、提交成功凭证和结果回写证据。

## 当前能力矩阵

| 能力 | 当前实现与边界 | 可支持的结论 |
|---|---|---|
| 大厂/ATS 识别 | SmartFill 导入飞书、北森、Moka、大易、自建、ATSX、Hotjob、阿里、电信、网易及 unknown 适配器 | 存在适配实现；不等于逐家企业全流程支持 |
| 辅助填写 | 实际 content 入口调用 prepare/apply CriticalSmartFillPlan；先预览再确认，保留已有值，校验 URL 和两分钟有效期，写后回读 | 有限辅助填写，尚无本轮真实账户验收 |
| 完整申请表 | critical-plan 仅选择姓名、联系方式、院校/学历等匹配字段；敏感字段、checkbox/radio、附件、非关键字段跳过 | 不能承诺完整填写经历、筛选问题、附件和声明 |
| 最终提交 | 扩展不提交；ApplicationActionRegistry 返回 execution_available=false | 未接通站外写执行器；审批/preview 不代表已经执行 |
| 官网投递后自动跟踪 | ReceiptEvidence 等合同存在；HTTP control 的 createSubmissionCandidate/confirmSubmissionCandidate 仍抛待实现错误 | 提交回执到正式进度的扩展闭环未完成 |
| 邮箱同步 | Gmail history / IMAP UID 增量同步、只读传输、重复信号去重、失败不推进 cursor、重启恢复、授权撤销 | 有实现及隔离测试；真实 OAuth/IMAP 环境未验收 |
| 邮件阶段判断 | 规则 + 可配置 LLM 分类，证据片段验证、匹配投递尝试、分类冲突处理 | 生成待审核进度；本轮关闭 LLM 网络分类，未验证真实模型准确率 |
| Pipeline/日历更新 | review_application_progress 接受候选后写正式阶段/时间线，支持匹配歧义与跨渠道重复处理 | 有隔离持久化测试；未进行真实邮件→独立人工确认→UI 全链路验收 |
| BOSS 搜索/详情 | experimental subprocess adapter，status/search/detail 只读 | 实验性接入；本机未发现已安装 boss CLI，未运行真实会话 |
| BOSS 进度 | 手动 Sync now 读取 me --section deliver / interviews，进入同一进度候选管线 | 不等于持续无人值守监控，未完成实际平台验收 |
| BOSS 操控 | OfferU 明确不映射 apply/greet/submit/contact；没有外部写执行器 | 不能通过 OfferU 宣称已支持打招呼、发简历或投递 |
| Agent 长程自动化 | 存在 Runtime/Operation/任务架构不自动证明上述外部链路成功 | 未证明“选岗→准备→批准→投递→回执→邮件→进度”的 Agent-native E2E |

代码证据：

- `extension/entrypoints/content.ts` 挂载 `extension/src/content.ts`；后者调用关键字段计划，而非仅存在于测试的全量 pipeline。
- `extension/src/content/smartfill-v2/pipeline.ts:229` prepare、`:285` apply、`:326` 明确 `submitReadiness=false`。
- `extension/src/content/smartfill-v2/core/critical-plan.ts` 的字段/敏感过滤，以及附件、radio/checkbox 排除。
- `extension/src/background/offeru-control-http.ts:249` 起 FillProjection、FillOutcome、SubmissionCandidate、Confirmation 四个 port 方法仍为待实现。
- `backend/app/services/application_action_registry.py:124` 明确 external execution unavailable；`application_actions.py` 为 preview only。
- `backend/app/services/email_sync.py:1018` 同步、`:1120` 观察记录、`:1166` requires_review、`:1446` 同步轮询；main lifespan 已接启动/关闭。该轮询是传输服务，不应误称第二套推理 Agent Loop。
- `backend/app/services/application_progress.py:192` LLM 分类、`:829` 候选审核提交；前端 email 页面提供同步状态/待审核入口，但本轮未进行浏览器验收。
- `backend/app/services/job_sources/adapters/boss.py:29` CLI 选择、`job_sources/boss_progress.py:211` 手动只读同步。

## 与公开产品的可比之处

| 产品 | 可核实的公开能力 | 与 OfferU 的差距/边界 |
|---|---|---|
| Simplify Copilot | 官方宣称支持 100+ 申请门户，列出 Workday、Greenhouse 等；填写与用户提交后的自动记录已是明确产品流程 | OfferU 当前缺经过逐站验收的覆盖清单和回执闭环；不能将美国 ATS 覆盖推断为中国大厂覆盖。来源：[官方 Copilot](https://simplify.jobs/copilot) |
| Simplify 邮箱 | Gmail 邮件匹配、自动建议状态，Approve/Decline/Approve All；仍标 public beta | OfferU 保留人工审核并非落后设计，但实际授权体验和匹配可靠性还需验收。来源：[官方 Email Integration](https://help.simplify.jobs/articles/0236686-email-integration) |
| Huntr | 可见表单辅助填写；不支持站点不填；用户选择 Save Job to Applied Stage | 属于辅助操作，不能作为无人值守自动提交成熟度证据。来源：[官方扩展说明](https://help.huntr.co/en/articles/9859408-the-huntr-chrome-extension) |
| JobCopilot | 官方提供自动申请与填写后审核两种模式 | 公开有自动提交产品，OfferU 尚未接通；本轮未实测其成功率、重复率或中国大厂覆盖。来源：[官方配置流程](https://jobcopilot.com/optimize-jobcopilot-to-auto-apply-to-jobs/) |
| Ashore + Muse | 未独立核实 Ashore 的站点覆盖、回执、状态更新和恢复实现。Meta 已公开 Muse custom connectors | 可比较分工思路，无法可靠排名投递成熟度。Connector 存在不证明 OfferU/Ashore 已兼容或求职链路已通过。来源：[Meta 官方](https://about.fb.com/news/2026/09/introducing-muse-small-business/) |

这些是官方能力披露对照，不是同条件账号实测，也不是整款产品的胜负排名。OfferU 的证据与权限模型不自动转化为用户体验优势；必须让用户看见正确的材料、真实的结果和可恢复的任务。

## 明确缺口和设计漂移

1. **回执闭环缺失（交付阻塞）**：有字段填写不代表已投递。当前扩展 receipt port 尚未实现，无法把官网成功凭证稳定物化为 canonical Application / Timeline。
2. **外部写执行器缺失（能力缺口）**：没有已接通的 submit/send/greet/send_resume executor。现有 GOAL.md:98 本身禁止自动外部提交；若未来改变无人值守权限必须单独明确产品策略。当前可优先实现用户提交后跟踪，不通过绕过 Registry 增加“自动化”。
3. **规则包设计与实际入口不一致（P1）**：browser-extension.md 规定只有唯一 verified SiteRulePack 可写；实际关键字段入口使用 detectSite/ATSRegistry，再直接 writeBatch，没有消费该规则包准入。这并不否定现有字段过滤，却说明签名规则包/verified 治理还不能作为当前写路径的保证。内置真实网站规则仅见 experimental BOSS 读取包，其他内置包是 fixture。远程 bundle 本轮读取失败，因此不判定远程服务永久不可用，也不假定已有 production verified 覆盖。
4. **真实 ATS 验收缺口（P1）**：7 个真实保存 HTML 测试因 fixture 缺失跳过；其他 DOM 测试不能证明网站在线交互、网络保存、多页流程和附件都成功。泛化 unknown adapter 也不能算经过认证的平台。
5. **BOSS 依赖识别不足（P1）**：优先调用 PATH 中任意 boss，否则 uvx 拉取未固定版本的 boss-agent-cli；未看到身份/版本/schema 协商。存在其他包也提供 boss 命令，不能假定同名同协议。当前 me --section deliver 命令与正确上游源码一致，撤回以另一项目 boss applied 文档推断断链的怀疑。正确上游：[boss-agent-cli](https://github.com/can4hou6joeng4/boss-agent-cli)、[me 源码](https://raw.githubusercontent.com/can4hou6joeng4/boss-agent-cli/master/src/boss_agent_cli/commands/me.py)。其公开有 greet/apply 等能力，但未迁移进 OfferU，也不是 BOSS 官方开放接口保证。
6. **BOSS 两种登录链路体验未证明统一（P1）**：Settings/扩展连接 BOSS cookie 的提示存在；CLI 则使用自身 AuthManager。没有证据证明扩展显示“已连接”就代表 CLI 会话可用，必须按执行器展示状态并回读验证。
7. **邮箱测试隔离遗漏（P1 验收缺陷）**：测试 patch 了 email_sync/application_progress 的 session，遗漏 career_memory 的 session，导致新增观察记录访问另一个隔离数据库的未建表。不能将此直接称为真实邮箱运行故障，但标准回归仍失败，须修复测试边界。

## 本轮实际检查

所有测试使用 H:/tmp/offeru/automation-maturity-20260930；没有读取或更改用户正式业务数据库/钥匙串。

- 后端：`pytest tests/test_email_incremental_sync.py tests/test_application_progress.py tests/test_application_actions.py tests/test_application_action_registry.py tests/test_job_sources.py -q`：**43 passed / 2 failed**。12 个 datetime 弃用警告。关闭 progress LLM 网络分类。
- 独立重跑邮箱测试：**9 passed / 2 failed**，同为 `no such table: learning_observations`，错误发生于 career_memory.record_learning_observation。
- 审计诊断：仅在 H 盘临时 pytest plugin 中将 career_memory session 绑定到每条邮箱测试的隔离 session；两条失败用例 **2 passed / 9 deselected**。未修改项目实现或测试；诊断通过不能把原始失败改记 PASS，也不替代实际邮箱/模型验收。
- 扩展：`npm run test`：**213 passed / 7 skipped**，29 个文件通过、1 个跳过。跳过原因是 `references/zhaoping html` 所需真实保存 HTML 不齐。
- 扩展：`npm run typecheck`：**PASS**。
- 本机 boss 查找：未发现已安装 boss；没有执行 uvx 自动下载/运行第三方工具。
- 未运行：真实 BOSS 登录/搜索/投递、真实邮箱授权/分类、在线 ATS 填写/提交、人工 HITL、Browser UI E2E、打包后的 Desktop、持续多日后台任务、竞品付费账号实测。本轮没有代码变更，不以 production build 代替这些证据。
- 原始邮箱回归日志：`H:/tmp/offeru/automation-maturity-20260930/email-tests.txt`；临时诊断：同目录 `diagnose_email_tests.py`。

## 建议的下一切片与验收

优先顺序依据可闭环程度，不增加第二套实体、Agent 或调度器：

1. 邮箱：先修复回归隔离；选一个真实 provider 完成用户授权→只读同步→正确匹配 Job/Attempt→候选→独立人工审核→Timeline/Pipeline/Interview UI→重复同步/撤销/重启恢复。至少覆盖通知、拒信、歧义与转发；记录误匹配和未知，不虚报准确率。
2. 一个明确 ATS：发布准确支持范围；确认填写→验证站点实际保存→用户手动提交→读取带岗位关联的成功回执→通过 Registry/HITL 记录→重复回执不重复创建。完整保留失败、受保护字段和人工接管状态。
3. BOSS：固定/验证包身份及支持版本，schema 能力协商；验证实际账号的只读搜索与进度候选。之后才能讨论单项授权的外部写能力，不把原生第三方 CLI 的全部能力搬成绕过权限的 shell。

产品当前适合按“受控试用的职业工作台 + 部分辅助自动化”描述；面向付费用户承诺“大厂全面适配、稳定自动投递跟踪”需要上述实际链路与持续运行证据。
