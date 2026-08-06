# OfferU 内测就绪度评估报告

> [!WARNING]
> **历史 pre-eval 快照，不是当前发布门。** 本文早于 `offeru-core-v1` Eval 规范，未完整保留逐任务命令、退出码、试验次数、Agent 轨迹和最终状态证据；其中结论只能作为待复现假设，不能证明当前版本已通过或仍存在同一问题。当前规则见 [Eval 手册](../README.md)。凭据相关内容已脱敏。

> 评估日期:2026-08-05
> 评估方式:启动前后端服务,通过机器 CLI + 服务器 API + GUI 真实模拟用户全流程操作
> 评估范围:职业档案、岗位采集/研究/投前决策闭环、简历提案与优化、AI 面试、投递进展、GUI 前端、Agent 运行时

## 一、结论摘要

**当前状态:尚未达到可直接进行内测宣传的程度。** 框架、数据模型与 GUI 质量接近可内测水平,但存在 **1 个关键配置阻塞 + 2 个 P1 代码缺陷 + 1 个静默降级问题**,导致系统的核心价值(AI 面试、定制简历、岗位研究、主 Agent)全部无法产出真实结果。修复门槛低(1 个有效 API Key + 约 3 处小改动 + 测试数据清理),修复后可重新评估。

| 维度 | 就绪度 | 说明 |
|---|---|---|
| 服务运行 | 🟢 通过 | 后端(8000)+ 前端(3300)正常启动,174 个 API 端点 |
| Operation Registry | 🟢 通过 | 118 个操作,提案→确认契约完整,业务规则门生效 |
| 职业档案 | 🟢 通过 | 证据添加、记忆提案审核、落地档案全链路可用 |
| 岗位采集/分诊 | 🟢 通过 | JD 导入、分诊、筛选、投递入口均可用 |
| 岗位研究 | 🔴 阻塞 | codex schema bug(`uniqueItems`)+ CLI 无法支撑长任务 |
| 投前决策闭环 | 🟡 部分 | 规则门正确,但依赖已损坏的研究,无法闭环 |
| 简历提案与优化 | 🔴 阻塞 | 规则门正确,但被投前决策 + LLM 双重卡住 |
| AI 面试 | 🔴 阻塞 | 数据授权门正确,但 LLM key 无效(401) |
| 投递进展/邮件 | 🟡 部分 | 进度板可用,邮件已连接但同步全部失败 |
| 简历 PDF 导出 | 🟢 通过 | 生成有效 ATS PDF(165KB) |
| 简历文档解析 | 🟢 通过 | PDF 文本提取 + 质量评分正常 |
| GUI 前端 | 🟢 通过 | 全部核心页面渲染完整,数据流通正常 |
| Agent 运行时 | 🟡 部分 | Pi SDK 管线可用,但 LLM 失败时静默返回空 |

## 二、阻塞问题(P1,必须修复才能内测)

### 1. 无有效 LLM API Key —— 全部 AI 功能不可用
- **现象**:AI 面试报「LLM API Key 未配置(provider=qwen)」;服务器路径报「模型未返回可解析的问题 JSON」。
- **根因**:两套配置源全部无效。
  - `backend/.env`:QWEN_API_KEY / DEEPSEEK_API_KEY / OPENAI_API_KEY 全部为空,`LLM_PROVIDER=qwen`
  - `backend/config.json`:当时配置的 DeepSeek 凭据已失效；测试连接返回 401。原报告中的 Key 前后缀已删除，禁止在报告中记录任何凭据片段。
- **影响**:AI 面试、简历优化、求职信、记忆整理、进展信号分类、Agent 回复等所有 LLM 功能全部失败。
- **修复**:在设置页「大模型接口管理」填入有效的 API Key(可测通后保存)。

### 2. CLI 与 GUI 配置源脱节 —— 违反「统一 Operation Registry」原则
- **现象**:同一 Operation 在 CLI 与 GUI 表现不同。
  - CLI(`python -m app.cli`):独立进程只读 `.env` → qwen 空 key → LLM 操作失败
  - 服务器/GUI:导入 `app.routes.config` 时同步 `config.json` → deepseek 有效配置 → LLM 操作可执行
- **影响**:外部 Coding Agent 通过 CLI/Skill 控制 OfferU 时,所有 LLM 操作必然失败,与项目自身原则「GUI、CLI、TUI、斜杠 Skill 和本地 Coding Agent 都必须通过同一 Operation Registry」冲突。
- **修复**:CLI 启动时也同步 `config.json`(与服务器一致),或统一配置来源。

### 3. 岗位研究彻底损坏 —— codex 执行器 schema bug
- **现象**:`start_job_research` 启动的 codex worker 立即失败,错误:
  `Invalid schema for response_format 'codex_output_schema': In context=(..., 'source_refs'), 'uniqueItems' is not permitted`
- **根因**:`backend/app/services/job_research.py:154` 的 `JOB_RESEARCH_OUTPUT_SCHEMA` 中 `source_refs` 数组带 `"uniqueItems": true`,OpenAI/codex 严格 schema 校验不允许该关键字。
- **影响**:所有 codex 路径的研究均无法完成;claude 路径另有 2 次失败记录(一次证据门拒绝、一次 hosted task resume 问题)。**研究能力在此环境从未端到端成功过**(现存 4 条「completed」研究实为 0 findings 的测试 fixture)。
- **修复**:移除 `uniqueItems`(约 1 行)。

