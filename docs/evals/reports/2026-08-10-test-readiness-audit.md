# OfferU 测试与 Eval 就绪度审计

> 日期：2026-08-10  
> 性质：只读证据审计，不是 `offeru-core-v1` 正式 baseline  
> 本轮未执行：pytest、前端/扩展构建、浏览器旅程、真实 provider Eval、DeepSeek 测试

## 结论

OfferU 已经具备较多领域能力、Operation、后端测试和部分浏览器扩展测试，但当前仍只能表述为：**内部 Alpha；核心能力、Agent 完整性和长期职业模型学习循环尚未被正式 Eval 证明**。

阻止当前版本进入正式 baseline 的首要问题不是模型效果，而是测试基础设施：后端数据库引擎在模块导入时绑定配置，大量测试直接调用 `init_db()` 和 `async_session`；当前没有统一 fixture 证明测试进程使用一次性数据库。直接在 `backend` 目录运行默认 pytest 可能写入 `backend/djm.db`，因此本轮没有为了得到通过数字而执行它。

| 评估面 | 当前判定 | 证据结论 |
|---|---|---|
| 正式 Eval baseline | `NOT_RUN` | 没有满足 24 Task、trajectory、outcome、命令、退出码和机器 schema 的报告 |
| 自动化测试安全性 | `BLOCKED` | 可写后端测试缺少统一、可证明的一次性数据库隔离 |
| Agent Operation 完整性 | 未证明，已有确定性缺口 | 实时 manifest 的 122 个 Operation 中，65 个有 typed input schema，57 个为 `null` |
| 核心岗位推进闭环 | 未证明 | 没有隔离的 GUI/Agent 端到端报告；前端没有自动化测试文件 |
| 职业模型账本与审核门 | 部分实现 | 后端测试覆盖提案、撤销、取代、来源失效和岗位投影，但没有证明主 Agent 实际召回和使用 |
| 长期复盘与策略进化 | 未形成闭环 | 没有“结果 -> 复盘 -> 策略提案 -> 用户审核 -> 下一次行为改变”的产品级测试 |
| 浏览器岗位采集/填表 | 部分实现、契约仍漂移 | 有 Vitest/fixture 资产，但缺真实浏览器到后端隔离库的正式 Eval；旧浏览器脚本仍断言填写身份证号 |
| 有效推进效率 | 未观测 | 当前只定义了指标，没有记录使用者主动时间、人工步骤、返工和产物采纳结果 |

## 1. 本轮可复现的只读证据

### 1.1 控制面

在 `backend` 使用项目 Python 3.12 环境执行只读探测：

```powershell
.\.venv312\Scripts\python.exe -m app.cli doctor --pretty
.\.venv312\Scripts\python.exe -m app.cli manifest
.\.venv312\Scripts\python.exe -m app.cli run agent_playbook --arg detail=full
```

审计时观察到：

- CLI `0.4.0`，Operation 数为 `122`；当前 provider/model 为 `deepseek/deepseek-v4-flash-free`。
- `dry_run_for_mutations=true`、`auto_submit_applications=false`。
- OCR 未配置，缺少 `chi_sim` 与 `eng`；这不阻止只读控制面，但会阻止声称扫描简历导入完整可用。
- 122 个 Operation 中 65 个带 typed input schema，57 个 `input_schema=null`。因此 `CORE-REG-001` 的“缺失 schema 数为 0”断言在当前状态下不成立；`CORE-AGT-001` 也不能在没有进一步机器比较时判定通过。
- Operation group 同时存在 `job` 与 `jobs`，说明目录命名仍有漂移，应在 schema 补全时一并核对，但它本身不是发布阻断证据。

这些数量是 2026-08-10 工作区快照，只用于本审计，不能复制为长期 README 承诺。

### 1.2 自动化测试资产

只统计文件和测试定义，不执行：

| 资产 | 当前数量 | 能证明什么 | 不能证明什么 |
|---|---:|---|---|
| `backend/tests/test_*.py` | 20 个文件 / 185 个 test 定义 | 大量服务与领域机制有回归意图 | 真实 UI、provider、Agent 轨迹和隔离后的全链路可用性 |
| `backend/scripts/e2e/test_*.py` | 18 个文件 | 历史脚本与部分契约检查 | 统一、受控、可复现的 E2E suite |
| `frontend/**/*.(test|spec).*` | 0 | 无 | 工作台、Context Rail、Memory Inbox、错误可见性和用户闭环 |
| Extension Vitest | 24 个文件，其中 17 tracked、7 untracked | DOM 规则、Smart Fill、规则包和 HTTP adapter 的局部行为 | 已安装扩展、真实页面、真实后端、真实数据库 outcome |
| Extension Playwright fixture | 1 个孤立脚本 | 可以启动侧载扩展和本地 fixture 页 | 未接入 `npm test`；使用 stub 后端；不构成正式浏览器 Eval |

