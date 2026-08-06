# ADR-0048 落地差距分析（职业模型条目账本）

> 日期：2026-08-05
> 事实源：`docs/adr/0048-evolve-career-model-through-an-item-ledger.md`（accepted）+ `CONTEXT.md` 新术语
> 方法：对照现有 `career_memory.py` / `memory_distiller.py` / `memory_consolidation.py` / `agent_operations.py` / `models.py` 实现逐条核对
> 状态：Slice 1+2+3+4 已实施（2026-08-05），实施记录见下文「已实施变更」

## ADR-0048 验收点

1. **条目级变更账本**：每次已接受/已撤销的变化按条目追加，保留变化前后、来源、理由、影响和**取代关系**；当前职业模型从**仍有效的条目派生**。
2. **求职偏好门**：明确陈述的偏好视为已确认可直接追加；行为信号/Agent 推断只能形成待审核提案。
3. **岗位职业投影**：面向岗位生成临时视图，不改写长期模型；跨岗位可复用的新发现必须重新经学习观察与审核后回流。
4. **逐项撤销 + 来源级联失效**：单项可撤销且保留审计；来源失效时级联清理派生物。
5. **下游材料过期判断**：派生视图使下游（简历提案、投前决策）能判断材料是否过期。

## 现状对照（backend/app）

### 已符合
- 观察→提案→HITL 确认管线完整：`CareerSource` → `LearningObservation` → `MemoryProposal`（before/after/reason/impact）→ `review_memory_proposal`（accept/reject/defer/revoke）→ `add_profile_evidence` 写入 `ProfileSection(tier)`
- 事实门：`validate_generated_content` 阻止来源不可验证的写入
- 来源级联失效：`invalidate_memory_source` 已实现（观察/链接/提案/档案条目四级清理，最小审计外壳）
- distiller / consolidation 只产提案，不直接写 Profile（HITL 不变）
- tier 分层存在：`verified_fact` / `preference` / `career_hypothesis`（`profile_schema.normalize_profile_tier`）

### 缺口

| # | 缺口 | 证据 | 影响 |
|---|---|---|---|
| G1 | **无取代关系** | `MemoryProposal` 无 `supersedes_id` 字段；纠正/取代只能新增行，旧条目无失效标记 | 无法表达「新事实取代旧条目」，账本不完整 |
| G2 | **当前模型未从账本派生** | accept 后直接写入 `profile_sections`（当前态表）；revoke 时**物理删除** `ProfileSection` 行（`career_memory.py:revoke` 分支 `delete(ProfileSection)`），`applied_profile_section_id` 悬空 | 撤销历史不可追溯、不可解释；"仍有效条目派生当前模型"未成立 |
| G3 | **无岗位职业投影** | 投前决策/简历优化直接读全量 `profile_sections`；无按岗位选择+组织的临时视图 | 岗位研究/简历材料可能引用不相关或已失效条目；跨岗位不污染无机制保障 |
| G4 | **偏好门未显式化** | `create_memory_proposal` 可被任意调用方传入 `preference` tier；无「明确陈述 vs 推断」的写入路径区分（distiller 产提案路径 OK，但门未在服务层强制） | 行为信号可能绕过收件箱直接成为偏好 |
| G5 | **下游无过期判断** | 简历提案/投前决策读档案时无「条目是否仍有效/来源是否失效」检查 | 撤销/级联失效后下游材料仍引用旧事实 |

## 建议切片（依赖序）

- **Slice 1 账本内核**（backend 数据模型 + 服务）：
  - `MemoryProposal` 增加 `supersedes_id`（自引用）与 `revoked`/`applied` 审计时间字段；revoke 不再物理删除 `ProfileSection`，改为失效标记并保留审计外壳
  - 新增 `derive_career_model()`：从 accepted+未失效提案/条目派生当前模型视图（tier 分组、取代链解析、来源状态检查）
  - 新增账本查询 Operation（按条目/按取代链/按来源）
- **Slice 2 岗位职业投影**：
  - 新增 `build_job_projection(job_id)`：从派生模型按岗位选择相关证据+偏好+已验证方向，组装临时视图
  - `pre_application_decisions` / `resume_optimization` 消费投影而非裸 `profile_sections`
