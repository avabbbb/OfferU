# Role Intelligence v0.1 设计审计

状态：现状审计、G1–G3 后端切片、最小 Collection Provider seam 与 fixture-backed Job Detail / Evidence Gap 切片已落地。G2A fixture corpus 已有验证证据；G2B 真实外部采集仍因 Codex Auth 401 阻塞。G4/G5 fixture-backed Job Detail 链已通过浏览器 smoke 与人工质量复核，但真实市场质量尚未通过；Interview、DSH provider 和 live collector 不在本轮。已记录非阻塞静态资源问题：`http://127.0.0.1:7410/favicon.ico` 返回 404。审计/开发日期：2026-08-27。

## 1. 结论

审计时 OfferU 已经具备这条纵向闭环所需的控制面和执行面，但还没有“岗位基准”领域模型。随后 G1–G3 按本设计复用现有 `Job` 和 Deep Executor，在 Python Runtime 新增确定性的 benchmark/capability/delta 业务层；当前 fixture-backed 产品切片继续沿用这条边界，结果不塞进研究 Markdown，DSH 也没有成为业务事实源。

本轮实际确认：

- `jobs` 已保存目标岗位的标题、公司、URL、原文和 `hash_key`，作为目标及“本地已有 comparator”的统一岗位身份源；外部临时 comparator 不应强行写入 Jobs Inbox。
- `JobResearchRun`、`ResearchEvidenceSnapshot`、`ResearchFinding` 是单岗位公开网页研究的证据链；它们不是 30 份 JD 的 cohort 或统计模型。`ResearchEvidenceSnapshot` 还直接依赖 `job_research_runs`，不能用多态 `run_id` 旁路复用。
- `ProfileSection` 是当前 Career Evidence 载体；没有独立的 `CareerEvidence` 表。只能读取 active/verified evidence，不能由 Interview 自行猜测候选人能力或改写 Profile。
- `Interview`、`InterviewMessage`、`InterviewEvaluationRun` 已覆盖逐题会话、评分和完成后的 Learning Observation，可作为专项训练的执行面。
- `DeepTaskSpec`/`execute_deep_task` 已支持受限重任务、运行时能力探测、公开网页模式、会话与 trace；`DeepExecutorRoleCollectionProvider` 通过这个既有执行面接入 `role_benchmark`，不需要另建后台体系。
- Role Intelligence Core 不再把采集实现作为隐式调用：`RoleCollectionProvider` 现在有现有 Deep Executor adapter 和明确的 `ReplayRoleCollectionProvider` fixture adapter；两者都只返回 candidate envelope，业务写入仍由 Python Runtime 完成。
- 审计时 live CLI 为 122 个 Operation、33 个 Skill；本轮注册了 4 个 Role Benchmark/Capability/Delta Operation，live manifest 当前为 126 个 Operation，并新增 `role_intelligence` Skill。
- DSH 当前本地改动属于 Slice 2 host/client tracer；其职责仍应是可替换的并行执行器。未验收的 DSH 改动本轮不触碰。

## 2. v0.1 范围与不变量

目标入口仍是现有 Job Detail：用户点击“分析这个岗位和同类岗位有什么不同”。闭环为：

```text
Job
  -> Role Classifier
  -> Collector candidates
  -> Normalized JD + evidence
  -> Runtime dedupe/cohort
  -> deterministic market frequency
  -> deterministic target delta
  -> verified ProfileSection evidence gap
  -> existing Interview focus plan
```

固定规则：

- 目标岗位必须是现有 `job_id`；已在本地岗位库中的 comparator 可通过 `job_id` 关联。外部 comparator 只作为本次 benchmark 的有边界 JD 快照保存，不创建第二套通用岗位库，也不污染普通岗位 Inbox。
- cohort 至少匹配 `role_family + specialization + seniority`；地区、行业是可选过滤条件。目标样本 30，最低 15，最多 50。
- 去重顺序固定为 canonical URL、公司+职位+描述 hash、招聘平台转载关系；最终分母是去重、结构化、通过 cohort 的有效 comparator 数。
- 少于 15 个有效样本时保存运行和证据，但 UI 必须显示“样本不足”，不输出貌似精准的百分比或高置信结论。
- LLM 只返回角色分类、能力观察、原文证据和候选 alias；市场频率、方向、排序、evidence gap 分数均由 Runtime 计算。
- 第一版不接 DSH 作为必需依赖，不重写 `coding_agent_runtime.py`，不引入常驻 `RoleIntelAgent`，不自动修改简历或 Profile。
- fixture/replay runtime 只用于本地开发验收，UI 必须显示 Fixture 数据模式；它不代表实时市场数据，也不能替代 G2B live collection。