### 4. CLI 一次性进程无法支撑长任务 —— 研究/执行器任务必然卡死
- **现象**:CLI confirm 启动研究后 run 卡在 `running`,worker 目录为空,进程退出任务即被杀死。
- **根因**:`job_research.start_job_research()` 用 `asyncio.create_task(_execute_run())` 调度;CLI 是单次进程,事件循环随命令退出关闭,任务从未执行。只有服务器这类常驻事件循环能真正跑完。
- **影响**:通过 CLI / 外部 Agent 发起研究不可行(GUI 路径不受影响)。
- **修复**:CLI confirm 对 external/长任务操作需保持事件循环等待,或明确文档化「长任务仅 GUI 支持」并让 CLI 返回 pending 状态而非静默卡死。

### 5. Agent 失败静默降级 —— 违反「不得静默降级」原则
- **现象**:主 Agent run 在 LLM 失败时 `status=completed` 但 `assistant_message` 为空,无任何错误事件,用户看到空白回复。
- **根因**:Pi worker 捕获 LLM 异常后未向上传递错误,run 以空消息「完成」。
- **影响**:用户无法区分「正常但无输出」与「LLM 故障」,破坏对 AI 特性的信任。
- **修复**:LLM 调用失败时 run 必须置为 failed 并在事件/回复中暴露错误。

## 三、非阻塞问题(P2)

- **邮箱同步全部失败**:IMAP/Gmail 已连接,但 3 次同步运行均为 failed,错误为泛化的「邮箱增量同步失败」,需检查授权与 provider 游标。
- **测试数据污染**:数据库混入大量测试 fixture:
  - 25 个工作源全部指向已删除的临时目录(`no-change-*`、`sync-*` 等)
  - 28 个岗位中多为 `T*岗位-slice01` / `T*公司-*` 测试岗位
  - 20+ 条档案证据含 `T2教育条目-slice01`、`个人经历 3/10` 等测试条目
  - 31 份简历中约 20 份为 `T5用户-*` 测试简历
  - 12 条投递记录全部为 `T6公司-*` 测试数据
- **claude 执行器研究不可靠**:2 次失败(证据门过严 + hosted task resume 兼容问题)。
- **初始化引导与数据不一致**:档案已存在但仍弹出「OfferU 初始化」引导(档案经由 CLI 建立,未被标记为已完成 onboarding)。
- **job_stats 与 list_jobs 总数不一致**:`job_stats`(period=week)返回 12,`list_jobs` 返回 28 —— 语义不同(周过滤),但内测用户会困惑。
- **favicon 404**(前端首页 console 报错,轻微)。

## 四、验证通过的能力(内测基础扎实)

1. **提案→确认契约**:add_profile_evidence / import_jd / triage_job / export_resume_pdf 均按「先持久化 proposal → 独立 confirm 执行」工作,dry-run 正确拦截。
2. **业务规则门正确拦截**:
   - 简历优化被正确拦截:「只有审核通过投或有条件投的岗位才能生成简历提案」(投前决策闭环生效)
   - 面试被正确拦截:「缺少数据类别同意: interview_transcript, job_research」(数据授权边界生效)
   - Guardian 输出「档案缺少联系方式(high)」预警
3. **档案闭环**:证据添加(20→21)、记忆提案审核接受后落地为档案项目(21→22)。
4. **岗位采集**:导入真实 JD(星图智能 AIGC产品经理)成功,分诊 picked,今日面板正确展示。
5. **简历 PDF 导出**:生成有效 ATS PDF(165,650 字节,sha256 完整)。
6. **简历解析**:PDF 原生文本提取 + 逐页质量评分(0.731)正常,OCR 未配置时可明确降级。
7. **GUI 全页面**:今日/机会/材料/进展/面试/档案/设置均完整渲染,数据从 CLI 操作实时反映到界面;设置页「测试连接」正确暴露 401 错误。
8. **Agent 运行时管线**:Pi SDK worker 创建 run、事件流、Guardian 评估均正常,20+ 技能目录定义清晰。

## 五、内测前必做清单

| 序号 | 事项 | 类型 | 预估工作量 |
|---|---|---|---|
| 1 | 配置有效 LLM API Key 并验证 | 配置 | 5 分钟 |
| 2 | 移除 `job_research.py:154` 的 `uniqueItems` | 代码 | 1 行 |
| 3 | CLI 启动同步 `config.json`(修复配置脱节) | 代码 | 小 |
| 4 | Agent LLM 失败改为显式 failed(禁静默) | 代码 | 小 |
| 5 | 清理测试数据(岗位/简历/证据/工作源/投递) | 数据 | 中 |
| 6 | 排查邮箱同步失败 | 代码 | 中 |
| 7 | 修复 claude 执行器研究或标记仅 codex 可用 | 代码 | 中 |

## 六、内测宣传建议

- **可宣传点**:本地优先、证据驱动、提案/确认审计契约、五阶段求职闭环、GUI 设计成熟度。
- **暂不可宣传点**:AI 面试、岗位调研、定制简历的「AI 生成质量」——目前无法演示真实产出。
- **建议路径**:先修复必做清单(预计半天内),再用有效 Key 重跑本报告的四个 LLM 闭环(研究→决策→简历→面试),验证产出质量后再决定是否开启内测宣传。