### 1.3 后端测试隔离阻断

`backend/app/database.py` 在导入时读取 `settings.database_url` 并立即创建全局 engine；默认值为 `sqlite+aiosqlite:///./djm.db`。多个测试文件在导入 `app.database` 前先 `os.chdir(BACKEND_DIR)`，随后直接执行 `init_db()`、`async_session()` 和真实写 Operation。

新增的 `backend/tests/test_job_ingest.py` 也会创建 Job、Batch 和 OperationAuditLog。它使用随机盐避免键冲突，但随机键不是隔离或清理；测试结束后数据仍会留在所连接数据库中。

因此，以下条件满足前，整套后端 pytest 应判为 `BLOCKED` 而不是直接运行：

1. 在 Python 进程导入 `app.database` **之前**把 `DATABASE_URL` 指向一次性数据库；
2. 记录该数据库运行前不存在或拥有已知 fixture 摘要；
3. 证明 backend、CLI、API 和 GUI 全部连接同一隔离实例；
4. 运行后核对用户数据库摘要未变化，并可安全丢弃临时实例。

## 2. 现有报告为什么不是 baseline

`2026-08-06-eval-report.md` 对 E1-E5 的历史失败发现仍有价值，但它不是 `offeru-core-v1` 报告：

- 没有覆盖固定的 24 个 `CORE-*` Tasks；
- 没有逐 trial 的完整命令、退出码和耗时；
- 没有完整 trajectory/outcome artifact 引用；
- 没有符合 `report-schema.json` 的 `eval-summary`；
- E1-E5 的“通过”与当前 20 required / 3 integration / 1 diagnostic 验收规则不能互换。

因此它应被视为 **ad-hoc capability discovery**，用于提取回归任务，不能用来宣称 Agent 或系统已经通过正式验收。

## 3. E1-E5 修复证据的当前强度

| 历史问题 | 当前代码/测试证据 | 审计判断 |
|---|---|---|
| E1/E4 非法枚举在 dry-run 后才失败 | `test_eval_fixes.py` 对 `CreateMemoryProposalInput` 与 `SaveCareerArtifactInput` 做 Pydantic 枚举测试 | 已覆盖两个已知参数错误；不能证明所有 Operation 的业务校验都在 proposal 前完成。`execute_operation` 仍在输入模型校验后、Operation 函数执行前直接返回 dry-run |
| E2 调研 run 重启后成为孤儿 | 已有 `recover_interrupted_research_runs()`，startup 会调用 | 有实现，但未找到针对该恢复函数的回归测试；startup 捕获全部异常并静默继续，失败可能不可见 |
| E3 用户陈述回声绕过事实门 | `test_eval_fixes.py` 直接测试 `validate_generated_content` 的 echo heuristic | 有单元级防线；尚未复现“主 Agent -> proposal/confirm -> Profile outcome”的原始完整路径，不能宣布全链路已修复 |
| E4 取代链 | `test_career_memory.py` 覆盖 supersede、派生当前模型和账本 | 领域机制覆盖较强，但测试仍受数据库隔离问题影响 |
| E5 确认点跨重启 | `test_pi_agent_host.py` 覆盖 Agent Run 恢复与幂等状态 | 有后端回归意图；仍需隔离后的真实 Agent/进程重启 Eval 才能证明产品行为 |

## 4. 当前最重要的产品与测试缺口

### P0：统一数据库测试隔离

这是所有可写测试和 GUI Eval 的前置条件。没有它，测试结果既不安全，也不能独立复现。下一实现切片应只建立测试数据库注入与运行前后保护，不顺带修改业务行为。

### P0：Operation Registry 仍有绕行写路径

`backend/app/routes/jobs.py` 的 `/batch-delete` 和 `/batch-triage` 仍直接执行 ORM mutation 与 commit，而 `/batch-update`、单岗位更新和 `/ingest` 已通过 `execute_operation`。这与“所有业务 mutation 经过 Registry”的 `CORE-REG-003` 断言冲突，应在进入可写 baseline 前收敛。