明确不做：永久全网岗位库、实时招聘 SaaS、1000+ 抓取、向量数据库、完整 Lightcast taxonomy、自动改简历/Profile、新 Agent Control Plane、LLM 计算百分比。

## 3. 最小领域模型

当前已新增并确认 4 个最小持久对象：

| 对象 | 关键字段 | 作用 |
| --- | --- | --- |
| `RoleBenchmarkRun` | `run_id`、`target_job_id`、`cohort_json`、`valid_sample_count`、`source_summary_json`、`algorithm_version`、`schema_version`、`runtime_id/version`、状态、时间 | 一次 benchmark 的可复现边界与生命周期 |
| `RoleBenchmarkDocument` | `run_id`、可选 `job_id`、`document_kind`、canonical URL、description hash、来源、原文/摘录引用、`role_family`、`specialization`、`seniority`、`domain`、normalized schema/version、纳入/排除原因 | target/comparator 的 benchmark 作用域 JD 档案；已有岗位以 `Job` 为身份，外部候选只保留本次快照 |
| `RoleCapabilityObservation` | `run_id`、`document_id`、`capability_id`、`category`、`importance`、`evidence_text`、`source_section`、`confidence`、canonicalization 状态 | 逐 JD 的可追溯能力观察；未知能力只能是 candidate |
| `RoleDeltaSignal` | `run_id`、`capability_id`、`category`、`target_importance`、`market_frequency`、计数、`direction`、`confidence`、`evidence_refs_json` | Runtime 产出的 Common/Distinctive/Highly Distinctive/Missing Common |

这不是第二套通用岗位库：`RoleBenchmarkDocument.job_id` 在可用时指向现有 `jobs.id`，新表仅保存本次 benchmark 的快照、结构化版本、证据引用和统计结果。由于现有研究 evidence 的外键只接受 `JobResearchRun`，benchmark evidence 不应伪装成既有研究 snapshot；如未来需要跨域引用，应增加明确的关系，而不是改成多态外键。

统一 JD Schema 固定为：

```json
{
  "schema": "offeru.role_jd.v1",
  "role_family": "product_manager",
  "specialization": "ai_agent",
  "seniority": "entry|mid|senior|unknown",
  "domain": "string",
  "responsibilities": [],
  "hard_skills": [],
  "business_capabilities": [],
  "behavioral_requirements": [],
  "domain_knowledge": [],
  "outcome_expectations": [],
  "constraints": []
}
```

能力观察必须保留原文，不接受只有标签的结果：

```json
{
  "capability": "model_evaluation",
  "category": "technical_product",
  "importance": "must_have",
  "evidence_text": "负责大模型能力评测体系建设",
  "source_section": "responsibilities",
  "confidence": 0.94
}
```

## 4. Alias、cohort 与 Delta 算法

Alias 是版本化的确定性配置，例如 `agent_harness / agent_framework / agent_infrastructure -> agent_runtime`。Normalizer 可以返回 `candidate_capability`，但未知概念不能改变 taxonomy，也不能进入正式频率分母，直到人工/版本配置确认。

Runtime 只对有效 comparator 计算：

```text
market_frequency(capability) = comparator_with_capability / valid_comparator_count
priority = importance_weight
           * log((N + 1) / (df + 1))
           * extraction_confidence
```

重复观察按固定 importance 优先级和最高有效 confidence 合并；展示百分比由保存的计数/分母计算，不能接受 LLM 返回的百分比。

初版方向规则：

```text
Common            target 出现 且 frequency >= 55%
Distinctive       target 出现 且 target >= medium 且 frequency <= 25%
Highly Distinctive target=must_have 且 frequency <= 15%
Missing Common    target 未出现 且 frequency >= 55%
```

结果排序、四舍五入、并列顺序、置信度聚合必须写成纯 Python 函数，并使用固定 fixture 验证重复运行得到完全相同的数字。Company Delta（同公司相似岗位、同行公司同岗位）作为同一模型的后续 cohort，不阻塞 v0.1。

## 5. Deep Executor 与 DSH 边界

新增任务契约：`task_type="role_benchmark"`，结构化输出版本例如 `offeru.role_benchmark_candidate.v1`。执行器只能返回 candidate JD、分类、normalization 和证据，不得调用 OfferU 写 Operation、直接写 SQLite 或把文件产物当事实。

采集边界通过一个最小 provider contract 固定下来：

```text
RoleCollectionRequest
        ↓
RoleCollectionProvider.collect()
        ↓
candidate envelope
        ↓
OfferU Runtime validation / dedupe / cohort / aggregate / persistence
```

当前实现：