- **Slice 3 偏好门显式化**：
  - `add_profile_evidence`/`create_memory_proposal` 服务层强制：`preference` tier 只能来自「明确陈述」路径（direct）或经收件箱（提案）；行为信号直写被拒
- **Slice 4 前端**（如需）：记忆收件箱展示取代链与撤销审计；档案页展示条目来源状态

## 验收映射

| ADR 验收点 | Slice |
|---|---|
| 条目账本 + 取代关系 + 派生 | 1 |
| 逐项撤销保留审计 | 1 |
| 来源级联失效 | 已实现（1 需回归） |
| 岗位职业投影 | 2 |
| 偏好门 | 3 |
| 下游过期判断 | 2（投影携带条目有效性状态） |

## 已实施变更（2026-08-05）

### Slice 1 账本内核
- `models.py`：`ProfileSection` 增加 `status`（active/revoked/invalidated/superseded）、`invalidated_at`、`superseded_by_id`；`MemoryProposal` 增加 `supersedes_proposal_id`、`applied_at`（`database._auto_migrate` 自动补列）
- `career_memory.py`：
  - `create_memory_proposal` 增加 `supersedes_proposal_id`（目标须 accepted 且已落地，链上环检测）
  - accept 时落 `applied_at` 并把被取代条目标记 `superseded` + `superseded_by_id`
  - revoke 由物理删除改为 `revoked` 标记（保留审计外壳）；已被取代的条目拒绝撤销
  - `invalidate_memory_source` 级联失效由删除改为 `invalidated` 标记；返回字段名保持兼容
  - 新增 `derive_career_model()`（有效条目派生当前模型：tier 分组、来源有效性标注、失效审计）与 `list_career_ledger()`（账本查询，含取代链与落地条目状态）
- `agent_operations.py` / `ops.py`：转发与注册新 Operation `derive_career_model`、`list_career_ledger`；`create_memory_proposal` 参数扩展

### Slice 2 岗位职业投影
- 新增 `services/job_projection.py`：`build_job_projection(job_id)`（确定性 token 共现相关性选择，不调模型，不修改长期模型）+ `reorder_sections_by_job_relevance`（下游事务内排序辅助）
- 注册 Operation `build_job_projection`
- 下游全部消费路径只读 `status == "active"` 条目，并按岗位相关性排序：
  `pre_application_decisions` / `resume_optimization`（含 source 校验=下游过期判断）/ `routes/profile.py`（bundle、categories、generate-narrative）/ `routes/interview.py` / `routes/optimize.py` / `routes/resume.py` / `routes/profile_agent.py` / `agent_operations`（list/add 去重）/ `ai_interviews` / `batch_job_evaluations` / `optimize_agent`（两处）/ `memory_distiller`（两处）/ `memory_consolidation`
- 文档：ADR-0011 标记 partially superseded by ADR-0048

### Slice 3 偏好门显式化
- `add_profile_evidence` 增加 `preference_confirmation`（direct|proposal）：`tier=preference` 时必填，否则拒绝；行为信号/推断直写偏好被服务层拦截，必须先走收件箱提案
- 收件箱 accept 路径传 `preference_confirmation="proposal"`（`review_memory_proposal`）；手动明确陈述路径传 `direct`
- `ops.py` Operation 参数与 `AddProfileEvidenceInput` 同步扩展

### Slice 4 前端展示（档案页「职业模型」tab）
- 新增 `backend/app/routes/memory.py`：`GET /api/memory/{inbox,ledger,career-model}`、`POST /api/memory/proposals`、`POST /api/memory/proposals/{id}/review`（surface=memory_api，挂 `/api/memory`）
- 前端 `lib/api.ts` 新增 `memoryApi`；档案页新增「职业模型」tab（`CareerLedgerPanel.tsx`），四个区块：当前职业模型（tier 分组）、失效条目审计（revoked/invalidated/superseded 徽标与取代者）、记忆收件箱待审核（接受/拒绝/稍后，取代关系提示）、变更账本（状态徽标、取代链、已接受条目的撤销按钮）
- 浏览器验收：面板完整渲染；点击「接受」端到端生效（proposal → accepted，落地条目 → active）；`tsc --noEmit` 无新增类型错误