浏览器 `/api/jobs/ingest` 虽然最终调用 `import_job_batch` 并写审计，但 `browser_extension_ui` 不属于持久化 Agent Run 授权保护面；当前扩展的一次“同步”点击会在后台连续执行 `prepareJobImport()` 和 `confirmJobImport()`。这不是可展示、可复核的两阶段计划证据，至少需要独立的契约测试明确 UI 点击究竟代表“生成计划”还是“确认执行”。

### P0：长期职业模型没有进入主 Agent 的稳定上下文

后端已经有提案审核、来源失效、条目取代、当前模型派生和岗位投影，但 `pi_agent_host.py` 当前只拼接最近 12 条对话；system prompt 没有注入职业模型摘要或岗位职业投影，Guardian 也以 `memory=None` 运行。

这意味着 OfferU 目前拥有“可存储的职业记忆机制”，但尚未证明“Agent 会在正确任务、正确时机召回正确条目”。机械存储测试不能替代长期记忆产品测试。

### P1：缺少独立的 Learning Loop Eval

现有 24 Task core suite 没有覆盖以下已确认产品承诺：

- 条目级职业模型变更账本与逐项撤销；
- 显式偏好直写、推断偏好进入记忆收件箱；
- 来源级联失效后立即退出检索、提示词和岗位投影；
- 单一长期职业模型与岗位职业投影不互相污染；
- 跨会话启动摘要和任务相关召回；
- 投递/面试/材料结果形成学习观察；
- 复盘形成策略提案，经使用者审核后改变下一次行为；
- 上游职业事实变化使受影响材料进入可解释的过期状态。

建议保留 `offeru-core-v1` 作为控制面与岗位推进闭环套件，另建 `offeru-learning-loop-v1`。正式成熟度门应同时要求 core 与 learning-loop 通过，避免把一套任务无限膨胀，也避免长期记忆被 24 Task 的绿色结果掩盖。

### P1：浏览器测试合同发生漂移

当前 tracked 的 `critical-plan.test.ts` 已断言保护已有值和身份证字段；但孤立的 `smartfill-browser-fixture.mjs` 仍要求自动填入身份证号，并把该结果视为“passed”。这与最新职业事实和表单安全边界冲突，而且该脚本没有接入 package test 命令。

应删除或重写这类过时断言，并建立三层证据：规则/DOM 单元测试、真实侧载扩展 fixture 测试、扩展 -> API -> Registry -> 隔离数据库 outcome 测试。只有第三层可以证明岗位采集与同步闭环。

### P1：没有衡量“有效推进效率”

当前 Eval 只记录模型/Operation 延迟和 `pass@1` / `pass^3`，没有证明 OfferU 是否大幅缩短求职优化流程。至少需要记录：

- 从岗位导入到材料与投递待办获批的使用者主动时间；
- 使用者必须完成的人工步骤和确认次数；
- 因错误事实、错误路由或低质量产物造成的返工次数；
- 提案一次采纳率，以及最终可采用材料比例。

这些指标必须以事件和可审计状态计算，不能让 Agent 主观估分。

## 5. 推荐的测试决策顺序

1. 先完成一次性数据库测试 harness，并证明默认用户数据库在测试前后不变。
2. 用只读机器检查固化 57 个缺失 schema 与 Registry 绕行 mutation，逐项修复后再开放写测试。
3. 把 E1-E5 的原始端到端路径转成隔离 regression tasks，而不只保留直接函数单测。
4. 运行 `offeru-core-v1` 正式 baseline；报告不满足 schema 时统一判 `INVALID`。
5. 新建并运行 `offeru-learning-loop-v1`，证明 Profile 不是只会存，而是会安全地影响后续任务。
6. 浏览器 suite 单独证明真实侧载扩展、用户确认、Registry 审计和隔离 outcome。
7. 最后才比较 DeepSeek 模型、prompt 或 Agent 路由优化对成功率、主动时间和返工的影响。

## 6. 方法校准

本审计继续采用 Task、Trial、Trajectory、Outcome 与 Grader 分离的结构，并要求同时阅读轨迹与最终状态。这与 [Anthropic 的 Agent Eval 方法](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)一致。OpenAI 官方文档也把 Eval 描述为“先定义任务和 grader，再运行输入并分析结果”的迭代过程；其托管 Evals 平台已公告 2026-10-31 只读、2026-11-30 关闭，因此 OfferU 继续使用本地、可移植的 suite/report 是合理方向：[OpenAI Working with evals](https://developers.openai.com/api/docs/guides/evals)。

这两项方法来源只能支持 Eval 结构，不能替代 OfferU 自己的真实 baseline。