- `DeepExecutorRoleCollectionProvider`：适配现有 local/coding deep executor，保留 `DeepTaskSpec`、公开网页能力和 `role_benchmark` task type。
- `ReplayRoleCollectionProvider`：读取固定去标识化 corpus，仅供 `runtime_id=fixture|replay` 的本地 UI/Operation 验收；不会访问外部网页。
- `RoleCollectionProvider` 不拥有数据库 session，也不产生 `RoleBenchmarkRun`、Document 或 Signal；因此 Codex 401 只会阻塞 G2B，不会阻塞 schema、统计和产品层开发。

建议的受限拓扑是 1 个 Classifier、2–4 个按来源/查询方向分工的 Collector、8–12 个批量 Normalizer、Python Aggregator，以及只验证最重要 3–5 个 Delta 的 Verifier。它们都受同一 Run、workspace、网络范围和超时限制；如果当前 Local adapter 尚未支持并行，先使用相同 `DeepTaskSpec` 的固定批次，不因此重写 deep executor。

DSH 后续只实现同一 provider contract：使用 `ctx.web` 的 `web_search/web_fetch` seam，模型不看到具体搜索 provider；worker thread 是执行隔离而不是安全 sandbox。因此 DSH 只能产生 evidence candidate 和 structured handback，OfferU Runtime 才负责去重、cohort、统计、持久化和失败可见性。

上游文档复核： [DSH workflow worker-thread](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/workflow/workflow-worker-thread/README.md)、[DSH web subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/web.md)、[DSH web tools](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/web/tool-web/README.md)。仓库路线中的 rc8 是当前集成基线，不是“当前 master 已验收”的版本证明。

## 6. Operation、Skill 与产品入口

沿用现有 `start_*`/`get_*` 命名习惯，当前已注册 Operation 与后续 G6 规划如下：

| Operation | side effects | 说明 |
| --- | --- | --- |
| `build_role_benchmark` | `external + llm + write` | dry-run 生成 proposal；确认后启动 Run |
| `get_role_benchmark` | `read` | 读取 Run、样本量、来源、状态、版本 |
| `refresh_role_benchmark` | `external + llm + write` | 复用目标与 cohort，重新收集/规范化 |
| `list_role_delta_signals` | `read` | 读取确定性 Delta 及 evidence refs |
| `prepare_role_interview_focus` | `read + llm` | G6 规划，当前尚未注册；生成未持久化 Focus Plan，保存时仍经现有 Interview Operation |

所有入口继续走 `ops.py` 的 live schema、权限、dry-run、确认提案、审计、幂等和错误语义。GUI/CLI/Harness/Skill 只调用 Operation，不直接访问服务、数据库或 DSH。Job Detail 的 fixture 按钮也只调用 `build_role_benchmark(runtime_id="fixture")`，并在界面明确告知这是本地 fixture。

新增一个 Registry-only `role_intelligence` Skill，当前白名单只覆盖读取目标 Job/Profile Evidence 和已注册 benchmark Operations；Focus Plan 留待 G6。它不是常驻 Agent。`interview_practice` 继续负责会话，`company_research` 继续负责单岗位/公司研究，`batch_evaluate` 继续负责岗位匹配评分，三者不合并职责。

Job Detail 已在现有摘要与研究证据区域之间增加岗位情报卡：Benchmark（样本数/公司数/更新时间/数据模式）、Role Family/Specialization/Seniority、Distinctive、Common、Missing/De-emphasized。每行可展开 target evidence、market count/frequency、confidence、comparator evidence 和 source jobs；失败、样本不足、fixture 和未验证 candidate 必须可见。当前只提供 fixture-backed 开发入口，不提供 live 采集按钮。

## 7. Career Evidence 与 Interview 接缝

Profile gap 只能来自 active `ProfileSection`，优先 `verified_fact`。当前 v0.1 的匹配使用版本化、确定性的 capability terms；每个链接包含真实 `profile_section_id` 和原文摘录。Runtime 根据 section 状态、tier、confidence 和匹配证据计算 `role_distinctiveness × evidence_gap`，未链接证据不得产生分数。当前结果通过 `get_role_benchmark` 返回给 Job Detail；没有自动修改 Profile。

不新增 Interview 产品或表。`prepare_role_interview_focus` 返回版本化 Focus Plan；现有 `create_ai_interview` 保存时将每道题的 `why_asked`、`delta_refs`、`evidence_refs`、`evidence_gap`、`type` 与现有问题字段一并写入 `questions_json`，并由严格 validator 校验。题型至少覆盖 Proof、Depth、Trade-off、Scenario、Contradiction。Interviewer 只提问和追问，不展示教答案；Coach 在结束后使用既有 evaluation/report 输出训练建议。

面试新认知只进入现有 Learning Observation/Memory Inbox；不自动修改 Profile。点击“开始专项拷打”应绑定目标 `job_id` 与 benchmark/focus 版本，再启动现有 Interview Operation，不能绕过确认、模型和数据同意。