### BYOK 与技能增强（2026-08-06，参考 omp 机制）
- **env:VAR_NAME 引用**：`llm_config_store.resolve_api_key` 支持 `env:VAR_NAME` 运行期解析（config.json 不落明文 key）；`_sanitize_api_key`（两处）放行 env 引用；`probe_llm_endpoint` 与 `llm.py resolve_llm_client_config` 统一解析；`_mask_key` 对 env 引用原样显示；前端密钥输入框提示 `sk-... 或 env:MY_API_KEY`
- **disabledProviders（omp 模式）**：`disabled_llm_providers` 全链路（Settings → config.json 同步 → ConfigUpdate → 响应）；`llm.py` resolve 时禁用 provider 报错不可选；`import_provider` 拒绝导入禁用 provider；前端配置表格新增「禁用」列（勾选保存即生效）
- **本地引擎自动发现**：`llm_config_store.discover_local_llms()` 探测 ollama(11434)/lm-studio(1234)/vllm(8000)/llama.cpp(8080)，发现且未配置时自动追加 keyless 配置（不抢激活）；后端启动时执行一次，失败静默
- **技能目录扫描（omp 模式）**：新增 `backend/skills/<name>/SKILL.md` 发现（`directory_skills.py`，非递归一层、frontmatter name/description/tools/aliases/featured/order、description 必填）；`agent_skill_registry` catalog/resolve/select 合并目录技能（内置优先，同名忽略）；`registry_snapshot` 对目录技能宽容过滤未注册工具（内置技能仍严格校验）；未声明 tools 默认只读工具集；示例技能 `backend/skills/jd-summary/`
- 验证：新增 `tests/test_byok_directory_skills.py`（12 个测试），全量 160/160 通过；真实链路冒烟：目录技能出现在 skills API（35 个，alias `/jd` 可解析）、禁用保存→resolve 报错→恢复、env 引用 probe 正确解析、前端设置页禁用列与 env 提示渲染

### LLM 实测（2026-08-06，用户提供本地代理 key）
- 配置：`deepseek` provider 指向 `http://127.0.0.1:8317/v1`，模型 `deepseek-v4-flash-free`，api_key 用 `env:OFFERU_LLM_KEY` 引用（key 在 backend/.env，不落 config.json 明文）
- 实测发现并修复 2 个 bug：
  1. **env: 引用读不到 .env**：pydantic-settings 只把 .env 填进模型字段、不写 os.environ，`resolve_api_key` 解析为空 → 增加 .env 文件回退读取（进程环境 > .env 文件，与 omp 优先级一致）
  2. **import_provider 更新配置时 preset tier 映射覆盖显式模型**：tier 解析命中不存在的 `deepseek-v4-flash`（代理只有 -free 系列）→ 更新已有配置时未显式传 models 则清空，让 tier 解析回退到显式 model
- LLM 功能闭环全部打通：
  - test-llm 连接 ✓（服务器进程内 env 引用生效）
  - `chat_completion` 直接调用 ✓
  - **AI 面试**：创建面试（LLM 生成行为面试题）✓；回答提交评分（内容分 76.5"基本有效"，维度证据引用完整）✓
  - **记忆 distiller**：对话文本 → LLM 提炼 3 候选 → 收件箱 2 提案 ✓（1 条因 LLM 输出的 section_type 非法被边界校验拦截，符合预期）
  - **主 Agent run**：Pi worker 全管线，21 个事件，final_result 完整回复 ✓
  - 数据授权门、事实门在真实 LLM 路径下正常拦截/放行
- 测试残留：AI 面试 #1、观察 #219、提案 #175 等为本次实测数据（测试数据污染为既有问题，未清理）
- 全量回归 161/161 通过；技能投影 4 文件已重新生成（含目录技能）

### PDF 简历识别实测（2026-08-06，真实简历）
- 样本：`李凯风简历AI.pdf`（1 页）/ `李凯风简历两页.pdf`（2 页），PyMuPDF native 提取
- 解析层：质量评分 0.962 / 0.960，中文/电话/邮箱/网站完整无乱码，无需 OCR 降级
- AI 结构化导入（`/api/profile/import-resume?parse_mode=ai`）：base_info 完整（姓名/邮箱/电话/总结）；发现并修复 **skill 碎片化**：免费模型忽略「技能段落一条」约束、按视觉行拆出 8 条 skill → 新增 `_merge_skill_candidates` 确定性合并（items 汇总去重、原文保留），12 条碎片 → 5 条可确认条目
- 剩余边界（模型遵循度，确认环节人工修正）：部分项目被误标为 skill、education 重复条目
- 新增 `tests/test_resume_skill_merge.py`（3 个测试），全量 164/164 通过