## 8. Fixture 与 Gate

固定 fixture：1 个去标识化 target JD + 至少 20 个 comparator JD，人工标注预期 3–5 个 distinctive capability；当前已覆盖去重、alias、cohort、frequency、delta、少样本门槛、snapshot round-trip 和 provider seam，并新增 profile gap 的确定性测试用例。focus plan 留待 G6；统计层测试不调用 LLM。

| Gate | v0.1 通过证据 |
| --- | --- |
| G1 数据结构 | target/comparator 都得到统一 schema、能力观察和原文证据 |
| G2A Corpus pipeline | fixture/输入 JD 得到至少 15 个去重且高相关 comparator；低样本明确拒绝正式频率结论 |
| G2B Live collector | 真实 target 经外部 provider 得到至少 15 个去重且高相关 comparator；当前因 Codex Auth 401 BLOCKED |
| G3 Delta | 纯 Python 重复运行数字和方向一致，少样本明确阻断精确百分比 |
| G4 OfferU Control | 所有入口共用 Operation Registry；写入有 proposal/confirm/audit；fixture build 已从 Job Detail 触发并通过浏览器 smoke |
| G5 Product | Job Detail 已展示 Delta、样本量、证据、来源明细和 fixture 标记；signal 展开后 Evidence Gap 可见并通过浏览器 smoke 与人工质量复核；真实市场质量仍未验收 |
| G6 Interview | 专项训练使用 Delta × 已存在 Profile Evidence Gap，完成一轮且新认知进入 Learning Observation |

任一 Gate 未通过，不进入 Company Delta、DSH 并行优化或更大 taxonomy。

## 9. 已实施、验证结果与后续授权边界

当前 Gate 状态：G1 PASS（已有 targeted fixture/round-trip 证据）；G2A PASS（fixture corpus、dedupe/cohort、低样本门槛已覆盖）；G2B BLOCKED — Codex Auth 401（不要把环境阻塞写成 Role Intelligence FAIL）；G3 PASS（纯 Python 两次运行完全一致，频率/方向按 fixture 数字断言，少样本不产出 signals）；G4/G5 fixture-backed 浏览器 smoke 与人工质量复核 PASS，但仅证明 fixture 内部链路与可解释性，不证明真实市场质量；G6 未开始。

本轮实机验收记录：

- Job `#75` fixture-backed Job Detail：20 个 comparator、5 个唯一 signal；每个 signal 均有 target/comparator evidence 或明确的 target 未出现状态，展开后可见 Evidence Gap、样本量、频率和来源链接。target/comparator fixture 的 capability 与 evidence_refs 一致，没有发现重复 signal 或空结论。
- 质量边界：`#75` 的 target、`Comparator Co 01..20` 与 `jobs.example.org` 来源均为合成 fixture；因此相关性和证据只能判定为“fixture 内部一致”，不能判定为真实岗位市场质量。当前 profile 没有匹配证据时 UI 显示 `0/100` evidence strength 与缺少证据提示，没有伪造个人经历。
- Job `#50` live smoke：`POST /api/research/role-benchmarks/50/build` 已进入 `data_mode=live`，run `role_benchmark_c19e755e521e4b64aac86a558268369e` 最终因 Codex App Server 请求 `https://api.openai.com/v1/responses` 返回 `401 Unauthorized: Missing bearer or basic authentication` 失败，样本数为 0。该项登记为 G2B 运行环境阻塞，不修改认证、不恢复旧 runner、不绕过 Workflow/Executor。
- 非阻塞问题：浏览器控制台发现 `http://127.0.0.1:7410/favicon.ico` 404；Job Detail、benchmark API、fixture build、轮询和展开证据链均正常，因此本轮不修。

本轮新增/修改边界：

```text
backend/app/models/models.py
backend/app/services/role_intelligence.py
backend/app/services/agent_operations.py
backend/app/ops.py
backend/app/services/agent_skill_registry.py
backend/app/routes/research.py
backend/tests/test_role_intelligence.py
backend/tests/fixtures/role_intelligence_v0/*
frontend/src/lib/api.ts
frontend/src/components/jobs/RoleIntelligencePanel.tsx
frontend/src/app/jobs/[id]/page.tsx
```

本轮明确没有扩大到：

```text
backend/app/services/ai_interviews.py
integrations/dsh/**
coding_agent_runtime.py
live G2 collector re-run
```

下一 Gate 是产品负责人确认是否接受当前 fixture-backed G4/G5 证据；在 G2B Codex 认证恢复并完成一条真实非 fixture smoke 前，不把真实市场质量写成 PASS，也不进入 Interview Focus。当前工作区已有的未提交改动保持原样。