### 本地执行器兼容增强 + PI/OMP（2026-08-06）
- 实测 pi CLI 0.74.0 与 omp CLI 17.2.9 均支持 `--print --mode json --no-session` 非交互 JSONL 事件流（同血统协议），新增 `RUNTIME_DEFINITIONS` 的 `pi` / `omp` 两项：
  - `_runtime_args`：`--print --mode json --no-session`（omp 额外 `--no-pty --no-lsp` 加速），prompt 经 stdin
  - `_extract_worker_text`：从 message_end/turn_end 的 `message.content` 提取 text 块（跳过 thinking）
  - probe 通过：`available=True compatible=True protocol=pi-jsonl-events-v1`
- 端到端验证：omp 委托任务成功（8.9s，16 事件，结构化 `{"reply":"OK"}` 解析正确）；pi 因账号余额不足（401 Insufficient balance）运行失败且如实报错——协议正常，补余额即可用
- `coding_agent_priority` 默认值更新为 `claude,codex,omp,gemini,pi`
- 新增 `tests/test_pi_omp_adapter.py`（4 个测试），全量 168/168 通过
- 注意：omp 委托使用用户 omp 的默认模型（当前 opencode-go/deepseek-v4-flash）；`--no-session` 保证不污染主会话
- **opencode 适配补充**：opencode 1.17.11 支持 `run --format json` 非交互 JSONL 事件流（message/part 事件带文本，error 事件暴露真实原因——opencode 错误也返回 exit 0，必须从事件流识别）。`RUNTIME_DEFINITIONS` 由 `supported: False` 改为支持 + `_runtime_args`（`run --format json --pure`）+ `_extract_worker_text` 解析；实测事件流格式确认（余额不足 401 如实上报）。新增 4 个 opencode 单测，全量 172/172；`list_local_executors` 显示 opencode compatible=True

### Eval 发现缺陷修复（2026-08-06，EvalRunner + 主 Agent 补完）
- **事实门回声绕过（E3，🔴）**：`validate_generated_content` 增加自回声检测（source 去掉声明后无剩余内容 = 回声）；`add_profile_evidence` 增加 `user_confirmed` 参数——未确认的回声直写（主 Agent 把用户陈述回声当来源）被拒，收件箱 accept（用户确认）放行
- **调研 run 无启动恢复（E2-A，🟠）**：新增 `recover_interrupted_research_runs()`，lifespan 启动时把 pending/running 调研 run 标记 interrupted（与 agent_runs 对称），可显式 resume 复用 run_id/dossiers
- **dry-run 短路过业务校验（E1-A/E4-A，🟠）**：业务枚举下沉到 input model（校验先于 dry_run 返回）——`CreateMemoryProposalInput.section_type` 支持完整枚举（含 `custom:` 前缀），新增 `SaveCareerArtifactInput`（artifact_type 13 个合法值枚举）
- 新增 `tests/test_eval_fixes.py`（7 个测试），全量 179/179 通过；端到端验证：无确认回声直写被拦、收件箱确认放行
- 报告：`docs/plans/2026-08-06-eval-report.md`

### 全功能测试（2026-08-06，真实 LLM + codex）
| 功能 | 结果 | 说明 |
|---|---|---|
| 岗位采集/分诊 | ✅ | import_jd #88（AIGC 产品经理）→ triage picked → 列表确认 |
| 岗位研究 | ⚠️ 外部限制 | 管线端到端工作：主 Agent → HITL 确认 → codex worker 真实运行 135s → **Codex 用量限制**（usageLimitExceeded，8/8 恢复），错误如实上报不再静默 |
| 投前决策 | 🔒 设计阻塞 | 依赖 completed 调研（证据门），调研被外部额度挡住 → stage=research_failed，符合设计 |
| 求职信 | ✅ | LLM 基于岗位+简历生成完整求职信 |
| 简历 PDF 导出 | ✅ | 22.9KB 有效 ATS PDF（%PDF magic + sha256） |
| 记忆收件箱端到端 | ✅ | 提案 #232 accept → section active → career model 3 条 → ledger 记录完整 |
| 投递管理 | ✅ | create application record → 状态「已投递」→ progress overview 24 条（注意：workspace record 与旧 Application 表并存，更新走 `update_application_record` 中文状态值） |
| 前端页面 | ✅ | 今日/岗位(87)/简历(22)/投递(1)/面试题库/AI 面试工作室/档案/设置 8 页全部渲染 |
| AI 面试 | ✅ | 列表显示测试面试 #1 active（此前已验证创建+评分） |- 前端 dev 3300 → **7410**（Vite + tauri devUrl + HMR 7411），后端 8000 → **8765**（uvicorn + OFFERU_PORT + 全部前端 API_BASE + e2e 脚本）
- 原因：3300/8000 为常见端口；且 winnat 动态排除段漂移（曾现 4229-4328，4321 落入导致 EACCES）
- 同步 24 个文件：`frontend/package.json`、`vite.config.ts`、`tauri.conf.json`、`lib.rs`、9 个前端源码文件、`backend/config.py`、`main.py`、`routes/email.py`、`routes/resume.py`、`run_server.py`、`.env`、`.env.example`、8 个 e2e 脚本、`AGENTS.md`、README/README_EN、ADR-0047、deepseek-runbook
- 踩坑沉淀（已入 AGENTS.md）：① Windows 系统环境变量 `CORS_ORIGINS` 优先级高于 `.env`（本机旧值仅 5140/3000，导致前端被 CORS 拦）；② winnat 排除段会漂移，改端口前必须查 `netsh interface ipv4 show excludedportrange protocol=tcp`
- 代码级防御：`main.py` CORS 列表无条件合并 `http://localhost:7410` / `http://127.0.0.1:7410`，不再受环境变量旧值影响

### 最终验收（2026-08-06，非正式 Eval）
- 服务：后端 8765 health ok / CORS ACAO=7410 ✓；前端 7410 加载 ✓
- Registry：CLI doctor ok，121 个 Operation；ADR-0048 三个新 Operation 已注册，create_memory_proposal 含 supersedes_proposal_id
- 数据库：`offeru.db` 5 个新列就位（`_auto_migrate`）
- 真实库冒烟：`derive_career_model`（2 有效 + 1 失效）、`list_career_ledger`、`build_job_projection`（job 34 正确选出 backend 相关条目 relevance=4）、review/revoke 端到端（proposal+section 状态一致）
- 前端：今日页渲染 ✓；档案页「职业模型」tab 四区块渲染 ✓；「接受」与「撤销该条目」按钮端到端落库 ✓
- 测试：backend 148/148（`.venv` Python 3.12）
- 限制：LLM 功能（AI 面试/简历生成/研究）未验证——需要有效 API Key；正式内测请按 `docs/evals/deepseek-runbook.md` 跑 `offeru-core-v1` suite

### 验证
- `backend` 全量 148 个测试通过（venv = `.venv`，Python 3.12）；`test_career_memory.py` 新增 5 个账本/投影契约测试 + 3 个偏好门测试；`test_career_memory.py` 与 `test_work_source_memory.py` 的旧「删除」断言更新为新审计语义
- 真实服务验收（uvicorn :8765）：启动时 `_auto_migrate` 对现有 `offeru.db` 成功补 5 个新列；`cli ops` 121 个 Operation（含 3 个新增）；`derive_career_model` / `list_career_ledger` / `build_job_projection`（job 34 正确选出 backend 相关条目 relevance=4）端到端可用；无 confirmation 的 `tier=preference` 写入经 confirm 执行被门拦截（错误信息完整）

## 风险与开放问题

- ~~`revoke` 语义变更影响现有测试~~ 已同步更新测试
- ~~`derive_career_model` 与 `get_profile`/`list_profile_evidence` 关系~~ `get_profile`/`list_profile_evidence` 已过滤失效条目，语义对齐派生视图
- ~~投影相关性规则~~ 采用确定性 token 共现（不引入 LLM 推断污染）
- ~~ADR-0011 注记~~ 已补充
- 开放：Slice 4 前端展示取代链与撤销审计；`revoke`/`supersede` 语义在前端收件箱的呈现
